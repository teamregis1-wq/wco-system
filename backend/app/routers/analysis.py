"""Collection route optimisation using OSRM road-network routing.

Algorithm: greedy nearest-neighbour TSP on road distances from OSRM.
Road geometry is fetched from the public OSRM API and returned alongside
the stop order so the frontend can draw the actual road path.
Falls back to haversine straight-line distances if OSRM is unreachable.
"""
import json
import math
import time
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.analysis import CandidateSite, SavedRoute
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import (
    CollectionRouteRequest, CollectionRouteResponse, RouteStop,
    CandidateSiteOut, CandidateSiteCreate, CollectionRouteResponseV2,
    SavedRouteCreate, SavedRouteOut,
)

router = APIRouter(tags=["analysis"])

OSRM_BASE = "https://router.project-osrm.org"


# ── Haversine fallback ────────────────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0.0, min(1.0, a))))


# ── OSRM helpers ─────────────────────────────────────────────────────────────

def _osrm_table(points: list[tuple[float, float]], timeout: int = 12) -> list[list[float]] | None:
    """Return NxN road-distance matrix in metres. points = [(lat, lng), ...]"""
    coords = ";".join(f"{lng},{lat}" for lat, lng in points)
    url = f"{OSRM_BASE}/table/v1/driving/{coords}?annotations=distance"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            data = json.loads(r.read())
        if data.get("code") != "Ok":
            return None
        return data["distances"]
    except Exception:
        return None


def _osrm_route(points: list[tuple[float, float]], timeout: int = 12) -> tuple[list[list[float]] | None, float | None]:
    """Return (geometry [[lat,lng],...], total_distance_m) for ordered waypoints."""
    coords = ";".join(f"{lng},{lat}" for lat, lng in points)
    url = f"{OSRM_BASE}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=false"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            data = json.loads(r.read())
        if data.get("code") != "Ok" or not data.get("routes"):
            return None, None
        route = data["routes"][0]
        geom = [[lat, lng] for lng, lat in route["geometry"]["coordinates"]]
        return geom, float(route["distance"])
    except Exception:
        return None, None


# ── NN-TSP helpers ────────────────────────────────────────────────────────────

def _nn_tsp(depot: tuple[float, float], nodes: list[dict]) -> list[dict]:
    """Greedy NN-TSP using haversine (fallback when OSRM unavailable)."""
    unvisited = list(nodes)
    route: list[dict] = []
    cur_lat, cur_lng = depot
    while unvisited:
        nearest = min(unvisited, key=lambda n: _haversine_km(cur_lat, cur_lng, n["lat"], n["lng"]))
        unvisited.remove(nearest)
        route.append(nearest)
        cur_lat, cur_lng = nearest["lat"], nearest["lng"]
    return route


def _nn_tsp_road(dist_matrix: list[list[float]], n_nodes: int) -> list[int]:
    """Greedy NN-TSP on road-distance matrix. Depot is index 0, nodes are 1..n."""
    unvisited = set(range(1, n_nodes + 1))
    order: list[int] = []
    cur = 0
    while unvisited:
        row = dist_matrix[cur]
        best = min(unvisited, key=lambda j: row[j] if row[j] is not None else 1e18)
        order.append(best)
        unvisited.remove(best)
        cur = best
    return order  # indices into dist_matrix (1-based for nodes)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/routes/collection-route", response_model=CollectionRouteResponseV2)
