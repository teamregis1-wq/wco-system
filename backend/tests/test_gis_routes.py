"""GIS statistics (Gi*, FDR, KDE) and collection-route planning."""
import math
from datetime import date, timedelta

import numpy as np
import pytest

from app.models import WCOGenerationRecord
from app.routers import analysis, gis
from conftest import make_establishment

API = "/api/v1"


# ── Getis-Ord Gi* ────────────────────────────────────────────────────────────

def _gi_star_by_hand(x, W):
    """Direct transcription of Ord & Getis (1995), eq. for Gi* (sums include i)."""
    n = len(x)
    xbar = sum(x) / n
    s = math.sqrt(sum(v * v for v in x) / n - xbar ** 2)
    out = []
    for i in range(n):
        sw = sum(W[i])
        sw2 = sum(w * w for w in W[i])
        num = sum(W[i][j] * x[j] for j in range(n)) - xbar * sw
        den = s * math.sqrt((n * sw2 - sw ** 2) / (n - 1))
        out.append(num / den)
    return out


def test_weight_matrix_includes_self_and_uses_metres():
    lat0, lng0 = 13.75, 121.05
    dlat_1400m = 1400 / 110_574.0
    dlat_1600m = 1600 / 110_574.0
    lats = np.array([lat0, lat0 + dlat_1400m, lat0 - dlat_1600m])
    lons = np.array([lng0, lng0, lng0])
    W = gis._weight_matrix(lats, lons, 1500.0)
    assert np.all(np.diag(W) == 1.0)          # Gi*: w_ii = 1
    assert W[0, 1] == 1.0 and W[0, 2] == 0.0  # 1.4 km in band, 1.6 km out


def test_gi_star_matches_hand_computation():
    rng = np.random.default_rng(3)
    lats = 13.75 + rng.uniform(0, 0.03, 12)
    lons = 121.05 + rng.uniform(0, 0.03, 12)
    x = rng.uniform(10, 100, 12)
    W = gis._weight_matrix(lats, lons, 1500.0)
    z = gis._getis_ord_gi_star(x, W)
    assert np.allclose(z, _gi_star_by_hand(list(x), W.tolist()), atol=1e-9)


def test_gi_star_detects_planted_cluster():
    # 5 high-volume sites packed together, 25 low-volume sites spread out.
    rng = np.random.default_rng(0)
    cl_lat, cl_lng = 13.76 + rng.normal(0, 0.001, 5), 121.06 + rng.normal(0, 0.001, 5)
    bg_lat, bg_lng = 13.70 + rng.uniform(0, 0.12, 25), 121.00 + rng.uniform(0, 0.12, 25)
    lats, lons = np.concatenate([cl_lat, bg_lat]), np.concatenate([cl_lng, bg_lng])
    x = np.concatenate([np.full(5, 120.0), rng.uniform(15, 30, 25)])
    z = gis._getis_ord_gi_star(x, gis._weight_matrix(lats, lons, 1500.0))
    assert np.all(z[:5] > 1.96)
    assert gis._categorize(float(z[0])) in ("high", "medium")


def test_gi_star_constant_values_gives_zero():
    W = gis._weight_matrix(np.array([13.75, 13.751, 13.752]), np.array([121.05] * 3), 1500.0)
    assert np.all(gis._getis_ord_gi_star(np.array([5.0, 5.0, 5.0]), W) == 0)


def test_benjamini_hochberg():
    p = np.array([0.01, 0.04, 0.03, 0.005])
    # Sorted: .005,.01,.03,.04 → ×4/rank: .02,.02,.04,.04 (monotone)
    assert np.allclose(gis._bh_fdr(p), [0.02, 0.04, 0.04, 0.02])


# ── KDE ──────────────────────────────────────────────────────────────────────

def test_kde_degenerate_inputs_do_not_crash():
    lats, lons = np.array([13.75] * 4), np.array([121.05] * 4)      # identical points
    grid, bw = gis._kde_grid(lats, lons, np.ones(4), 13.7, 13.8, 121.0, 121.1, 20)
    assert grid.shape == (20, 20) and bw == 0.0
    grid, bw = gis._kde_grid(lats + np.arange(4) * 0.001, lons + np.arange(4)[::-1] * 0.002,
                             np.zeros(4), 13.7, 13.8, 121.0, 121.1, 20)   # zero weights
    assert not grid.any()


def test_kde_peak_near_heaviest_site():
    lats = np.array([13.74, 13.76, 13.78, 13.75])
    lons = np.array([121.04, 121.06, 121.08, 121.07])
    w = np.array([1.0, 50.0, 1.0, 1.0])
    grid, bw = gis._kde_grid(lats, lons, w, 13.73, 13.79, 121.03, 121.09, 61)
    r, c = np.unravel_index(np.argmax(grid), grid.shape)
    peak_lat = np.linspace(13.79, 13.73, 61)[r]
    peak_lng = np.linspace(121.03, 121.09, 61)[c]
    assert abs(peak_lat - 13.76) < 0.006 and abs(peak_lng - 121.06) < 0.006
    assert bw > 0


