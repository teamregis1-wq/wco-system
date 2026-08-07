"""Database engine, session factory, and the declarative Base.

Every model inherits from Base. Routes get a session via the get_db
dependency, which guarantees the session is closed after each request.
"""
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

from app.core.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,   # transparently reconnect dropped connections
    pool_size=3,          # Supabase session pooler allows few clients — stay small
    max_overflow=2,
    pool_recycle=900,     # retire idle connections after 15 min
    pool_timeout=20,      # fail fast instead of hanging when pool is exhausted
    connect_args={"connect_timeout": 10},
    echo=False,           # set True to see every SQL statement while learning
)

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
