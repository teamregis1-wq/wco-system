"""Route optimization and biodiesel simulation endpoints.

These are intentionally thin stubs that return clear "not yet implemented"
messages so the frontend can wire up the calls early. Fill them in during
the routing sprint (weeks 10-11) and biodiesel sprint (weeks 3-4, pulled
forward).
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.analysis import SimulationRun

router = APIRouter(tags=["analysis"])


@router.post("/routes/compute")
def compute_route(
    source_id: int,
    target_id: int,
    algorithm: str = "dijkstra_shortest",
    _=Depends(get_current_user),
):
    """TODO (routing sprint): build NetworkX graph from road_network table,
    run Dijkstra, return ordered path + total distance/cost.
    """
    return {
        "status": "not_implemented",
        "message": "Routing engine arrives in the routing sprint.",
        "source_id": source_id,
        "target_id": target_id,
        "algorithm": algorithm,
    }


@router.get("/simulations")
def list_simulations(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Read-only list of imported CHEMCAD/RSM simulation runs."""
    rows = db.scalars(select(SimulationRun)).all()
    return [
        {
            "id": s.id,
            "temperature_c": s.temperature_c,
            "molar_ratio": s.molar_ratio,
            "catalyst_loading_pct": s.catalyst_loading_pct,
            "yield_pct": s.yield_pct,
            "conversion_efficiency": s.conversion_efficiency,
        }
        for s in rows
    ]
