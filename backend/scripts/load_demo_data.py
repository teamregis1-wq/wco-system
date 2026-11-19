"""Load the SYNTHETIC demonstration dataset — additively and safely.

    cd backend
    ./venv/bin/python -m scripts.load_demo_data                 # dry run: report only
    ./venv/bin/python -m scripts.load_demo_data --commit        # actually insert

What it does
------------
* Establishments come from data/demo_establishment_catalog.csv (120 rows:
  60 restaurants RS###, 40 fast food FF###, 20 food manufacturers FM###).
  A catalog row is inserted only if no establishment with that wco_code
  exists. Existing establishments are never modified.
* Weekly WCO records are generated only for weeks that do not already exist:
    - establishment with no records  → `--weeks` consecutive weeks ending at --end-date
    - establishment with records     → (only with --extend-existing) continue the
                                       series weekly from its last record up to --end-date
  Existing records are never updated, overwritten, or deleted.
* Everything inserted is labelled data_source='synthetic', consent_given=False,
  and notes record the generator and seed.
* With --commit a retraining job is queued; the running API picks it up
  within RETRAIN_POLL_SECONDS (default 30 s).

Generating model (documented assumptions; all quantities in liters per week)
---------------------------------------------------------------------------
    q(w) = max(0, base + trend·w + amp·sin(2πw/13) + ε),  ε ~ Normal(0, (0.3·amp)²)

    type               base ~ Uniform      amp   trend (L/week per week)
    restaurant         [20, 55]              8   0.10
    fast_food          [40, 80]             14   0.18
    food_manufacturer  [70, 120]             6   0.25

The 13-week sine is an assumed quarterly cycle; trend, amplitude and ranges
are illustrative assumptions, NOT measurements from Batangas City
establishments. Each establishment's random stream is seeded from
(--seed, wco_code), so the same code always gets the same series no matter
which other establishments exist.

Extension of an existing series uses seasonal continuation:
    q(t) = max(0, q(t−13) + 13·trend + ε)
which keeps the established level, 13-week cycle and trend.

Names: by default inserted establishments get GENERIC names (e.g.
"Fast-food outlet FF012 — Pallocan West"). The catalog also holds the names of
real businesses near which the approximate coordinates were placed; use
--catalog-names only if you are comfortable presenting synthetic WCO volumes
next to real business names (the UI still labels the data synthetic).
"""
from __future__ import annotations

import argparse
import csv
import math
import sys
import zlib
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from geoalchemy2.functions import ST_MakePoint, ST_SetSRID
from sqlalchemy import func, inspect, select

from app.core.audit import log_action
from app.core.database import SessionLocal, engine, safe_url
from app.models import Establishment, WCOGenerationRecord

CATALOG = Path(__file__).resolve().parents[1] / "data" / "demo_establishment_catalog.csv"
PROFILE = {
    "restaurant":        {"lo": 20, "hi": 55,  "amp": 8,  "trend": 0.10},
    "fast_food":         {"lo": 40, "hi": 80,  "amp": 14, "trend": 0.18},
    "food_manufacturer": {"lo": 70, "hi": 120, "amp": 6,  "trend": 0.25},
}
GENERIC = {"restaurant": "Restaurant", "fast_food": "Fast-food outlet",
           "food_manufacturer": "Food manufacturer"}


def last_completed_week_start(today: date | None = None) -> date:
    """Monday of the most recent fully completed Monday–Sunday week."""
    today = today or date.today()
    return today - timedelta(days=today.weekday() + 7)


def rng_for(seed: int, code: str) -> np.random.Generator:
    return np.random.default_rng([seed, zlib.crc32(code.encode())])


def fresh_series(code: str, etype: str, weeks: int, end: date, seed: int) -> list[tuple[date, float]]:
    p = PROFILE[etype]
    rng = rng_for(seed, code)
    base = rng.uniform(p["lo"], p["hi"])
    start = end - timedelta(weeks=weeks - 1)
    out = []
    for w in range(weeks):
        q = base + p["trend"] * w + p["amp"] * math.sin(2 * math.pi * w / 13.0) \
            + rng.normal(0, 0.3 * p["amp"])
        out.append((start + timedelta(weeks=w), round(max(0.0, q), 2)))
    return out


