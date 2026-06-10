"""WCO generation records (weekly time-series) and laboratory quality tests.

The generation records are the training data for the LSTM: 120 establishments
x 52 weeks = ~6,240 observations. The quality tests feed the biodiesel
suitability analysis (FFA, viscosity, density).
"""
from datetime import date, datetime, timezone

from sqlalchemy import Float, Integer, Date, DateTime, String, ForeignKey, Index
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    establishment: Mapped["Establishment"] = relationship(
        back_populates="wco_records"
    )

    # Composite index for fast "all records for establishment X over time" queries.
    __table_args__ = (
        Index("ix_wco_estab_week", "establishment_id", "week_date"),
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
