"""FastAPI application entry point.

Run locally with:  uvicorn app.main:app --reload
Then open http://localhost:8000/docs for interactive API documentation.
"""
import logging
import threading

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.routers import analysis, auth, establishments, forecast, gis, quality_tests, wco

logger = logging.getLogger("wco")

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


class ErrorEnvelopeMiddleware(BaseHTTPMiddleware):
    """Return unhandled errors as JSON instead of a bare 500.

    Starlette's default 500 handler sits *outside* CORSMiddleware, so its
    response carries no CORS headers — the browser then blocks it and the
    frontend sees a network failure ("cannot reach the server") rather than the
    real cause. Catching here, inside the CORS layer, means the error response
    is decorated normally and the UI can show what actually went wrong.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except OperationalError:
            logger.exception("Database unavailable during %s %s", request.method, request.url.path)
            return JSONResponse(
                status_code=503,
                content={"detail": "Database unavailable. Check the database connection and try again."},
            )
        except SQLAlchemyError:
            logger.exception("Database error during %s %s", request.method, request.url.path)
            return JSONResponse(status_code=500, content={"detail": "A database error occurred."})
        except Exception:
            logger.exception("Unhandled error during %s %s", request.method, request.url.path)
            return JSONResponse(status_code=500, content={"detail": "Internal server error."})


# Registration order matters: Starlette treats the LAST-added middleware as the
# outermost layer, so CORS must be added after the error handler to wrap it.
app.add_middleware(ErrorEnvelopeMiddleware)
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
