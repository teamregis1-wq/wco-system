"""Collection route planning using OSRM road-network distances.

Algorithm: nearest-neighbour construction heuristic for the travelling-salesman
tour (start and end at the depot). It is fast and usually reasonable, but it is
a HEURISTIC — the resulting tour is NOT guaranteed to be the shortest possible.

Distances come from the OSRM table service (road network). If OSRM is
unreachable the whole route falls back to haversine (straight-line) distances;
if OSRM reports an individual pair as unroutable, that leg alone uses the
haversine estimate and the response says so (``distance_basis`` = "mixed").
Durations assume a constant average speed (ROUTE_AVG_SPEED_KMH, default
30 km/h) and exclude time spent at each stop.
"""
import json
import math
import time
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.analysis import SavedRoute
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import (
    CollectionRouteRequest, CollectionRouteResponse, RouteStop,
    CollectionRouteResponseV2,
    SavedRouteCreate, SavedRouteOut,
)

router = APIRouter(tags=["analysis"])

OSRM_BASE = settings.osrm_base_url.rstrip("/")
# The public OSRM server's table service accepts at most 100 coordinates per request.
OSRM_MAX_TABLE_POINTS = 100
OSRM_TIMEOUT = settings.osrm_timeout_seconds


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

def _osrm_table(points: list[tuple[float, float]], timeout: float = OSRM_TIMEOUT) -> list[list[float | None]] | None:
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


def _osrm_route(points: list[tuple[float, float]], timeout: float = OSRM_TIMEOUT) -> tuple[list[list[float]] | None, float | None]:
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


