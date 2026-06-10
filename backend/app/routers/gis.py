"""GIS endpoints — KDE density mapping + Getis-Ord Gi* hotspot analysis.

Academic references
-------------------
Getis, A., & Ord, J. K. (1992). The Analysis of Spatial Association by Use of
  Distance Statistics. Geographical Analysis, 24(3), 189–206.
Silverman, B. W. (1986). Density Estimation for Statistics and Data Analysis.
  Chapman & Hall.

Implementation notes
--------------------
Spatial weight matrix  : binary contiguity, fixed-distance band of 0.015° ≈ 1.5 km.
Gi* formula            : standard Getis-Ord with row-standardised weights.
KDE                    : scipy.stats.gaussian_kde, volume-weighted, Scott's rule
                         applied in metre-projected coordinates to avoid
                         degree-unit artefacts.
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

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord

router = APIRouter(prefix="/gis", tags=["gis"])

# ── Constants ──────────────────────────────────────────────────────────────────

# At ~14°N: 1° lat ≈ 111 km, 1° lng ≈ 107 km
_M_PER_DEG_LAT = 111_000.0
_M_PER_DEG_LNG = 107_000.0

# Spatial-weight bandwidth: ~1.5 km expressed in degrees.
_WEIGHT_BAND_DEG = 0.015

# Gi* significance thresholds (two-tailed z-scores).
_Z_HIGH = 2.576   # p < 0.01
_Z_MED  = 1.960   # p < 0.05


# ── Spatial statistics helpers ─────────────────────────────────────────────────

def _weight_matrix(lats: np.ndarray, lons: np.ndarray, band: float) -> np.ndarray:
    """Binary spatial-weight matrix: 1 if Euclidean distance ≤ band, 0 otherwise.

    Uses a uniform projection in degrees — valid for the small study area
    (~8 km × 8 km) of Batangas City.
    """
    coords = np.column_stack([lats, lons])
    D = scipy_dist(coords, coords)
    W = (D <= band).astype(float)
    np.fill_diagonal(W, 0.0)   # exclude self-neighbour
    return W


def _getis_ord_gi_star(values: np.ndarray, W: np.ndarray) -> np.ndarray:
    """Compute Getis-Ord Gi* z-scores.

    Gi* = (Σ_j w_ij x_j  −  x̄ Σ_j w_ij)
          ─────────────────────────────────────────────────────────
          s √( (n Σ_j w_ij²  −  (Σ_j w_ij)²) / (n − 1) )

    where s = population standard deviation of x.

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

    return np.where(denominator > 0.0, numerator / denominator, 0.0)


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
) -> np.ndarray:
    """Volume-weighted Gaussian KDE evaluated on a regular grid.

    Coordinates are converted to metres before KDE fitting so that
    Scott's bandwidth rule operates in meaningful units.

    Returns
    -------
    ndarray shape (steps, steps):
        row 0 = lat_max (north), row N = lat_min (south)
        col 0 = lng_min (west),  col M = lng_max (east)
    """
    if len(lats) < 3:
        return np.zeros((steps, steps))

    # Project to metres for bandwidth calculation.
    x_m = lons * _M_PER_DEG_LNG
    y_m = lats * _M_PER_DEG_LAT

    w_norm = weights / weights.sum()

    kde = sp_stats.gaussian_kde(
        np.vstack([x_m, y_m]),
        weights=w_norm,
        # bw_method="scott"  — default, left implicit
    )

    # Build grid: north→south rows, west→east cols.
    lat_vals = np.linspace(lat_max, lat_min, steps)   # row 0 = north
    lng_vals = np.linspace(lng_min, lng_max, steps)

    lng_mesh, lat_mesh = np.meshgrid(
        lng_vals * _M_PER_DEG_LNG,
        lat_vals * _M_PER_DEG_LAT,
    )
    pts = np.vstack([lng_mesh.ravel(), lat_mesh.ravel()])
    z = kde(pts).reshape(steps, steps)

    return z


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/establishments")
def gis_establishments(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """All active establishments as GeoJSON-friendly points."""
    rows = db.scalars(
        select(Establishment).where(Establishment.is_active.is_(True))
    ).all()
    return [
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


@router.get("/hotspots")
def gis_hotspots(
    band: float = Query(_WEIGHT_BAND_DEG, description="Spatial-weight bandwidth in degrees"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """Getis-Ord Gi* hotspot scores per establishment.

    Each establishment is scored by the spatial autocorrelation of its
    average weekly WCO volume relative to its neighbours within *band*
    degrees (default ≈ 1.5 km).

    Response fields
    ---------------
    gi_star_z   : Gi* z-score  (unbounded; > 1.96 → significant hotspot)
    p_value     : two-tailed p approximated from the standard normal CDF
    category    : "high" | "medium" | "low" | "coldspot"
    avg_liters  : mean weekly WCO generation (the input variable x_i)
    neighbor_count : number of establishments within the weight band
    """
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
    ).all()

    if not rows:
        return []

    lats    = np.array([r.latitude   for r in rows])
    lons    = np.array([r.longitude  for r in rows])
    volumes = np.array([r.avg_liters for r in rows])

    W      = _weight_matrix(lats, lons, band)
    z_arr  = _getis_ord_gi_star(volumes, W)

    # Two-tailed p-value from standard normal.
    from scipy.special import ndtr  # CDF of N(0,1)
    p_arr = 2.0 * (1.0 - ndtr(np.abs(z_arr)))

    neighbor_counts = W.sum(axis=1).astype(int)

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
                "category": _categorize(z),
                "avg_liters": round(float(r.avg_liters), 2),
                "record_count": int(r.record_count),
                "neighbor_count": int(neighbor_counts[i]),
            }
        )
    return out


@router.get("/kde")
def gis_kde(
    steps: int = Query(60, ge=20, le=100, description="Grid resolution (steps × steps)"),
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
    bandwidth_m : Scott's bandwidth (metres) used for the kernel.
    """
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

    raw_grid = _kde_grid(lats, lons, volumes, lat_min, lat_max, lng_min, lng_max, steps)

    # Normalise to [0, 1].
    vmax = raw_grid.max()
    norm_grid = (raw_grid / vmax).tolist() if vmax > 0 else raw_grid.tolist()

    # Estimate bandwidth from Scott's rule in metres.
    n = len(lats)
    bw_x = n ** (-1.0 / 6.0) * np.std(lons * _M_PER_DEG_LNG)
    bw_y = n ** (-1.0 / 6.0) * np.std(lats * _M_PER_DEG_LAT)
    bandwidth_m = float((bw_x + bw_y) / 2.0)

    # Top-10 by Gi* z-score (recompute quickly).
    W     = _weight_matrix(lats, lons, _WEIGHT_BAND_DEG)
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

    return {
        "grid": norm_grid,
        "lat_min": round(lat_min, 6),
        "lat_max": round(lat_max, 6),
        "lng_min": round(lng_min, 6),
        "lng_max": round(lng_max, 6),
        "steps": steps,
        "top_hotspots": top_hotspots,
        "bandwidth_m": round(bandwidth_m, 1),
    }


@router.get("/summary")
def gis_summary(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    """City-wide WCO aggregate statistics.

    Returns totals and per-type breakdowns useful for the map sidebar.
    """
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
    ).all()

    if not rows:
        return {"total_establishments": 0, "total_wco_per_week": 0.0, "by_type": [], "hotspot_counts": {}}

    lats    = np.array([r.latitude   for r in rows])
    lons    = np.array([r.longitude  for r in rows])
    volumes = np.array([r.avg_liters for r in rows])

    W     = _weight_matrix(lats, lons, _WEIGHT_BAND_DEG)
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

    return {
        "total_establishments": len(rows),
        "total_wco_per_week": round(float(volumes.sum()), 1),
        "mean_wco_per_establishment": round(float(volumes.mean()), 1),
        "hotspot_counts": hotspot_counts,
        "by_type": by_type,
    }
