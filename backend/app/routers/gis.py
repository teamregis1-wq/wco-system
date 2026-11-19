"""GIS endpoints — KDE density mapping + Getis-Ord Gi* hotspot analysis.

Academic references
-------------------
Getis, A., & Ord, J. K. (1992). The Analysis of Spatial Association by Use of
  Distance Statistics. Geographical Analysis, 24(3), 189–206.
Silverman, B. W. (1986). Density Estimation for Statistics and Data Analysis.
  Chapman & Hall.

Ord, J. K., & Getis, A. (1995). Local Spatial Autocorrelation Statistics:
  Distributional Issues and an Application. Geographical Analysis, 27(4), 286–306.
Benjamini, Y., & Hochberg, Y. (1995). Controlling the False Discovery Rate.
  JRSS B, 57(1), 289–300.

Implementation notes
--------------------
Input variable x_i     : mean weekly WCO (liters/week) of each ACTIVE establishment.
Spatial weights        : binary fixed-distance band (default 1,500 m) measured on a
                         local equirectangular projection (metres), INCLUDING the
                         location itself (w_ii = 1) — that inclusion is what makes
                         the statistic Gi* rather than Gi.
Gi* formula            : Ord & Getis (1995) z-score form with binary weights
                         (not row-standardised).
p-values               : two-sided, normal approximation; also reported with a
                         Benjamini–Hochberg FDR adjustment because ~n tests are run
                         at once. Categories use the unadjusted z for continuity.
KDE                    : scipy.stats.gaussian_kde in projected metres, weighted by
                         mean weekly WCO, Scott's rule. Output is RELATIVE density
                         (normalised to [0, 1]), not liters per km².
Grid orientation       : row 0 = lat_max (northernmost) so it matches image-overlay
                         convention (top-left = northwest).
"""
from __future__ import annotations

import numpy as np
from functools import lru_cache
from scipy import stats as sp_stats
from scipy.spatial import distance_matrix as scipy_dist

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.cache import cache_get, cache_set
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord

router = APIRouter(prefix="/gis", tags=["gis"])

# ── Constants ──────────────────────────────────────────────────────────────────

# Local equirectangular projection: metres per degree at the study latitude.
_M_PER_DEG_LAT = 110_574.0
_M_PER_DEG_LNG_EQUATOR = 111_320.0

# Spatial-weight distance band in metres.
_WEIGHT_BAND_M = 1_500.0

# Gi* significance thresholds (two-tailed z-scores).
_Z_HIGH = 2.576   # p < 0.01
_Z_MED  = 1.960   # p < 0.05


# ── Spatial statistics helpers ─────────────────────────────────────────────────

