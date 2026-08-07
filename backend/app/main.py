"""FastAPI application entry point.

Run locally with:  uvicorn app.main:app --reload
Then open http://localhost:8000/docs for interactive API documentation.
"""
import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import analysis, auth, establishments, forecast, gis, quality_tests, wco
from app.routers import biodiesel_router as biodiesel

app = FastAPI(title=settings.project_name)


@app.on_event("startup")
def warm_db_pool() -> None:
    """Prime a database connection in the background so the first user
    request (usually a login) doesn't pay the connection-setup cost.
    Runs in a thread so a slow/unreachable database never blocks boot."""
    def _warm() -> None:
        try:
            from sqlalchemy import text
            from app.core.database import engine
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:
            pass  # DB down — requests will surface the error with their own timeout

    threading.Thread(target=_warm, daemon=True).start()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

prefix = settings.api_v1_prefix
app.include_router(auth.router, prefix=prefix)
app.include_router(establishments.router, prefix=prefix)
app.include_router(forecast.router, prefix=prefix)
app.include_router(gis.router, prefix=prefix)
app.include_router(analysis.router, prefix=prefix)
app.include_router(wco.router, prefix=prefix)
app.include_router(quality_tests.router, prefix=prefix)
app.include_router(biodiesel.router, prefix=prefix)


@app.get("/health", tags=["health"])
def health():
    """Simple liveness check. Hit this first to confirm the server is up."""
    return {"status": "ok", "service": settings.project_name}


@app.get("/")
def root():
    return {
        "message": "WCO Predictive Mapping API",
        "docs": "/docs",
        "health": "/health",
    }
