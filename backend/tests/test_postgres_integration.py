"""Verify a real, migrated Supabase/PostgreSQL + PostGIS database — non-destructively.

    TEST_DATABASE_URL="postgresql+psycopg://…" ./venv/bin/python -m pytest tests/test_postgres_integration.py

These tests inspect the application's real ``public`` schema after
``alembic upgrade head``. They only read, or write inside a transaction that
is always rolled back, so they leave no rows behind. (The rest of the suite,
when TEST_DATABASE_URL is set, runs in a separate throwaway schema — see
conftest.py.) Optionally set TEST_TRANSACTION_POOLER_URL (port 6543) to check
the serverless connection settings.
"""
import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

URL = os.environ.get("TEST_DATABASE_URL")
TX_URL = os.environ.get("TEST_TRANSACTION_POOLER_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set (PostGIS integration tests skipped)")

APP_TABLES = {
    "users", "establishments", "wco_generation_records", "wco_quality_tests", "audit_logs",
    "saved_routes", "forecast_runs", "forecast_results", "hotspot_scores", "candidate_sites",
    "road_network", "route_results", "simulation_runs", "optimization_results",
    "model_training_jobs", "model_versions", "retraining_workers",
}


def _engine(url):
    from app.core.config import normalize_database_url
    from app.core.database import pg_connect_args
    u = normalize_database_url(url)
    return create_engine(u, poolclass=NullPool, connect_args=pg_connect_args(u))


@pytest.fixture(scope="module")
def pg():
    eng = _engine(URL)
    yield eng
    eng.dispose()


def test_connection_uses_ssl(pg):
    with pg.connect() as c:
        ssl = c.execute(text("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")).scalar()
    # Through Supavisor the backend connection may be internal; when visible it must be SSL.
    assert ssl in (True, None)


def test_postgis_installed_and_resolvable(pg):
    with pg.connect() as c:
        row = c.execute(text(
            "SELECT e.extversion, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace "
            "WHERE e.extname = 'postgis'")).first()
        assert row, "PostGIS is not installed (Database → Extensions → postgis)"
        wkt = c.execute(text("SELECT ST_AsText(ST_SetSRID(ST_MakePoint(121.0583, 13.7565), 4326))")).scalar()
        assert wkt == "POINT(121.0583 13.7565)"
        # The geometry type used by the tables must resolve through search_path.
        assert c.execute(text("SELECT 'SRID=4326;POINT(0 0)'::geometry IS NOT NULL")).scalar()


def test_schema_at_head_and_matches_models(pg):
    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from alembic.script import ScriptDirectory
    from geoalchemy2 import alembic_helpers

    import app.models  # noqa: F401
    from app.core.database import Base
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    head = ScriptDirectory.from_config(cfg).get_current_head()
    with pg.connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar() == head
        assert APP_TABLES <= set(inspect(c).get_table_names())
        mc = MigrationContext.configure(c, opts={"include_object": alembic_helpers.include_object,
                                                 "compare_type": False})
        diff = [d for d in compare_metadata(mc, Base.metadata)
                if "spatial_ref_sys" not in str(d) and "idx_" not in str(d)]
    assert diff == [], diff


def test_rls_enabled_on_all_application_tables(pg):
    with pg.connect() as c:
        rows = dict(c.execute(text(
            "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relkind = 'r'")).all())
    missing = sorted(t for t in APP_TABLES if not rows.get(t))
    assert missing == [], f"RLS disabled on: {missing}"