# ── Endpoints ────────────────────────────────────────────────────────────────

def _site(db, code, lat, lng, qty, active=True):
    e = make_establishment(db, code=code, lat=lat, lng=lng, active=active)
    d = date.today() - timedelta(weeks=3)
    db.add(WCOGenerationRecord(establishment_id=e.id, week_date=d, quantity_liters=qty))
    db.commit()
    return e


def test_hotspot_endpoints_exclude_inactive(client, viewer_headers, db):
    for k in range(5):
        _site(db, f"A{k}", 13.75 + 0.003 * k, 121.05 + 0.002 * k, 20 + 5 * k)
    dead = _site(db, "DEAD", 13.76, 121.06, 999, active=False)
    hs = client.get(f"{API}/gis/hotspots?refresh=true", headers=viewer_headers).json()
    assert len(hs) == 5 and dead.id not in {h["establishment_id"] for h in hs}
    assert {"p_value_fdr", "significant_fdr", "neighbor_count"} <= set(hs[0])
    summary = client.get(f"{API}/gis/summary?refresh=true", headers=viewer_headers).json()
    assert summary["total_establishments"] == 5
    kde = client.get(f"{API}/gis/kde?steps=20&refresh=true", headers=viewer_headers).json()
    assert len(kde["grid"]) == 20 and kde["density_units"].startswith("relative")
    # legacy degree parameter still works
    assert client.get(f"{API}/gis/hotspots?band=0.015&refresh=true",
                      headers=viewer_headers).status_code == 200


# ── Routing ──────────────────────────────────────────────────────────────────

def _route_sites(db):
    # Three sites due north of the depot at increasing distance.
    return [_site(db, f"R{k}", 13.750 + 0.01 * (k + 1), 121.05, 10 * (k + 1)) for k in range(3)]


def _req(ids):
    return {"depot_lat": 13.75, "depot_lng": 121.05, "depot_name": "Depot", "establishment_ids": ids}


def test_route_haversine_fallback_when_osrm_down(client, viewer_headers, db, monkeypatch):
    sites = _route_sites(db)
    monkeypatch.setattr(analysis, "_osrm_table", lambda pts, timeout=0: None)
    monkeypatch.setattr(analysis, "_osrm_route", lambda pts, timeout=0: (None, None))
    r = client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                    json=_req([s.id for s in reversed(sites)]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["establishment_id"] for s in body["stops"]] == [s.id for s in sites]  # nearest first
    assert body["distance_basis"] == "straight_line" and body["is_heuristic"] is True
    assert "not guaranteed optimal" in body["algorithm"] and body["warnings"]
    legs = sum(s["leg_distance_km"] for s in body["stops"])
    ret = analysis._haversine_km(sites[-1].latitude, 121.05, 13.75, 121.05)
    assert body["total_distance_km"] == pytest.approx(legs + ret, abs=0.02)
    assert body["total_wco_liters"] == pytest.approx(60.0)


def test_unroutable_leg_is_not_counted_as_zero(client, viewer_headers, db, monkeypatch):
    sites = _route_sites(db)
    n = len(sites) + 1
    # Road distances = 1.3 × straight line, except depot→site0 which OSRM cannot route.
    pts = [(13.75, 121.05)] + [(s.latitude, s.longitude) for s in sites]
    matrix = [[analysis._haversine_km(*pts[i], *pts[j]) * 1300 for j in range(n)] for i in range(n)]
    matrix[0][1] = None
    monkeypatch.setattr(analysis, "_osrm_table", lambda p, timeout=0: matrix)
    monkeypatch.setattr(analysis, "_osrm_route", lambda p, timeout=0: ([[13.75, 121.05]], 1.0))
    body = client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                       json=_req([s.id for s in sites])).json()
    first = body["stops"][0]
    assert first["leg_distance_basis"] == "straight_line" and first["leg_distance_km"] > 1.0
    assert body["distance_basis"] == "mixed" and body["warnings"]


def test_route_ignores_inactive_and_unknown_ids(client, viewer_headers, db, monkeypatch):
    sites = _route_sites(db)
    dead = _site(db, "DEADR", 13.77, 121.05, 5, active=False)
    monkeypatch.setattr(analysis, "_osrm_table", lambda p, timeout=0: None)
    body = client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                       json=_req([s.id for s in sites] + [dead.id, 777777])).json()
    assert body["total_establishments"] == 3 and body["warnings"]


def test_route_request_validation(client, viewer_headers):
    assert client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                       json=_req([])).status_code == 400
    assert client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                       json=_req(list(range(1, 150)))).status_code == 422
    assert client.post(f"{API}/routes/collection-route", headers=viewer_headers,
                       json=dict(_req([1]), depot_lat=200)).status_code == 422
