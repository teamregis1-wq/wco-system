"""Result and analysis tables: forecasts, road network, routes, simulations.

These store the OUTPUTS of each module so the frontend can read them back
without recomputing. This mirrors section 4.1 of the project plan.
"""
from datetime import date, datetime, timezone

from geoalchemy2 import Geometry
from sqlalchemy import (
    Float, Integer, String, Date, DateTime, ForeignKey, JSON, Text
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# --- Forecasting (LSTM RNN) -------------------------------------------------

class ForecastRun(Base):
    """One training/inference run. Stores hyperparameters and metrics."""
    __tablename__ = "forecast_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    model_version: Mapped[str] = mapped_column(String(50))
    model_type: Mapped[str] = mapped_column(String(20), default="lstm")  # or 'arima'
    hyperparams: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    mae: Mapped[float | None] = mapped_column(Float, nullable=True)
    rmse: Mapped[float | None] = mapped_column(Float, nullable=True)
    r2: Mapped[float | None] = mapped_column(Float, nullable=True)
    mape: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ForecastResult(Base):
    """A single predicted WCO value for one establishment in one future week."""
    __tablename__ = "forecast_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("forecast_runs.id", ondelete="CASCADE"), index=True
    )
    establishment_id: Mapped[int] = mapped_column(
        ForeignKey("establishments.id", ondelete="CASCADE"), index=True
    )
    week_date: Mapped[date] = mapped_column(Date, index=True)
    predicted_liters: Mapped[float] = mapped_column(Float)


# --- GIS / hotspots ---------------------------------------------------------

class HotspotScore(Base):
    """Computed hotspot intensity per establishment for a forecast period.

    category: 'high' | 'medium' | 'low' (the red/yellow/blue in the mockups).
    """
    __tablename__ = "hotspot_scores"

    id: Mapped[int] = mapped_column(primary_key=True)
    establishment_id: Mapped[int] = mapped_column(
        ForeignKey("establishments.id", ondelete="CASCADE"), index=True
    )
    forecast_period: Mapped[date] = mapped_column(Date)
    score: Mapped[float] = mapped_column(Float)         # 0..1
    category: Mapped[str] = mapped_column(String(10))   # high/medium/low


class CandidateSite(Base):
    """Candidate biodiesel processing facility locations."""
    __tablename__ = "candidate_sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=4326), nullable=True
    )
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)


class RoadNetworkEdge(Base):
    """A single edge of the Lipa City road graph imported via OSMnx.

    Stored so the routing engine can rebuild the NetworkX graph without
    re-downloading from OpenStreetMap every time.
    """
    __tablename__ = "road_network"

    edge_id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    source_node: Mapped[int] = mapped_column(Integer, index=True)
    target_node: Mapped[int] = mapped_column(Integer, index=True)
    distance_m: Mapped[float] = mapped_column(Float)
    travel_time_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="LINESTRING", srid=4326), nullable=True
    )


class RouteResult(Base):
    """A computed collection route between a source and a target."""
    __tablename__ = "route_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(Integer)   # establishment or hotspot id
    target_id: Mapped[int] = mapped_column(Integer)   # candidate site id
    algorithm: Mapped[str] = mapped_column(String(30))  # 'dijkstra_shortest' etc.
    total_distance_m: Mapped[float] = mapped_column(Float)
    total_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Ordered list of node ids / coordinates describing the path.
    path: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


# --- Biodiesel simulation ---------------------------------------------------

class SimulationRun(Base):
    """One CHEMCAD / RSM simulation row: input parameters + yield output."""
    __tablename__ = "simulation_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    temperature_c: Mapped[float] = mapped_column(Float)
    molar_ratio: Mapped[float] = mapped_column(Float)      # alcohol-to-oil
    catalyst_loading_pct: Mapped[float] = mapped_column(Float)
    yield_pct: Mapped[float] = mapped_column(Float)
    conversion_efficiency: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str | None] = mapped_column(String(500), nullable=True)


class OptimizationResult(Base):
    """Best-performing reaction conditions from RSM optimization."""
    __tablename__ = "optimization_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    optimal_temp_c: Mapped[float] = mapped_column(Float)
    optimal_molar_ratio: Mapped[float] = mapped_column(Float)
    optimal_catalyst_pct: Mapped[float] = mapped_column(Float)
    max_yield_pct: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class SavedRoute(Base):
    """A named, saved collection route computed by the TSP engine."""
    __tablename__ = "saved_routes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    depot_name: Mapped[str] = mapped_column(String(255), default="Depot")
    depot_lat: Mapped[float] = mapped_column(Float)
    depot_lng: Mapped[float] = mapped_column(Float)
    total_distance_km: Mapped[float] = mapped_column(Float)
    total_establishments: Mapped[int] = mapped_column(Integer)
    total_wco_liters: Mapped[float] = mapped_column(Float)
    estimated_duration_min: Mapped[float] = mapped_column(Float)
    algorithm: Mapped[str] = mapped_column(String(100))
    stops_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    geometry_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