def extend_series(code: str, etype: str, history: list[tuple[date, float]], end: date,
                  seed: int) -> list[tuple[date, float]]:
    p = PROFILE[etype]
    rng = rng_for(seed + 1, code)
    series = list(history)
    out = []
    d = series[-1][0] + timedelta(weeks=1)
    while d <= end:
        ref = series[-13][1] if len(series) >= 13 else series[-1][1]
        q = round(max(0.0, ref + 13 * p["trend"] + rng.normal(0, 0.3 * p["amp"])), 2)
        series.append((d, q))
        out.append((d, q))
        d += timedelta(weeks=1)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--commit", action="store_true", help="write to the database (default: dry run)")
    ap.add_argument("--weeks", type=int, default=52, help="history length for new series (default 52)")
    ap.add_argument("--end-date", type=date.fromisoformat, default=None,
                    help="last week start (YYYY-MM-DD, default: last completed week's Monday)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--extend-existing", action="store_true",
                    help="append weeks after the last record of establishments that already have data")
    ap.add_argument("--catalog-names", action="store_true",
                    help="use the real business names from the catalog instead of generic names")
    ap.add_argument("--limit", type=int, default=None, help="only the first N catalog rows")
    args = ap.parse_args(argv)

    end = args.end_date or last_completed_week_start()
    if end > date.today():
        print("--end-date cannot be in the future.")
        return 2
    if not set(inspect(engine).get_table_names()) >= {"establishments", "wco_generation_records"}:
        print("Tables missing. Run `alembic upgrade head` first.")
        return 2
    if "data_source" not in {c["name"] for c in inspect(engine).get_columns("wco_generation_records")}:
        print("Database is behind the code. Run `alembic upgrade head` first.")
        return 2

    catalog = list(csv.DictReader(CATALOG.open(encoding="utf-8")))[: args.limit]
    note = f"SYNTHETIC demo data (scripts/load_demo_data.py, seed={args.seed})"
    print(f"Target database: {safe_url(str(engine.url))}")
    print(f"Mode: {'COMMIT' if args.commit else 'DRY RUN (nothing will be written)'}; "
          f"end week {end}; {args.weeks} weeks for new series; seed {args.seed}")

    db = SessionLocal()
    try:
        existing = {e.wco_code.lower(): e for e in db.scalars(select(Establishment)).all()}
        new_estabs = new_records = extended = untouched = 0
        for row in catalog:
            code, etype = row["wco_code"], row["type"]
            estab = existing.get(code.lower())
            if estab is None:
                name = (row["catalog_name"] if args.catalog_names
                        else f"{GENERIC[etype]} {code} — {row['barangay']}")
                lat, lng = float(row["latitude"]), float(row["longitude"])
                estab = Establishment(
                    wco_code=code, name=name, type=etype, barangay=row["barangay"],
                    address=f"{row['barangay']}, Batangas City (approximate location)",
                    latitude=lat, longitude=lng, geom=ST_SetSRID(ST_MakePoint(lng, lat), 4326),
                    consent_given=False, is_active=True, data_source="synthetic",
                )
                new_estabs += 1
                if args.commit:
                    db.add(estab)
                    db.flush()
                history: list[tuple[date, float]] = []
            else:
                if etype != estab.type:
                    etype = estab.type if estab.type in PROFILE else etype
                history = [(d, float(q)) for d, q in db.execute(
                    select(WCOGenerationRecord.week_date, WCOGenerationRecord.quantity_liters)
                    .where(WCOGenerationRecord.establishment_id == estab.id)
                    .order_by(WCOGenerationRecord.week_date)).all()]

            if not history:
                to_add = fresh_series(code, etype, args.weeks, end, args.seed)
            elif args.extend_existing and history[-1][0] < end:
                to_add = extend_series(code, etype, history, end, args.seed)
                extended += 1 if to_add else 0
            else:
                to_add = []
                untouched += 1
            new_records += len(to_add)
            if args.commit and to_add:
                have = {d for d, _ in history}
                db.add_all([WCOGenerationRecord(
                    establishment_id=estab.id, week_date=d, week_end_date=d + timedelta(days=6),
                    quantity_liters=q, data_source="synthetic", notes=note)
                    for d, q in to_add if d not in have])

        print(f"\nEstablishments to insert : {new_estabs}")
        print(f"Weekly records to insert : {new_records}")
        print(f"Series extended          : {extended}")
        print(f"Establishments unchanged : {untouched}")
        if not args.commit:
            print("\nDry run only. Re-run with --commit to write these rows.")
            return 0
        if new_estabs or new_records:
            log_action(db, "scripts/load_demo_data", None, "create", "wco_record",
                       details=f"demo loader: +{new_estabs} establishments, +{new_records} synthetic records "
                               f"(seed={args.seed}, end={end})")
            db.commit()
            from app.services.retraining import upsert_pending_job
            upsert_pending_job(db, trigger="automatic", reason="demo_data_loader")
            print("Committed. A retraining job was queued; the running API trains it within ~30 s.")
        else:
            print("Nothing to insert.")
        total = db.scalar(select(func.count(WCOGenerationRecord.id)))
        print(f"Total WCO records now: {total:,}")
        return 0
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
