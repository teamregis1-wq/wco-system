"""PostgreSQL / PostGIS integration tests — run only against a THROWAWAY database.

    TEST_DATABASE_URL=postgresql+psycopg://...  ./venv/bin/python -m pytest tests/test_postgres_integration.py

Safety: these tests run `alembic upgrade head` and write rows. They refuse to
run if the target database already contains any establishments or WCO
records, so they can never touch real data. Use a separate Supabase project
or a local PostGIS container, never the production project.
"""
import os

import pytest
from sqlalchemy import create_engine, inspect, text

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set (PostGIS integration tests skipped)")


@pytest.fixture(scope="module")
def pg():
    from app.core.config import normalize_database_url
    eng = create_engine(normalize_database_url(URL), pool_pre_ping=True)
    with eng.connect() as c:
        tables = set(inspect(c).get_table_names())
        for t in ("establishments", "wco_generation_records"):
            if t in tables and c.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar():
                pytest.skip(f"Refusing to run: {t} is not empty (use a throwaway database).")
    yield eng
    eng.dispose()


def test_postgis_available(pg):
    with pg.connect() as c:
        c.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        c.commit()
        assert c.execute(text("SELECT extversion FROM pg_extension WHERE extname='postgis'")).scalar()
        wkt = c.execute(text("SELECT ST_AsText(ST_SetSRID(ST_MakePoint(121.0583, 13.7565), 4326))")).scalar()
        assert wkt == "POINT(121.0583 13.7565)"


def test_migrations_and_constraints(pg):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    backend = Path(__file__).resolve().parents[1]
    with pg.begin() as conn:
        cfg = Config()
        cfg.set_main_option("script_location", str(backend / "alembic"))
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    with pg.connect() as c:
        rls = dict(c.execute(text(
            "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN "
            "('model_versions','model_training_jobs','wco_generation_records','users')")).all())
        assert all(rls.values()), rls
        checks = {r[0] for r in c.execute(text(
            "SELECT conname FROM pg_constraint WHERE conrelid = 'wco_generation_records'::regclass"))}
        assert {"uq_wco_records_estab_week", "ck_wco_records_quantity_range"} <= checks


def test_spatial_insert_and_distance(pg):
    with pg.begin() as c:
        c.execute(text(
            "INSERT INTO establishments (wco_code, name, type, latitude, longitude, geom, "
            "consent_given, is_active, created_at) VALUES "
            "('ZZ_TEST_1','t','restaurant',13.75,121.05, ST_SetSRID(ST_MakePoint(121.05,13.75),4326), false, true, now()),"
            "('ZZ_TEST_2','t','restaurant',13.76,121.05, ST_SetSRID(ST_MakePoint(121.05,13.76),4326), false, true, now())"))
        d = c.execute(text(
            "SELECT ST_Distance(a.geom::geography, b.geom::geography) FROM establishments a, establishments b "
            "WHERE a.wco_code='ZZ_TEST_1' AND b.wco_code='ZZ_TEST_2'")).scalar()
        assert 1_090 < d < 1_115          # 0.01° latitude ≈ 1.106 km
        with pytest.raises(Exception):
            c.execute(text("INSERT INTO wco_generation_records (establishment_id, week_date, quantity_liters, "
                           "created_at) SELECT id, '2026-01-05', 'NaN'::float8, now() FROM establishments "
                           "WHERE wco_code='ZZ_TEST_1'"))
        c.rollback()


def test_advisory_lock_is_exclusive(pg):
    from app.services.retraining import advisory_lock
    with advisory_lock(pg) as first:
        assert first
        with advisory_lock(pg) as second:
            assert not second
