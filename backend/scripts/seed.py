"""Seed the database with realistic synthetic data.

Run AFTER migrations:  python -m scripts.seed

Generates:
  - 1 admin user (admin@wco.local / admin12345)
  - 120 establishments around Lipa City (60 restaurant, 40 fast_food, 20 manufacturer)
  - 52 weeks of WCO generation per establishment (~6,240 rows) with realistic
    trend + weekly seasonality + noise, so the LSTM has a genuine signal to learn
  - quality tests, a few candidate sites, and a small RSM simulation grid

Re-running wipes and regenerates (safe for development only).
"""
import math
import random
from datetime import date, timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session
from geoalchemy2.functions import ST_SetSRID, ST_MakePoint

from app.core.config import settings
from app.core.database import SessionLocal, engine, Base
from app.core.security import hash_password
from app.models import (
    User, Establishment, WCOGenerationRecord, WCOQualityTest,
    CandidateSite, SimulationRun, OptimizationResult,
)

random.seed(42)  # reproducible data

CENTER_LAT = 13.7565
CENTER_LNG = 121.0583

BARANGAYS = [
    "Poblacion", "Kumintang Ibaba", "Kumintang Ilaya", "Sta. Clara",
    "Pallocan West", "Pallocan East", "Libjo", "Bolbok", "Cuta",
    "Calicanto", "Alangilan", "Gulod Labac", "Gulod Itaas", "Bagong Sikat",
]

TYPE_PLAN = [("restaurant", 60), ("fast_food", 40), ("food_manufacturer", 20)]
TYPE_PREFIX = {"restaurant": "RS", "fast_food": "FF", "food_manufacturer": "FM"}
# Typical weekly base volume (liters) per type, plus how seasonal each is.
TYPE_PROFILE = {
    "restaurant":        {"base": 35, "amp": 8,  "trend": 0.10},
    "fast_food":         {"base": 55, "amp": 14, "trend": 0.18},
    "food_manufacturer": {"base": 90, "amp": 6,  "trend": 0.25},
}

NAME_POOL = [
    "Lutong Bahay", "Kainan ni Aling Nena", "Batangas Grill", "Lipa Diner",
    "Quick Bites", "Golden Spoon", "Mang Inasal Corner", "Silog Express",
    "Crispy Town", "Mami House", "Bagnet Haus", "Lomi King", "Sizzling Plate",
    "Panciteria Central", "Halo Cafe", "Bayanihan Eatery", "Sulok Foods",
    "Meaco Kitchen", "Recto Resto", "Pamilya Carinderia",
]


def jitter_coord() -> tuple[float, float]:
    """A random point within roughly ~4 km of the city center."""
    return (
        CENTER_LAT + random.uniform(-0.035, 0.035),
        CENTER_LNG + random.uniform(-0.035, 0.035),
    )


def wipe(db: Session) -> None:
    for model in (
        WCOGenerationRecord, WCOQualityTest, SimulationRun,
        OptimizationResult, CandidateSite, Establishment, User,
    ):
        db.execute(delete(model))
    db.commit()


def seed_users(db: Session) -> None:
    db.add(User(
        email="admin@wco.local",
        full_name="System Admin",
        hashed_password=hash_password("admin12345"),
        role="admin",
    ))
    db.add(User(
        email="researcher@wco.local",
        full_name="Research Lead",
        hashed_password=hash_password("research12345"),
        role="researcher",
    ))
    db.commit()
    print("  users: admin@wco.local / admin12345  (and researcher@wco.local)")


def seed_establishments(db: Session) -> list[Establishment]:
    estabs: list[Establishment] = []
    counter = {k: 0 for k in TYPE_PREFIX}
    for etype, count in TYPE_PLAN:
        for _ in range(count):
            counter[etype] += 1
            lat, lng = jitter_coord()
            code = f"{TYPE_PREFIX[etype]}{counter[etype]:03d}"
            name = f"{random.choice(NAME_POOL)} {counter[etype]}"
            e = Establishment(
                wco_code=code,
                name=name,
                type=etype,
                barangay=random.choice(BARANGAYS),
                address=f"{random.randint(1, 300)} {random.choice(BARANGAYS)} St., Lipa City",
                latitude=round(lat, 6),
                longitude=round(lng, 6),
                geom=ST_SetSRID(ST_MakePoint(lng, lat), 4326),
                seating_capacity=random.choice([0, 20, 40, 60, 120]),
                consent_given=True,
                is_active=True,
            )
            db.add(e)
            estabs.append(e)
    db.commit()
    for e in estabs:
        db.refresh(e)
    print(f"  establishments: {len(estabs)}")
    return estabs