def test_integrity_constraints_present(pg):
    with pg.connect() as c:
        names = {r[0] for r in c.execute(text(
            "SELECT conname FROM pg_constraint WHERE conrelid IN "
            "('public.wco_generation_records'::regclass, 'public.establishments'::regclass)"))}
        idx = {r[0] for r in c.execute(text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"))}
    assert {"uq_wco_records_estab_week", "ck_wco_records_quantity_range",
            "ck_wco_records_week_end_after_start", "ck_wco_records_data_source",
            "ck_establishments_coordinates", "ck_establishments_data_source"} <= names
    assert {"uq_model_training_jobs_single_pending", "uq_model_versions_single_active",
            "idx_establishments_geom"} <= idx


def test_spatial_queries_and_constraints_rolled_back(pg):
    """Writes happen inside a transaction that is always rolled back."""
    with pg.connect() as c:
        tx = c.begin()
        try:
            c.execute(text(
                "INSERT INTO establishments (wco_code, name, type, latitude, longitude, geom, "
                "consent_given, is_active, created_at, data_source) VALUES "
                "('ZZTEST1','t','restaurant',13.75,121.05, ST_SetSRID(ST_MakePoint(121.05,13.75),4326), false, true, now(), 'synthetic'),"
                "('ZZTEST2','t','restaurant',13.76,121.05, ST_SetSRID(ST_MakePoint(121.05,13.76),4326), false, true, now(), 'synthetic')"))
            d = c.execute(text(
                "SELECT ST_Distance(a.geom::geography, b.geom::geography) FROM establishments a, establishments b "
                "WHERE a.wco_code='ZZTEST1' AND b.wco_code='ZZTEST2'")).scalar()
            assert 1_090 < d < 1_115                       # 0.01° latitude ≈ 1.106 km
            n = c.execute(text(
                "SELECT COUNT(*) FROM establishments a JOIN establishments b ON a.id <> b.id "
                "AND ST_DWithin(a.geom::geography, b.geom::geography, 1500) "
                "WHERE a.wco_code LIKE 'ZZTEST%' AND b.wco_code LIKE 'ZZTEST%'")).scalar()
            assert n == 2
            for bad in ("'NaN'::float8", "-1", "10001"):
                sp = c.begin_nested()
                with pytest.raises(Exception):
                    c.execute(text(
                        "INSERT INTO wco_generation_records (establishment_id, week_date, quantity_liters, "
                        f"created_at) SELECT id, DATE '2026-01-05', {bad}, now() FROM establishments "
                        "WHERE wco_code='ZZTEST1'"))
                sp.rollback()
            sp = c.begin_nested()
            c.execute(text("INSERT INTO wco_generation_records (establishment_id, week_date, quantity_liters, created_at) "
                           "SELECT id, DATE '2026-01-05', 10, now() FROM establishments WHERE wco_code='ZZTEST1'"))
            with pytest.raises(Exception):                 # duplicate establishment-week
                c.execute(text("INSERT INTO wco_generation_records (establishment_id, week_date, quantity_liters, created_at) "
                               "SELECT id, DATE '2026-01-05', 11, now() FROM establishments WHERE wco_code='ZZTEST1'"))
            sp.rollback()
        finally:
            tx.rollback()
    with pg.connect() as c:
        assert c.execute(text("SELECT COUNT(*) FROM establishments WHERE wco_code LIKE 'ZZTEST%'")).scalar() == 0


def test_advisory_lock_is_exclusive(pg):
    from app.services import retraining
    key = retraining.ADVISORY_LOCK_KEY + 4242          # never the live worker's key
    with pg.connect() as a, pg.connect() as b:
        assert a.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar()
        assert not b.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar()
        a.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


@pytest.mark.skipif(not TX_URL, reason="TEST_TRANSACTION_POOLER_URL not set")
def test_transaction_pooler_settings_work():
    """Serverless settings (port 6543): prepared statements disabled, repeated queries succeed."""
    eng = _engine(TX_URL)
    try:
        assert eng.url.port == 6543
        with eng.connect() as c:
            for _ in range(12):     # > psycopg's default prepare threshold (5)
                assert c.execute(text("SELECT COUNT(*) FROM establishments WHERE is_active = :a"),
                                 {"a": True}).scalar() >= 0
    finally:
        eng.dispose()
