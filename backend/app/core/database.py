"""Database engine, session factory, and the declarative Base.

Every model inherits from Base. Routes get a session via the get_db
dependency, which guarantees the session is closed after each request.
"""
import logging
import os
from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

logger = logging.getLogger("wco.db")


def safe_url(url: str) -> str:
    """Render a database URL with the password masked — safe for logs/errors."""
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return "<unparseable database URL>"


_LOCAL_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


def pg_connect_args(url: str) -> dict:
    """Psycopg 3 connection arguments for a PostgreSQL URL.

    * SSL is required for non-local hosts unless the URL sets ``sslmode``.
    * Supabase's Transaction pooler (port 6543, PgBouncer/Supavisor transaction
      mode) cannot keep prepared statements between transactions, so
      Psycopg's automatic statement preparation is disabled there.
    """
    u = make_url(url)
    args: dict = {"connect_timeout": 10, "application_name": "wco-atlas-api"}
    if (u.host or "") not in _LOCAL_HOSTS and "sslmode" not in u.query:
        args["sslmode"] = settings.db_sslmode
    if u.port == 6543:
        args["prepare_threshold"] = None
    return args


def build_engine(url: str) -> Engine:
    """Create an engine with pool settings appropriate for the dialect."""
    if url.startswith("sqlite"):
        # Used by the automated tests; not a supported production backend.
        from sqlalchemy.pool import StaticPool
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if ":memory:" in url or url.rstrip("/") == "sqlite:":
            kwargs["poolclass"] = StaticPool
        return create_engine(url, **kwargs)
    return create_engine(
        url,
        pool_pre_ping=True,   # transparently reconnect dropped connections
        pool_size=settings.db_pool_size,        # each process/instance has its own pool — stay small
        max_overflow=settings.db_max_overflow,
        pool_recycle=900,     # retire idle connections after 15 min
        pool_timeout=20,      # fail fast instead of hanging when pool is exhausted
        connect_args=pg_connect_args(url),
        echo=False,           # set True to see every SQL statement while learning
    )


def active_database_url() -> str:
    """The worker process uses WORKER_DATABASE_URL when set; everything else DATABASE_URL."""
    if os.environ.get("WCO_PROCESS_ROLE") == "worker" and settings.worker_database_url:
        return settings.worker_database_url
    return settings.database_url


engine = build_engine(active_database_url())

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Base class for all ORM models."""
    pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a DB session and always closes it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database(bind: Engine | None = None) -> dict:
    """Connectivity + PostGIS + migration status. Never includes credentials.

    Returns a dict like::

        {"database": "ok", "dialect": "postgresql", "server_version": "15.8",
         "postgis": "3.3.2", "migration_revision": "b7c8...", "migration_head": "b7c8...",
         "migrations_up_to_date": True}
    """
    bind = bind or engine
    result: dict = {"database": "unavailable", "dialect": bind.dialect.name}
    try:
        with bind.connect() as conn:
            conn.execute(text("SELECT 1"))
            result["database"] = "ok"
            if bind.dialect.name == "postgresql":
                result["server_version"] = conn.execute(text("SHOW server_version")).scalar()
                result["postgis"] = conn.execute(text(
                    "SELECT extversion FROM pg_extension WHERE extname = 'postgis'"
                )).scalar()
            try:
                result["migration_revision"] = conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar()
            except Exception:
                result["migration_revision"] = None
    except Exception as exc:  # pragma: no cover - exercised against real outages
        # Log the exception class only; driver messages can echo the host/user.
        logger.error("Database check failed (%s) for %s", type(exc).__name__, safe_url(str(bind.url)))
        result["error"] = type(exc).__name__
        return result

    try:
        from pathlib import Path

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        ini = Path(__file__).resolve().parents[2] / "alembic.ini"
        cfg = Config(str(ini))
        cfg.set_main_option("script_location", str(ini.parent / "alembic"))
        head = ScriptDirectory.from_config(cfg).get_current_head()
        result["migration_head"] = head
        result["migrations_up_to_date"] = result.get("migration_revision") == head
    except Exception:
        result["migration_head"] = None
    return result
