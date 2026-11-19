"""Shared test fixtures.

Default: an in-memory SQLite database (no network or credentials). PostGIS
functions used by GeoAlchemy are replaced by small stand-ins that produce
valid EWKB points.

PostgreSQL mode: set TEST_DATABASE_URL (Session pooler or direct connection)
to run the WHOLE suite against real PostgreSQL + PostGIS. Every test table is
created inside a separate schema (WCO_TEST_SCHEMA, default "wco_test") via
search_path, truncated between tests, and the schema is dropped at the end —
the application's tables in "public" are never touched. The schema name
"public" is refused.
"""
import os
import struct
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

# ── Environment must be set before any app module is imported ────────────────
_ARTIFACTS = tempfile.mkdtemp(prefix="wco-test-artifacts-")
PG_URL = os.environ.get("TEST_DATABASE_URL", "").strip()
PG_SCHEMA = os.environ.get("WCO_TEST_SCHEMA", "wco_test").strip()
if PG_URL and (PG_SCHEMA.lower() == "public" or not PG_SCHEMA.isidentifier()):
    raise SystemExit("WCO_TEST_SCHEMA must be a plain identifier other than 'public'.")
os.environ.update({
    "DATABASE_URL": PG_URL or "sqlite://",
    "JWT_SECRET": "test-secret-" + "x" * 40,
    "APP_ENV": "test",
    "AUTO_RETRAIN_ENABLED": "true",
    # Long debounce so background timers never fire mid-test; tests drive the
    # scheduler explicitly with run_pending_now().
    "RETRAIN_DEBOUNCE_SECONDS": "3600",
    "MODEL_ARTIFACT_DIR": _ARTIFACTS,
    "ML_MAX_EPOCHS": "4",
    "ML_PATIENCE": "2",
    "CORS_ORIGINS": "http://localhost:3000",
    "ML_BUNDLED_FALLBACK": "false",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import math  # noqa: E402

import pytest  # noqa: E402
from sqlalchemy import event  # noqa: E402

from app.core import database  # noqa: E402


# ── SQLite stand-ins for the PostGIS functions GeoAlchemy calls ──────────────

def _ewkb(x, y, srid=None) -> bytes:
    if srid is None:
        return struct.pack("<BIdd", 1, 1, x, y)
    return struct.pack("<BIIdd", 1, 0x20000001, srid, x, y)


def _xy(b: bytes):
    t = struct.unpack("<I", b[1:5])[0]
    return struct.unpack("<dd", b[9:25] if t & 0x20000000 else b[5:21])


def install_spatial_stubs(dbapi_conn, _record=None):
    for name, nargs in [("RecoverGeometryColumn", 5), ("CreateSpatialIndex", 2),
                        ("DisableSpatialIndex", 2), ("DiscardGeometryColumn", 2),
                        ("CheckSpatialIndex", 2), ("InitSpatialMetaData", 1)]:
        dbapi_conn.create_function(name, nargs, lambda *a: 1)
    dbapi_conn.create_function("ST_MakePoint", 2, lambda x, y: _ewkb(x, y))
    dbapi_conn.create_function(
        "ST_SetSRID", 2, lambda g, s: None if g is None else _ewkb(*_xy(g), s))
    dbapi_conn.create_function("ST_GeomFromEWKT", 1, lambda t: t)
    dbapi_conn.create_function("GeomFromEWKT", 1, lambda t: t)
    dbapi_conn.create_function("AsEWKB", 1, lambda g: g)
    dbapi_conn.create_function("ST_AsEWKB", 1, lambda g: g)
    dbapi_conn.execute("PRAGMA foreign_keys=ON")


def _pg_search_path(dbapi_conn, _record=None):
    # Tables are created unqualified, so they land in the first search_path
    # schema (the throwaway test schema). PostGIS stays reachable via public/extensions.
    cur = dbapi_conn.cursor()
    cur.execute(f"SET search_path TO {PG_SCHEMA}, public, extensions")
    cur.close()
    dbapi_conn.commit()


if PG_URL:
    from sqlalchemy import create_engine, text as _text
    _admin = create_engine(database.engine.url, poolclass=__import__("sqlalchemy.pool", fromlist=["NullPool"]).NullPool,
                           connect_args=database.pg_connect_args(str(database.engine.url)))
    with _admin.begin() as _c:
        _c.execute(_text(f"CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}"))
    event.listen(database.engine, "connect", _pg_search_path)
else:
    event.listen(database.engine, "connect", install_spatial_stubs)

import app.models  # noqa: E402,F401
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.core.security import create_access_token, hash_password  # noqa: E402
from app.models import Establishment, User, WCOGenerationRecord  # noqa: E402
from app.services import model_store, retraining  # noqa: E402
from app.services.retraining import RetrainingScheduler  # noqa: E402

if PG_URL:
    # Never contend with a real retraining worker on the same database.
    retraining.ADVISORY_LOCK_KEY = retraining.ADVISORY_LOCK_KEY + 777


@pytest.fixture(scope="session", autouse=True)
def _pg_schema_lifecycle():
    if not PG_URL:
        yield
        return
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    engine.dispose()
    with _admin.begin() as c:
        c.execute(_text(f"DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"))
    _admin.dispose()


def _reset_tables():
    if PG_URL:
        names = ", ".join(t.name for t in Base.metadata.sorted_tables)
        with engine.begin() as c:
            c.execute(_text(f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE"))
    else:
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)


@pytest.fixture(autouse=True)
def fresh_db():
    _reset_tables()
    model_store.invalidate_cache()
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=3600)
    retraining.set_scheduler(sched)
    from app.core.cache import invalidate_gis_cache
    invalidate_gis_cache()
    yield
    sched.shutdown()
    retraining.set_scheduler(None)
    model_store.invalidate_cache()


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def scheduler():
    return retraining.get_scheduler()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app
    # Do not run startup hooks (they spawn threads); tests set up state directly.
    return TestClient(app)


def _make_user(role: str) -> tuple[int, str]:
    with SessionLocal() as s:
        u = User(email=f"{role}@test.local", full_name=role.title(),
                 hashed_password=hash_password("password123"), role=role)
        s.add(u)
        s.commit()
        return u.id, create_access_token(user_id=u.id, role=role)


@pytest.fixture
def admin_headers():
    _, tok = _make_user("admin")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def researcher_headers():
    _, tok = _make_user("researcher")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def viewer_headers():
    _, tok = _make_user("viewer")
    return {"Authorization": f"Bearer {tok}"}


# ── Synthetic data helpers ───────────────────────────────────────────────────

def make_establishment(db, code="RS001", lat=13.7565, lng=121.0583, active=True,
                       etype="restaurant") -> Establishment:
    from geoalchemy2.functions import ST_MakePoint, ST_SetSRID
    e = Establishment(wco_code=code, name=f"Test {code}", type=etype, latitude=lat,
                      longitude=lng, consent_given=False, is_active=active,
                      data_source="synthetic")
    e.geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def synthetic_value(base: float, w: int, seed: int) -> float:
    # Deterministic trend + 13-week seasonality + small pseudo-noise.
    return round(base + 0.15 * w + 8 * math.sin(2 * math.pi * w / 13.0)
                 + ((seed * 7919 + w * 104729) % 100 - 50) / 25.0, 2)


def seed_series(db, n_estab=6, weeks=40, end: date | None = None) -> list[Establishment]:
    """n_estab establishments × `weeks` consecutive weekly records ending at `end`."""
    end = end or (date.today() - timedelta(days=date.today().weekday() + 7))
    start = end - timedelta(weeks=weeks - 1)
    estabs = []
    for k in range(n_estab):
        e = make_establishment(db, code=f"T{k:03d}", lat=13.75 + 0.004 * k, lng=121.05 + 0.004 * k)
        base = 20 + 12 * k
        for w in range(weeks):
            db.add(WCOGenerationRecord(establishment_id=e.id, week_date=start + timedelta(weeks=w),
                                       quantity_liters=synthetic_value(base, w, k),
                                       data_source="synthetic"))
        estabs.append(e)
    db.commit()
    return estabs


@pytest.fixture
def seeded(db):
    return seed_series(db)
