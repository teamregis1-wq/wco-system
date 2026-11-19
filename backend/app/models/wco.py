"""WCO generation records (weekly time-series) and laboratory quality tests.

The generation records are the training data for the LSTM: 120 establishments
x 52 weeks = ~6,240 observations. The quality tests feed the biodiesel
suitability analysis (FFA, viscosity, density).
"""
from datetime import date, datetime, timezone

from sqlalchemy import (
    CheckConstraint, Date, DateTime, Float, ForeignKey, String, UniqueConstraint, text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class WCOGenerationRecord(Base):
    __tablename__ = "wco_generation_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    establishment_id: Mapped[int] = mapped_column(
        ForeignKey("establishments.id", ondelete="CASCADE"), index=True
    )
    week_date: Mapped[date] = mapped_column(Date, index=True)
    week_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # The forecasting target. Liters of WCO generated that week.
    quantity_liters: Mapped[float] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Provenance: 'synthetic' | 'observed' | 'unspecified' (see app.core.constants).
    data_source: Mapped[str] = mapped_column(
        String(20), default="unspecified", server_default=text("'unspecified'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # Set on every edit so retraining jobs and exports can show data recency.
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    establishment: Mapped["Establishment"] = relationship(
        back_populates="wco_records"
    )

    __table_args__ = (
        # One weekly total per establishment per week. Also serves as the
        # composite index for "all records for establishment X over time".
        UniqueConstraint("establishment_id", "week_date", name="uq_wco_records_estab_week"),
        # Rejects negatives, NaN and +/-Infinity (NaN/Inf fail the upper bound in PostgreSQL).
        CheckConstraint(
            "quantity_liters >= 0 AND quantity_liters <= 10000",
            name="ck_wco_records_quantity_range",
        ),
        CheckConstraint(
            "week_end_date IS NULL OR week_end_date >= week_date",
            name="ck_wco_records_week_end_after_start",
        ),
        CheckConstraint(
            "data_source IN ('synthetic', 'observed', 'unspecified')",
            name="ck_wco_records_data_source",
        ),
    )


class WCOQualityTest(Base):
    __tablename__ = "wco_quality_tests"

    id: Mapped[int] = mapped_column(primary_key=True)
    establishment_id: Mapped[int] = mapped_column(
        ForeignKey("establishments.id", ondelete="CASCADE"), index=True
    )
    sample_date: Mapped[date] = mapped_column(Date)
    ffa_pct: Mapped[float] = mapped_column(Float)        # free fatty acid %
    viscosity_cp: Mapped[float] = mapped_column(Float)   # centipoise
    density_gml: Mapped[float] = mapped_column(Float)    # g/mL
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    establishment: Mapped["Establishment"] = relationship(
        back_populates="quality_tests"
    )
