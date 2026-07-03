"""Import every model here so Base.metadata sees all tables.

Alembic autogenerate and the seed script both rely on this single import
point. If you add a new model file, import its classes here too.
"""
from app.models.audit import AuditLog
from app.models.user import User
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord, WCOQualityTest
from app.models.analysis import (
    ForecastRun,
    ForecastResult,
    HotspotScore,
    CandidateSite,
    RoadNetworkEdge,
    RouteResult,
    SimulationRun,
    OptimizationResult,
    SavedRoute,
)

__all__ = [
    "AuditLog",
    "User",
    "Establishment",
    "WCOGenerationRecord",
    "WCOQualityTest",
    "ForecastRun",
    "ForecastResult",
    "HotspotScore",
    "CandidateSite",
    "RoadNetworkEdge",
    "RouteResult",
    "SimulationRun",
    "OptimizationResult",
    "SavedRoute",
]
