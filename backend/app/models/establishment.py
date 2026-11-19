"""Food establishments — the core study population (120 in Batangas City).

Each row stores a PostGIS POINT geometry (geom) in addition to plain
lat/lng floats. The geometry enables spatial queries (distance, within-radius,
KDE) directly in the database; the floats make the data trivial to send to the
frontend map without a geometry conversion step.
"""
from datetime import datetime, timezone

from geoalchemy2 import Geometry
from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Establishment(Base):
    __tablename__ = "establishments"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Human-facing unique code, e.g. "FF001" (fast food), "RS001" (restaurant).
    wco_code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    # One of: 'restaurant', 'fast_food', 'food_manufacturer'
    type: Mapped[str] = mapped_column(String(50), index=True)

    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    barangay: Mapped[str | None] = mapped_column(String(120), nullable=True)

    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    # SRID 4326 = standard GPS lat/lng coordinate system. Deferred: the API
    # never reads the geometry in Python (spatial work uses lat/lng or SQL), so
    # list endpoints don't pay for converting it on every row.
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=4326), nullable=True, deferred=True
    )

    # Operational metadata (optional, free for the research team to use).
    business_hours: Mapped[str | None] = mapped_column(String(120), nullable=True)
    seating_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    contact_info: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # True only when participation consent has actually been recorded.
    consent_given: Mapped[bool] = mapped_column(Boolean, default=False)
    # Provenance of this row: 'synthetic' | 'observed' | 'unspecified'.
    data_source: Mapped[str] = mapped_column(
        String(20), default="unspecified", server_default=text("'unspecified'")
    )

    # Soft delete: set False instead of removing the row, so history survives.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    wco_records: Mapped[list["WCOGenerationRecord"]] = relationship(
        back_populates="establishment", cascade="all, delete-orphan"
    )
    quality_tests: Mapped[list["WCOQualityTest"]] = relationship(
        back_populates="establishment", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint(
            "latitude >= -90 AND latitude <= 90 AND longitude >= -180 AND longitude <= 180",
            name="ck_establishments_coordinates",
        ),
        CheckConstraint(
            "data_source IN ('synthetic', 'observed', 'unspecified')",
            name="ck_establishments_data_source",
        ),
    )