def _nn_tsp_road(dist_matrix: list[list[float | None]], n_nodes: int,
                 fallback_km) -> list[int]:
    """Greedy NN-TSP on a road-distance matrix. Depot is index 0, nodes are 1..n.

    Unroutable pairs (OSRM returns null) are compared using the haversine
    fallback instead of being treated as zero or infinite.
    """
    unvisited = set(range(1, n_nodes + 1))
    order: list[int] = []
    cur = 0
    while unvisited:
        row = dist_matrix[cur]

        def cost(j: int) -> float:
            v = row[j] if j < len(row) else None
            return v if v is not None else fallback_km(cur, j) * 1000.0

        best = min(unvisited, key=lambda j: (cost(j), j))
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
    """Plan a WCO collection tour with the nearest-neighbour heuristic.

    Uses OSRM road distances; falls back to haversine (straight-line) if OSRM
    is unreachable. The tour is NOT guaranteed optimal.
    Returns ordered stops with per-leg distances and the full road geometry.
    """
    t0 = time.perf_counter()
    if not payload.establishment_ids:
        raise HTTPException(status_code=400, detail="No establishment IDs provided.")

    estabs = db.scalars(
        select(Establishment).where(Establishment.id.in_(payload.establishment_ids),
                                    Establishment.is_active.is_(True))
        .order_by(Establishment.id)
    ).all()
    if not estabs:
        raise HTTPException(status_code=404, detail="None of the supplied IDs were found (or all are inactive).")

    warnings: list[str] = []
    missing = set(payload.establishment_ids) - {e.id for e in estabs}
    if missing:
        warnings.append(f"{len(missing)} selected establishment(s) were not found or are inactive and were left out.")

    avg_rows = db.execute(
        select(WCOGenerationRecord.establishment_id, func.avg(WCOGenerationRecord.quantity_liters))
        .where(WCOGenerationRecord.establishment_id.in_([e.id for e in estabs]))
        .group_by(WCOGenerationRecord.establishment_id)
    ).all()
    avg_map: dict[int, float] = {e.id: 0.0 for e in estabs}
    for eid, avg in avg_rows:
        avg_map[eid] = round(float(avg or 0.0), 1)

    nodes = [
        {"id": e.id, "name": e.name, "wco_code": e.wco_code, "barangay": e.barangay,
         "lat": e.latitude, "lng": e.longitude, "avg_liters": avg_map[e.id]}
        for e in estabs
    ]

    depot = (payload.depot_lat, payload.depot_lng)

    # --- Try OSRM road routing -----------------------------------------------
    all_points = [depot] + [(n["lat"], n["lng"]) for n in nodes]
    if len(all_points) > OSRM_MAX_TABLE_POINTS:
        dist_matrix = None
        warnings.append(f"{len(nodes)} stops exceed the OSRM table limit ({OSRM_MAX_TABLE_POINTS - 1} stops "
                        "plus the depot); distances are straight-line estimates.")
    else:
        dist_matrix = _osrm_table(all_points)
    used_osrm = dist_matrix is not None

    def straight_km(i: int, j: int) -> float:
        (a_lat, a_lng), (b_lat, b_lng) = all_points[i], all_points[j]
        return _haversine_km(a_lat, a_lng, b_lat, b_lng)

    def leg_km(i: int, j: int) -> tuple[float, str]:
        """Road distance if OSRM routed this pair, else a straight-line estimate."""
        if used_osrm:
            v = dist_matrix[i][j]
            if v is not None:
                return v / 1000.0, "road"
        return straight_km(i, j), "straight_line"

    if used_osrm:
        order_indices = _nn_tsp_road(dist_matrix, len(nodes), straight_km)
    else:
        # Same heuristic on straight-line distances.
        visit = _nn_tsp(depot, nodes)
        index_of = {n["id"]: k + 1 for k, n in enumerate(nodes)}
        order_indices = [index_of[n["id"]] for n in visit]
    ordered = [nodes[i - 1] for i in order_indices]   # i is 1-based

    # --- Build stops with per-leg distances ----------------------------------
    stops: list[RouteStop] = []
    bases: set[str] = set()
    cum = 0.0
    for i, node in enumerate(ordered, 1):
        prev_idx = 0 if i == 1 else order_indices[i - 2]
        cur_idx  = order_indices[i - 1]
        leg_raw, basis = leg_km(prev_idx, cur_idx)
        bases.add(basis)
        leg = round(leg_raw, 2)
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
            leg_distance_basis=basis,
        ))

    # Return leg
    return_raw, basis = leg_km(order_indices[-1], 0)
    bases.add(basis)
    return_leg = round(return_raw, 2)

    total_dist  = round(cum + return_leg, 2)
    total_wco   = round(sum(n["avg_liters"] for n in ordered), 1)

    distance_basis = "mixed" if len(bases) > 1 else bases.pop()
    if not used_osrm:
        warnings.append("OSRM road routing was unavailable; distances are straight-line "
                        "(haversine) estimates and understate road distance.")
    elif distance_basis == "mixed":
        warnings.append("OSRM could not route some legs; those legs use straight-line "
                        "estimates (see leg_distance_basis on each stop).")

    # --- Road geometry via OSRM route API ------------------------------------
    road_points = [depot] + [(n["lat"], n["lng"]) for n in ordered] + [depot]
    geometry, _ = _osrm_route(road_points) if used_osrm else (None, None)
    if used_osrm and geometry is None:
        warnings.append("Road geometry could not be retrieved; the map shows straight segments.")

    algorithm = (
        "Nearest-neighbour heuristic (not guaranteed optimal) · OSRM road distances"
        if used_osrm
        else "Nearest-neighbour heuristic (not guaranteed optimal) · straight-line fallback"
    )

    return CollectionRouteResponseV2(
        depot_lat=payload.depot_lat,
        depot_lng=payload.depot_lng,
        depot_name=payload.depot_name,
        stops=stops,
        total_distance_km=total_dist,
        total_establishments=len(stops),
        estimated_duration_min=round((total_dist / settings.route_avg_speed_kmh) * 60, 0),
        total_wco_liters=total_wco,
        algorithm=algorithm,
        computation_time_ms=round((time.perf_counter() - t0) * 1000, 1),
        geometry=geometry,
        distance_basis=distance_basis,
        is_heuristic=True,
        warnings=warnings,
    )


@router.post("/routes/compute")
def compute_point_to_point(
    source_id: int,
    target_id: int,
    algorithm: str = "dijkstra_shortest",
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Point-to-point road distance between two establishments via OSRM.

    The ``algorithm`` query parameter is accepted for backward compatibility
    but ignored: the path is whatever OSRM's own shortest-path routing returns
    (or a straight line if OSRM is unavailable). The response reports which.
    """
    source = db.get(Establishment, source_id)
    target = db.get(Establishment, target_id)
    if not source or not target:
        raise HTTPException(status_code=404, detail="Establishment not found.")
    points = [(source.latitude, source.longitude), (target.latitude, target.longitude)]
    geom, dist_m = _osrm_route(points)
    basis = "road"
    if dist_m is None:
        dist_km = _haversine_km(source.latitude, source.longitude, target.latitude, target.longitude)
        dist_m  = dist_km * 1000
        basis = "straight_line"
    return {
        "source_id": source_id,
        "target_id": target_id,
        "algorithm": "osrm_route" if basis == "road" else "haversine_straight_line",
        "distance_basis": basis,
        "total_distance_m": round(dist_m, 1),
        "estimated_travel_min": round(dist_m / 1000 / settings.route_avg_speed_kmh * 60, 1),
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
    _=Depends(require_role("admin", "researcher")),
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
    _=Depends(require_role("admin", "researcher")),
):
    route = db.get(SavedRoute, route_id)
    if not route:
        raise HTTPException(status_code=404, detail="Saved route not found.")
    db.delete(route)
    db.commit()