def _project_m(lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Project lat/lng to local metres (equirectangular about the mean latitude).

    Distortion is negligible over a city-sized study area (< 0.1 % at ~10 km).
    """
    lat0 = float(np.mean(lats)) if len(lats) else 13.76
    x = lons * _M_PER_DEG_LNG_EQUATOR * np.cos(np.radians(lat0))
    y = lats * _M_PER_DEG_LAT
    return x, y


def _weight_matrix(lats: np.ndarray, lons: np.ndarray, band_m: float) -> np.ndarray:
    """Binary Gi* weights: 1 if distance ≤ band_m (metres), INCLUDING i itself."""
    x, y = _project_m(lats, lons)
    coords = np.column_stack([x, y])
    D = scipy_dist(coords, coords)
    W = (D <= band_m).astype(float)
    np.fill_diagonal(W, 1.0)   # Gi* includes the focal location (w_ii = 1)
    return W


def _bh_fdr(p: np.ndarray) -> np.ndarray:
    """Benjamini–Hochberg adjusted p-values (monotone, capped at 1)."""
    p = np.asarray(p, dtype=float)
    n = p.size
    if n == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * n / np.arange(1, n + 1)
    adj = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(adj, 0.0, 1.0)
    return out


def _resolve_band_m(band: float | None, band_m: float) -> float:
    # `band` (degrees) is the legacy query parameter; convert if supplied.
    return float(band) * _M_PER_DEG_LAT if band is not None else float(band_m)


def _getis_ord_gi_star(values: np.ndarray, W: np.ndarray) -> np.ndarray:
    """Compute Getis-Ord Gi* z-scores.

    Gi* = (Σ_j w_ij x_j  −  x̄ Σ_j w_ij)
          ─────────────────────────────────────────────────────────
          s √( (n Σ_j w_ij²  −  (Σ_j w_ij)²) / (n − 1) )

    where s = population standard deviation of x and all sums run over
    j = 1..n INCLUDING j = i (W must have w_ii = 1 for Gi*).

    Returns
    -------
    ndarray of z-scores, one per location.
    Positive high values → statistically significant hotspot cluster.
    Negative low values → coldspot cluster.
    """
    n = len(values)
    x_bar = float(np.mean(values))
    s = float(np.std(values, ddof=0))

    if s == 0.0:
        return np.zeros(n)

    Wx        = W @ values                    # Σ w_ij x_j
    sum_w     = W.sum(axis=1)                 # Σ w_ij
    sum_w2    = (W ** 2).sum(axis=1)          # Σ w_ij²

    numerator  = Wx - x_bar * sum_w
    inner      = (n * sum_w2 - sum_w ** 2) / max(n - 1, 1)
    denominator = s * np.sqrt(np.clip(inner, 0.0, None))

    return np.divide(numerator, denominator, out=np.zeros(n), where=denominator > 0.0)


def _categorize(z: float) -> str:
    if z >= _Z_HIGH:
        return "high"
    if z >= _Z_MED:
        return "medium"
    if z <= -_Z_MED:
        return "coldspot"
    return "low"


def _kde_grid(
    lats: np.ndarray,
    lons: np.ndarray,
    weights: np.ndarray,
    lat_min: float,
    lat_max: float,
    lng_min: float,
    lng_max: float,
    steps: int = 60,
) -> tuple[np.ndarray, float]:
    """Volume-weighted Gaussian KDE evaluated on a regular grid.

    Coordinates are projected to metres before fitting so that Scott's
    bandwidth rule operates in meaningful units.

    Returns
    -------
    (grid, bandwidth_m)
        grid shape (steps, steps): row 0 = lat_max (north), col 0 = lng_min (west)
        bandwidth_m: mean kernel standard deviation actually used (metres)
    """
    empty = (np.zeros((steps, steps)), 0.0)
    w = np.asarray(weights, dtype=float)
    if len(lats) < 3 or not np.all(np.isfinite(w)) or w.sum() <= 0:
        return empty

    lat0 = float(np.mean(lats))
    kx = _M_PER_DEG_LNG_EQUATOR * np.cos(np.radians(lat0))
    x_m, y_m = lons * kx, lats * _M_PER_DEG_LAT

    try:
        kde = sp_stats.gaussian_kde(np.vstack([x_m, y_m]), weights=w / w.sum())
    except (np.linalg.LinAlgError, ValueError):
        # e.g. all points collinear/identical → singular covariance
        return empty

    lat_vals = np.linspace(lat_max, lat_min, steps)   # row 0 = north
    lng_vals = np.linspace(lng_min, lng_max, steps)
    lng_mesh, lat_mesh = np.meshgrid(lng_vals * kx, lat_vals * _M_PER_DEG_LAT)
    z = kde(np.vstack([lng_mesh.ravel(), lat_mesh.ravel()])).reshape(steps, steps)
    bandwidth_m = float(np.mean(np.sqrt(np.diag(kde.covariance))))
    return z, bandwidth_m


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/establishments")
def gis_establishments(
    refresh: bool = Query(False, description="Bypass the server cache"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """All active establishments as GeoJSON-friendly points."""
    if not refresh and (cached := cache_get("gis:establishments")) is not None:
        return cached
    rows = db.scalars(
        select(Establishment).where(Establishment.is_active.is_(True))
    ).all()
    result = [
        {
            "id": e.id,
            "name": e.name,
            "type": e.type,
            "latitude": e.latitude,
            "longitude": e.longitude,
            "barangay": e.barangay,
            "wco_code": e.wco_code,
        }
        for e in rows
    ]
    cache_set("gis:establishments", result)
    return result


@router.get("/hotspots")
def gis_hotspots(
    band_m: float = Query(_WEIGHT_BAND_M, gt=0, le=20_000,
                          description="Spatial-weight distance band in metres"),
    band: float | None = Query(None, gt=0, le=0.2, deprecated=True,
                               description="Legacy: distance band in degrees (overrides band_m)"),
    refresh: bool = Query(False, description="Bypass the server cache"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """Getis-Ord Gi* hotspot scores per establishment.

    Each active establishment is scored by Gi*: the sum of mean weekly WCO
    within *band_m* metres (itself included) compared with what would be
    expected if volumes were spatially random.

    Response fields
    ---------------
    gi_star_z   : Gi* z-score  (≥ 1.96 → hot spot at p < 0.05, unadjusted)
    p_value     : two-tailed p approximated from the standard normal CDF
    p_value_fdr : Benjamini–Hochberg adjusted p-value (multiple-testing aware)
    category    : "high" (p<0.01 hot) | "medium" (p<0.05 hot) |
                  "low" (not significant) | "coldspot" (p<0.05 cold)
    avg_liters  : mean weekly WCO generation (the input variable x_i)
    neighbor_count : number of establishments within the weight band
    """
    band_m = _resolve_band_m(band, band_m)
    if not refresh and (cached := cache_get(f"gis:hotspots:{band_m}")) is not None:
        return cached
    avg_subq = (
        select(
            WCOGenerationRecord.establishment_id,
            func.avg(WCOGenerationRecord.quantity_liters).label("avg_liters"),
            func.count(WCOGenerationRecord.id).label("record_count"),
        )
        .group_by(WCOGenerationRecord.establishment_id)
        .subquery()
    )

    rows = db.execute(
        select(
            Establishment.id,
            Establishment.name,
            Establishment.latitude,
            Establishment.longitude,
            Establishment.barangay,
            Establishment.type,
            avg_subq.c.avg_liters,
            avg_subq.c.record_count,
        ).join(avg_subq, Establishment.id == avg_subq.c.establishment_id)
        .where(Establishment.is_active.is_(True))
    ).all()

    if not rows:
        return []

    lats    = np.array([r.latitude   for r in rows])
    lons    = np.array([r.longitude  for r in rows])
    volumes = np.array([r.avg_liters for r in rows])

    W      = _weight_matrix(lats, lons, band_m)
    z_arr  = _getis_ord_gi_star(volumes, W)

    # Two-tailed p-value from standard normal.
    from scipy.special import ndtr  # CDF of N(0,1)
    p_arr = 2.0 * (1.0 - ndtr(np.abs(z_arr)))
    p_fdr = _bh_fdr(p_arr)

    # Neighbours within the band, excluding the establishment itself.
    neighbor_counts = (W.sum(axis=1) - 1).astype(int)

    out = []
    for i, r in enumerate(rows):
        z = float(z_arr[i])
        out.append(
            {
                "establishment_id": r.id,
                "name": r.name,
                "latitude": r.latitude,
                "longitude": r.longitude,
                "barangay": r.barangay,
                "type": r.type,
                "gi_star_z": round(z, 4),
                "p_value": round(float(p_arr[i]), 4),
                "p_value_fdr": round(float(p_fdr[i]), 4),
                "significant_fdr": bool(p_fdr[i] < 0.05),
                "category": _categorize(z),
                "avg_liters": round(float(r.avg_liters), 2),
                "record_count": int(r.record_count),
                "neighbor_count": int(neighbor_counts[i]),
            }
        )
    cache_set(f"gis:hotspots:{band_m}", out)
    return out


@router.get("/kde")
def gis_kde(
    steps: int = Query(60, ge=20, le=100, description="Grid resolution (steps × steps)"),
    refresh: bool = Query(False, description="Bypass the server cache"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """Volume-weighted KDE density grid for the heatmap overlay.

    Response
    --------
    grid        : 2-D list[list[float]] shape (steps × steps), values normalised
                  to [0, 1]. Row 0 = northernmost latitude (matches image-overlay
                  top-left convention in Leaflet).
    lat_min/max : bounding box latitudes (add a 10% margin around data).
    lng_min/max : bounding box longitudes.
    top_hotspots: top-10 establishments by Gi* z-score (convenient for sidebar).
    bandwidth_m : mean kernel standard deviation (metres) actually used
                  (Scott's rule with the effective sample size of the weights).
    """
    if not refresh and (cached := cache_get(f"gis:kde:{steps}")) is not None:
        return cached
    avg_subq = (
        select(
            WCOGenerationRecord.establishment_id,
            func.avg(WCOGenerationRecord.quantity_liters).label("avg_liters"),
        )
        .group_by(WCOGenerationRecord.establishment_id)
        .subquery()
    )

    rows = db.execute(
        select(
            Establishment.id,
            Establishment.name,
            Establishment.latitude,
            Establishment.longitude,
            Establishment.barangay,
            Establishment.type,
            avg_subq.c.avg_liters,
        ).join(avg_subq, Establishment.id == avg_subq.c.establishment_id)
        .where(Establishment.is_active.is_(True))
    ).all()

    if not rows:
        return {
            "grid": [], "lat_min": 0, "lat_max": 0,
            "lng_min": 0, "lng_max": 0, "top_hotspots": [],
            "bandwidth_m": 0,
        }

    lats    = np.array([r.latitude   for r in rows])
    lons    = np.array([r.longitude  for r in rows])
    volumes = np.array([r.avg_liters for r in rows])

    # 10% margin around data extent.
    margin_lat = max((lats.max() - lats.min()) * 0.10, 0.005)
    margin_lng = max((lons.max() - lons.min()) * 0.10, 0.005)
    lat_min = float(lats.min() - margin_lat)
    lat_max = float(lats.max() + margin_lat)
    lng_min = float(lons.min() - margin_lng)
    lng_max = float(lons.max() + margin_lng)

    raw_grid, bandwidth_m = _kde_grid(
        lats, lons, volumes, lat_min, lat_max, lng_min, lng_max, steps)

    # Normalise to [0, 1] — relative density, not liters per km².
    vmax = raw_grid.max()
    norm_grid = (raw_grid / vmax).tolist() if vmax > 0 else raw_grid.tolist()

    # Top-10 by Gi* z-score (recompute quickly).
    W     = _weight_matrix(lats, lons, _WEIGHT_BAND_M)
    z_arr = _getis_ord_gi_star(volumes, W)
    top10_idx = np.argsort(z_arr)[::-1][:10]
    top_hotspots = [
        {
            "rank": int(rank + 1),
            "establishment_id": rows[i].id,
            "name": rows[i].name,
            "barangay": rows[i].barangay,
            "type": rows[i].type,
            "gi_star_z": round(float(z_arr[i]), 3),
            "avg_liters": round(float(volumes[i]), 1),
            "category": _categorize(float(z_arr[i])),
        }
        for rank, i in enumerate(top10_idx)
    ]

    result = {
        "grid": norm_grid,
        "lat_min": round(lat_min, 6),
        "lat_max": round(lat_max, 6),
        "lng_min": round(lng_min, 6),
        "lng_max": round(lng_max, 6),
        "steps": steps,
        "top_hotspots": top_hotspots,
        "bandwidth_m": round(bandwidth_m, 1),
        "density_units": "relative (0–1), volume-weighted",
    }
    cache_set(f"gis:kde:{steps}", result)
    return result


@router.get("/summary")
def gis_summary(
    refresh: bool = Query(False, description="Bypass the server cache"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """City-wide WCO aggregate statistics.

    Returns totals and per-type breakdowns useful for the map sidebar.
    """
    if not refresh and (cached := cache_get("gis:summary")) is not None:
        return cached
    avg_subq = (
        select(
            WCOGenerationRecord.establishment_id,
            func.avg(WCOGenerationRecord.quantity_liters).label("avg_liters"),
        )
        .group_by(WCOGenerationRecord.establishment_id)
        .subquery()
    )

    rows = db.execute(
        select(
            Establishment.id,
            Establishment.type,
            Establishment.latitude,
            Establishment.longitude,
            avg_subq.c.avg_liters,
        ).join(avg_subq, Establishment.id == avg_subq.c.establishment_id)
        .where(Establishment.is_active.is_(True))
    ).all()

    if not rows:
        return {"total_establishments": 0, "total_wco_per_week": 0.0, "by_type": [], "hotspot_counts": {}}

    lats    = np.array([r.latitude   for r in rows])
    lons    = np.array([r.longitude  for r in rows])
    volumes = np.array([r.avg_liters for r in rows])

    W     = _weight_matrix(lats, lons, _WEIGHT_BAND_M)
    z_arr = _getis_ord_gi_star(volumes, W)

    cats = [_categorize(float(z)) for z in z_arr]
    hotspot_counts = {
        "high":     cats.count("high"),
        "medium":   cats.count("medium"),
        "low":      cats.count("low"),
        "coldspot": cats.count("coldspot"),
    }

    # Per-type aggregates.
    type_data: dict[str, dict] = {}
    for r, v in zip(rows, volumes):
        td = type_data.setdefault(r.type, {"count": 0, "total": 0.0})
        td["count"] += 1
        td["total"] += float(v)

    by_type = [
        {
            "type": t,
            "count": d["count"],
            "avg_liters_per_week": round(d["total"] / d["count"], 1),
            "total_liters_per_week": round(d["total"], 1),
        }
        for t, d in sorted(type_data.items(), key=lambda x: -x[1]["total"])
    ]

    result = {
        "total_establishments": len(rows),
        "total_wco_per_week": round(float(volumes.sum()), 1),
        "mean_wco_per_establishment": round(float(volumes.mean()), 1),
        "hotspot_counts": hotspot_counts,
        "by_type": by_type,
    }
    cache_set("gis:summary", result)
    return result