def compute_collection_route(
    payload: CollectionRouteRequest,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Compute an optimised WCO collection route using OSRM road distances.

    Falls back to haversine (straight-line) if OSRM is unreachable.
    Returns ordered stops with per-leg distances and the full road geometry.
    """
    t0 = time.perf_counter()
    if not payload.establishment_ids:
        raise HTTPException(status_code=400, detail="No establishment IDs provided.")

    estabs = db.scalars(
        select(Establishment).where(Establishment.id.in_(payload.establishment_ids))
    ).all()
    if not estabs:
        raise HTTPException(status_code=404, detail="None of the supplied IDs were found.")

    avg_map: dict[int, float] = {}
    for e in estabs:
        avg = db.scalar(
            select(func.avg(WCOGenerationRecord.quantity_liters))
            .where(WCOGenerationRecord.establishment_id == e.id)
        ) or 0.0
        avg_map[e.id] = round(float(avg), 1)

    nodes = [
        {"id": e.id, "name": e.name, "wco_code": e.wco_code, "barangay": e.barangay,
         "lat": e.latitude, "lng": e.longitude, "avg_liters": avg_map[e.id]}
        for e in estabs
    ]

    depot = (payload.depot_lat, payload.depot_lng)

    # --- Try OSRM road routing -----------------------------------------------
    all_points = [depot] + [(n["lat"], n["lng"]) for n in nodes]
    dist_matrix = _osrm_table(all_points)
    used_osrm = dist_matrix is not None

    if used_osrm:
        order_indices = _nn_tsp_road(dist_matrix, len(nodes))
        ordered = [nodes[i - 1] for i in order_indices]   # i is 1-based
    else:
        ordered = _nn_tsp(depot, nodes)

    # --- Build stops with per-leg distances ----------------------------------
    stops: list[RouteStop] = []
    prev_lat, prev_lng = depot
    cum = 0.0
    for i, node in enumerate(ordered, 1):
        if used_osrm:
            prev_idx = 0 if i == 1 else order_indices[i - 2]
            cur_idx  = order_indices[i - 1]
            leg_m    = (dist_matrix[prev_idx][cur_idx] or 0.0)
            leg      = round(leg_m / 1000, 2)
        else:
            leg = round(_haversine_km(prev_lat, prev_lng, node["lat"], node["lng"]), 2)
        cum += leg
        stops.append(RouteStop(
            stop_number=i,
            establishment_id=node["id"],
            name=node["name"],
            wco_code=node["wco_code"],
            barangay=node["barangay"],
            avg_liters=node["avg_liters"],
            lat=node["lat"],
            lng=node["lng"],
            leg_distance_km=leg,
            cumulative_distance_km=round(cum, 2),
        ))
        prev_lat, prev_lng = node["lat"], node["lng"]

    # Return leg
    if used_osrm:
        last_idx = order_indices[-1]
        return_m = (dist_matrix[last_idx][0] or 0.0)
        return_leg = round(return_m / 1000, 2)
    else:
        return_leg = round(_haversine_km(prev_lat, prev_lng, depot[0], depot[1]), 2)

    total_dist  = round(cum + return_leg, 2)
    total_wco   = round(sum(n["avg_liters"] for n in ordered), 1)

    # --- Road geometry via OSRM route API ------------------------------------
    road_points = [depot] + [(n["lat"], n["lng"]) for n in ordered] + [depot]
    geometry, _ = _osrm_route(road_points) if used_osrm else (None, None)

    algorithm = (
        "Greedy NN-TSP · OSRM road distances (Batangas City road network)"
        if used_osrm
        else "Greedy NN-TSP · Haversine fallback (OSRM unavailable)"
    )

    return CollectionRouteResponseV2(
        depot_lat=payload.depot_lat,
        depot_lng=payload.depot_lng,
        depot_name=payload.depot_name,
        stops=stops,
        total_distance_km=total_dist,
        total_establishments=len(stops),
        estimated_duration_min=round((total_dist / 30.0) * 60, 0),
        total_wco_liters=total_wco,
        algorithm=algorithm,
        computation_time_ms=round((time.perf_counter() - t0) * 1000, 1),
        geometry=geometry,
    )


@router.post("/routes/compute")
def compute_point_to_point(
    source_id: int,
    target_id: int,
    algorithm: str = "dijkstra_shortest",
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Point-to-point road distance between two establishments via OSRM."""
    source = db.get(Establishment, source_id)
    target = db.get(Establishment, target_id)
    if not source or not target:
        raise HTTPException(status_code=404, detail="Establishment not found.")
    points = [(source.latitude, source.longitude), (target.latitude, target.longitude)]
    geom, dist_m = _osrm_route(points)
    if dist_m is None:
        dist_km = _haversine_km(source.latitude, source.longitude, target.latitude, target.longitude)
        dist_m  = dist_km * 1000
    return {
        "source_id": source_id,
        "target_id": target_id,
        "algorithm": algorithm,
        "total_distance_m": round(dist_m, 1),
        "estimated_travel_min": round(dist_m / 1000 / 30 * 60, 1),
        "geometry": geom,
    }


# ── Saved routes ──────────────────────────────────────────────────────────────

@router.get("/routes/saved", response_model=list[SavedRouteOut])
def list_saved_routes(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    routes = db.scalars(select(SavedRoute).order_by(SavedRoute.created_at.desc())).all()
    return list(routes)


@router.post("/routes/saved", response_model=SavedRouteOut, status_code=201)
def save_route(
    payload: SavedRouteCreate,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    route = SavedRoute(**payload.model_dump())
    db.add(route)
    db.commit()
    db.refresh(route)
    return route


@router.delete("/routes/saved/{route_id}", status_code=204)
def delete_saved_route(
    route_id: int,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    route = db.get(SavedRoute, route_id)
    if not route:
        raise HTTPException(status_code=404, detail="Saved route not found.")
    db.delete(route)
    db.commit()


# ── Candidate collection sites ───────────────────────────────────────────────

@router.get("/candidate-sites", response_model=list[CandidateSiteOut])
def list_candidate_sites(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    sites = db.scalars(select(CandidateSite).order_by(CandidateSite.id)).all()
    if not sites:
        defaults = [
            CandidateSite(name="Batangas City Hall", latitude=13.7565, longitude=121.0583,
                          rationale="Central government hub; accessible from all barangays"),
            CandidateSite(name="BREDCO Port Area", latitude=13.7610, longitude=121.0720,
                          rationale="Industrial zone; proximity to fuel transport infrastructure"),
            CandidateSite(name="Batangas Public Market", latitude=13.7540, longitude=121.0580,
                          rationale="High food-establishment density; frequent WCO source"),
            CandidateSite(name="Bolbok Industrial Estate", latitude=13.7380, longitude=121.0690,
                          rationale="Near fuel distributors; large processing space available"),
            CandidateSite(name="BatStateU Main Campus", latitude=13.7860, longitude=121.0680,
                          rationale="Research partner; existing laboratory infrastructure"),
        ]
        for s in defaults:
            db.add(s)
        db.commit()
        sites = db.scalars(select(CandidateSite).order_by(CandidateSite.id)).all()
    return list(sites)


@router.post("/candidate-sites", response_model=CandidateSiteOut, status_code=201)
def create_candidate_site(
    payload: CandidateSiteCreate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "researcher")),
):
    site = CandidateSite(**payload.model_dump())
    db.add(site)
    db.commit()
    db.refresh(site)
    return site


@router.delete("/candidate-sites/{site_id}", status_code=204)
def delete_candidate_site(
    site_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    site = db.get(CandidateSite, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Candidate site not found.")
    db.delete(site)
    db.commit()
