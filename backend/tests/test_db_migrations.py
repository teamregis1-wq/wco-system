"""Database configuration, migrations, and model/migration consistency."""
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from geoalchemy2 import alembic_helpers
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.pool import StaticPool

from app.core.config import normalize_database_url
from app.core.database import Base, check_database, safe_url
from conftest import install_spatial_stubs

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _reset_geoalchemy_registry():
    # geoalchemy2.alembic_helpers keeps a module-global set of "spatial tables"
    # and compiles DROP TABLE for them into SpatiaLite calls on every SQLite
    # engine. Reset it so migration tests don't leak into other tests.
    alembic_helpers._SPATIAL_TABLES.clear()
    yield
    alembic_helpers._SPATIAL_TABLES.clear()


def _engine():
    eng = create_engine("sqlite://", poolclass=StaticPool,
                        connect_args={"check_same_thread": False})
    event.listen(eng, "connect", install_spatial_stubs)
    # Minimal SpatiaLite metadata so GeoAlchemy can reflect the geometry
    # columns when Alembic batch mode rebuilds a table.
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE geometry_columns (f_table_name TEXT, f_geometry_column TEXT, "
            "geometry_type INTEGER, coord_dimension INTEGER, srid INTEGER, "
            "spatial_index_enabled INTEGER)"))
        conn.execute(text(
            "INSERT INTO geometry_columns VALUES "
            "('establishments','geom',1,2,4326,1), ('candidate_sites','geom',1,2,4326,1), "
            "('road_network','geom',2,2,4326,1)"))
    return eng


def _alembic(conn) -> Config:
    cfg = Config()   # no ini file → env.py leaves logging configuration alone
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.attributes["connection"] = conn
    return cfg


def test_single_linear_migration_head():
    cfg = Config()
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert heads == ["c9d0e1f2a3b4"]


def test_upgrade_head_matches_models():
    eng = _engine()
    with eng.begin() as conn:
        command.upgrade(_alembic(conn), "head")
    with eng.connect() as conn:
        tables = set(inspect(conn).get_table_names())
        assert {"model_training_jobs", "model_versions", "wco_generation_records"} <= tables
        mc = MigrationContext.configure(conn, opts={
            "include_object": alembic_helpers.include_object, "compare_type": False})
        diff = compare_metadata(mc, Base.metadata)
    # SQLite cannot reflect everything PostgreSQL has; ignore spatial-index noise.
    meaningful = [d for d in diff if not (isinstance(d, tuple) and "idx_" in str(d))]
    assert meaningful == [], meaningful


def test_unique_constraint_exists_after_migration():
    eng = _engine()
    with eng.begin() as conn:
        command.upgrade(_alembic(conn), "head")
    with eng.connect() as conn:
        uqs = inspect(conn).get_unique_constraints("wco_generation_records")
        assert any(set(u["column_names"]) == {"establishment_id", "week_date"} for u in uqs)


def test_migration_aborts_on_existing_duplicates_without_changing_data():
    eng = _engine()
    with eng.begin() as conn:
        command.upgrade(_alembic(conn), "f2b3c4d5e6a7")
        conn.execute(text(
            "INSERT INTO establishments (id, wco_code, name, type, latitude, longitude, "
            "consent_given, is_active, created_at) VALUES "
            "(1, 'X1', 'X', 'restaurant', 13.75, 121.05, 0, 1, '2026-01-01')"))
        for q in (10.0, 11.0):
            conn.execute(text(
                "INSERT INTO wco_generation_records (establishment_id, week_date, quantity_liters, created_at) "
                "VALUES (1, '2026-01-05', :q, '2026-01-06')"), {"q": q})
    with pytest.raises(RuntimeError, match="duplicate"):
        with eng.begin() as conn:
            command.upgrade(_alembic(conn), "head")
    with eng.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM wco_generation_records")).scalar() == 2
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "f2b3c4d5e6a7"


def test_downgrade_then_upgrade_roundtrip():
    eng = _engine()
    with eng.begin() as conn:
        cfg = _alembic(conn)
        command.upgrade(cfg, "head")
        command.downgrade(cfg, "f2b3c4d5e6a7")
        assert "model_versions" not in inspect(conn).get_table_names()
        command.upgrade(cfg, "head")
        assert "model_versions" in inspect(conn).get_table_names()


@pytest.mark.parametrize("raw,expected", [
    ("postgresql://u:p@h:5432/db", "postgresql+psycopg://u:p@h:5432/db"),
    ("postgres://u:p@h:5432/db", "postgresql+psycopg://u:p@h:5432/db"),
    ("postgresql+psycopg://u:p@h/db", "postgresql+psycopg://u:p@h/db"),
    (" sqlite:// ", "sqlite://"),
])
def test_database_url_normalization(raw, expected):
    assert normalize_database_url(raw) == expected


def test_safe_url_masks_password():
    masked = safe_url("postgresql+psycopg://postgres.ref:S3cr%40t!@aws-0.pooler.supabase.com:5432/postgres")
    assert "S3cr" not in masked and "***" in masked


def test_check_database_reports_status_without_credentials():
    eng = _engine()
    with eng.begin() as conn:
        command.upgrade(_alembic(conn), "head")
    status = check_database(eng)
    assert status["database"] == "ok" and status["migrations_up_to_date"] is True
    assert "password" not in str(status).lower()


def test_health_endpoints(client):
    assert client.get("/health").json()["status"] == "ok"
    r = client.get("/health/db")
    # The test DB is built with create_all (no alembic_version row) → not "up to date".
    assert r.status_code in (200, 503)
    assert r.json()["database"] == "ok"


@pytest.mark.parametrize("url,expect_ssl,expect_noprep", [
    ("postgresql+psycopg://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres", True, False),
    ("postgresql+psycopg://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres", True, True),
    ("postgresql+psycopg://u:p@localhost:5432/postgres", False, False),
    ("postgresql+psycopg://u:p@db.example.com:5432/postgres?sslmode=verify-full", False, False),
])
def test_pg_connect_args(url, expect_ssl, expect_noprep):
    from app.core.database import pg_connect_args
    args = pg_connect_args(url)
    assert ("sslmode" in args) is expect_ssl
    if expect_ssl:
        assert args["sslmode"] == "require"
    assert ("prepare_threshold" in args and args["prepare_threshold"] is None) is expect_noprep