def seed_wco_records(db: Session, estabs: list[Establishment]) -> None:
    """52 weeks per establishment with trend + seasonality + noise."""
    start = date.today() - timedelta(weeks=52)
    total = 0
    for e in estabs:
        prof = TYPE_PROFILE[e.type]
        base = prof["base"] * random.uniform(0.8, 1.2)
        for week in range(52):
            d = start + timedelta(weeks=week)
            trend = prof["trend"] * week
            seasonal = prof["amp"] * math.sin(2 * math.pi * week / 13.0)  # quarterly cycle
            noise = random.gauss(0, prof["amp"] * 0.25)
            qty = max(0.0, base + trend + seasonal + noise)
            db.add(WCOGenerationRecord(
                establishment_id=e.id,
                week_date=d,
                quantity_liters=round(qty, 2),
            ))
            total += 1
        # one quality test per establishment
        db.add(WCOQualityTest(
            establishment_id=e.id,
            sample_date=start + timedelta(weeks=26),
            ffa_pct=round(random.uniform(1.2, 4.5), 2),
            viscosity_cp=round(random.uniform(28, 45), 1),
            density_gml=round(random.uniform(0.885, 0.905), 4),
        ))
    db.commit()
    print(f"  wco generation records: {total}")
    print(f"  quality tests: {len(estabs)}")


def seed_candidate_sites(db: Session) -> None:
    sites = [
        ("Lipa Biodiesel Hub (proposed)", "Near industrial zone, good road access"),
        ("Marawoy Processing Site", "Central to high-volume fast-food cluster"),
        ("Sabang Collection Depot", "Edge-of-city, lower land cost"),
    ]
    for name, rationale in sites:
        lat, lng = jitter_coord()
        db.add(CandidateSite(
            name=name, latitude=round(lat, 6), longitude=round(lng, 6),
            geom=ST_SetSRID(ST_MakePoint(lng, lat), 4326),
            rationale=rationale,
        ))
    db.commit()
    print(f"  candidate sites: {len(sites)}")


def seed_simulations(db: Session) -> None:
    """A small Box-Behnken-style grid so the biodiesel dashboard has data.

    Replace this with real CHEMCAD output once your simulations are done.
    """
    best = None
    for temp in (50, 60, 70):
        for ratio in (6, 9, 12):
            for cat in (0.5, 1.0, 1.5):
                # toy response surface peaking near 60C / ratio 9 / 1.0% catalyst
                yld = (
                    96
                    - 0.02 * (temp - 60) ** 2
                    - 0.15 * (ratio - 9) ** 2
                    - 6.0 * (cat - 1.0) ** 2
                    + random.gauss(0, 0.4)
                )
                run = SimulationRun(
                    temperature_c=temp, molar_ratio=ratio,
                    catalyst_loading_pct=cat,
                    yield_pct=round(yld, 2),
                    conversion_efficiency=round(yld / 100, 4),
                )
                db.add(run)
                if best is None or yld > best[0]:
                    best = (yld, temp, ratio, cat)
    db.commit()
    if best:
        db.add(OptimizationResult(
            optimal_temp_c=best[1], optimal_molar_ratio=best[2],
            optimal_catalyst_pct=best[3], max_yield_pct=round(best[0], 2),
        ))
        db.commit()
    print("  simulation grid: 27 runs + 1 optimization result")


def main() -> None:
    # Create tables if migrations haven't been run (convenience for first run).
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        print("Seeding database...")
        wipe(db)
        seed_users(db)
        estabs = seed_establishments(db)
        seed_wco_records(db, estabs)
        seed_candidate_sites(db)
        seed_simulations(db)
        print("Done. Start the API with: uvicorn app.main:app --reload")
    finally:
        db.close()


if __name__ == "__main__":
    main()
