"""Read-only database health check ("doctor") for a Supabase/PostGIS project.

    cd backend
    ./venv/bin/python -m scripts.check_db

Never writes, never prints the password. Checks:
  1. connectivity (and which host/user, password masked)
  2. PostGIS installed + a spatial round-trip
  3. Alembic revision vs. the code's head
  4. row counts per table
  5. RLS enabled on application tables (blocks Supabase's auto REST API)
  6. data that would block migration b7c8d9e0f1a2 (duplicates, bad values)
  7. establishments.geom consistent with latitude/longitude
  8. PostGIS cross-check of the Gi* distance band (geodesic vs. projected)
Exit code 0 = all good, 1 = problems found, 2 = cannot connect.
"""
from __future__ import annotations

import sys

from sqlalchemy import inspect, text

from app.core.database import check_database, engine, safe_url

APP_TABLES = [
    "users", "establishments", "wco_generation_records", "wco_quality_tests", "audit_logs",
    "saved_routes", "forecast_runs", "forecast_results", "hotspot_scores", "candidate_sites",
    "road_network", "route_results", "simulation_runs", "optimization_results",
    "model_training_jobs", "model_versions", "retraining_workers",
]


def main() -> int:
    problems = 0

    def ok(msg):
        print(f"  [ok]   {msg}")

    def bad(msg):
        nonlocal problems
        problems += 1
        print(f"  [FAIL] {msg}")

    def info(msg):
        print(f"  [info] {msg}")

    print(f"Database: {safe_url(str(engine.url))}")
    status = check_database(engine)
    print("\n1. Connectivity")
    if status["database"] != "ok":
        bad(f"cannot connect ({status.get('error')}). Check DATABASE_URL, that the Supabase "
            "project is not paused, and that you use the Session pooler host.")
        return 2
    ok(f"connected ({status['dialect']} {status.get('server_version', '')})")
    is_pg = status["dialect"] == "postgresql"

    with engine.connect() as c:
        print("\n2. PostGIS")
        if not is_pg:
            info("not PostgreSQL — skipping PostGIS checks")
        elif not status.get("postgis"):
            bad("PostGIS not installed. In the Supabase SQL editor run: CREATE EXTENSION IF NOT EXISTS postgis;")
        else:
            wkt = c.execute(text("SELECT ST_AsText(ST_SetSRID(ST_MakePoint(121.0583, 13.7565), 4326))")).scalar()
            ok(f"PostGIS {status['postgis']} — round-trip {wkt}")

        print("\n3. Migrations")
        rev, head = status.get("migration_revision"), status.get("migration_head")
        if rev == head:
            ok(f"schema at head ({head})")
        else:
            bad(f"schema at {rev}, code expects {head}. Back up, then run: ./venv/bin/alembic upgrade head")

        print("\n4. Row counts")
        tables = set(inspect(c).get_table_names())
        for t in APP_TABLES:
            if t in tables:
                info(f"{t:24s} {c.execute(text(f'SELECT COUNT(*) FROM {t}')).scalar():>8,}")
            elif t in ("model_training_jobs", "model_versions"):
                info(f"{t:24s} (missing — created by migration b7c8d9e0f1a2)")
            elif t == "retraining_workers":
                info(f"{t:24s} (missing — created by migration c9d0e1f2a3b4)")
            else:
                bad(f"table {t} missing")

        if is_pg:
            print("\n5. Row Level Security")
            rows = c.execute(text(
                "SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace "
                "WHERE n.nspname = 'public' AND relkind = 'r'")).all()
            off = sorted(r[0] for r in rows if not r[1] and r[0] in APP_TABLES)
            present = {r[0] for r in rows} & set(APP_TABLES)
            if not present:
                info("no application tables yet (run migrations)")
            elif off:
                bad(f"RLS disabled on: {', '.join(off)} (readable via Supabase REST with the anon key)")
            else:
                ok("RLS enabled on all application tables")

        print("\n6. Data quality (would block the constraint migration)")
        if "wco_generation_records" in tables:
            dup = c.execute(text(
                "SELECT COUNT(*) FROM (SELECT establishment_id, week_date FROM wco_generation_records "
                "GROUP BY 1, 2 HAVING COUNT(*) > 1) d")).scalar()
            badq = c.execute(text(
                "SELECT COUNT(*) FROM wco_generation_records "
                "WHERE NOT (quantity_liters >= 0 AND quantity_liters <= 10000)")).scalar()
            (ok if not dup else bad)(f"{dup} duplicate (establishment, week) pairs")
            (ok if not badq else bad)(f"{badq} quantities outside [0, 10000] L or NaN/Infinity")
            if "data_source" in {col["name"] for col in inspect(c).get_columns("wco_generation_records")}:
                for src, n in c.execute(text(
                        "SELECT data_source, COUNT(*) FROM wco_generation_records GROUP BY 1")).all():
                    info(f"data_source={src}: {n:,} records")
            rng = c.execute(text("SELECT MIN(week_date), MAX(week_date) FROM wco_generation_records")).first()
            info(f"week range {rng[0]} → {rng[1]}")

        if is_pg and "establishments" in tables:
            print("\n7. Geometry consistency")
            mism = c.execute(text(
                "SELECT COUNT(*) FROM establishments WHERE geom IS NULL OR "
                "abs(ST_X(geom) - longitude) > 1e-7 OR abs(ST_Y(geom) - latitude) > 1e-7 "
                "OR ST_SRID(geom) <> 4326")).scalar()
            (ok if not mism else bad)(f"{mism} establishments whose geom disagrees with lat/lng (or is NULL)")

            print("\n8. Gi* distance band cross-check (PostGIS geodesic vs. app projection)")
            try:
                from app.routers.gis import _WEIGHT_BAND_M, _weight_matrix
                import numpy as np
                rows = c.execute(text(
                    "SELECT id, latitude, longitude FROM establishments WHERE is_active ORDER BY id")).all()
                if len(rows) >= 2:
                    pg_counts = dict(c.execute(text(
                        "SELECT a.id, COUNT(b.id) FROM establishments a JOIN establishments b "
                        "ON a.id <> b.id AND b.is_active AND "
                        "ST_DWithin(a.geom::geography, b.geom::geography, :band) "
                        "WHERE a.is_active GROUP BY a.id"), {"band": _WEIGHT_BAND_M}).all())
                    W = _weight_matrix(np.array([r[1] for r in rows]), np.array([r[2] for r in rows]),
                                       _WEIGHT_BAND_M)
                    app_counts = {r[0]: int(W[i].sum() - 1) for i, r in enumerate(rows)}
                    diff = sum(abs(app_counts[k] - pg_counts.get(k, 0)) for k in app_counts)
                    pairs = sum(app_counts.values())
                    (ok if diff <= max(2, pairs * 0.01) else bad)(
                        f"neighbour pairs within {_WEIGHT_BAND_M:.0f} m: app={pairs}, PostGIS="
                        f"{sum(pg_counts.values())}, differing={diff}")
            except Exception as e:  # pragma: no cover
                info(f"skipped ({type(e).__name__})")

    print(f"\n{'All checks passed.' if not problems else f'{problems} problem(s) found.'}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
