"""FastAPI application entry point.

Run locally with:  uvicorn app.main:app --reload
Then open http://localhost:8000/docs for interactive API documentation.
"""
import logging
import math
import threading

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.core.database import check_database, engine, safe_url
from app.routers import analysis, auth, establishments, forecast, gis, quality_tests, wco

logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("wco")

# API docs live under /api so they are reachable through the same public
# /api/* route as the rest of the backend when deployed behind Vercel Services.
app = FastAPI(title=settings.project_name, docs_url="/api/docs",
              redoc_url=None, openapi_url="/api/openapi.json")


def _json_safe(obj):
    """Replace NaN/±Infinity (not representable in JSON) with strings."""
    if isinstance(obj, float) and not math.isfinite(obj):
        return str(obj)
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    # FastAPI's default handler echoes the rejected input; a rejected NaN or
    # Infinity then crashes JSON encoding and the client gets a 500 instead
    # of the 422 that explains the problem.
    return JSONResponse(status_code=422,
                        content={"detail": _json_safe(jsonable_encoder(exc.errors()))})


@app.on_event("startup")
def on_startup() -> None:
    """Warm the DB pool and recover retraining state, in the background.

    Runs in a thread so a slow/unreachable database never blocks boot.
    Recovery marks jobs orphaned by a previous crash as failed (the previous
    model stays active) and re-arms any pending retraining job.
    """
    logger.info("Database: %s", safe_url(settings.database_url))

    def _warm_and_recover() -> None:
        status = check_database()
        if status.get("database") != "ok":
            logger.error("Database unavailable at startup (%s). Requests will return 503 "
                         "until it is reachable.", status.get("error"))
            return
        if status.get("dialect") == "postgresql" and not status.get("postgis"):
            logger.error("PostGIS extension is not installed — run: CREATE EXTENSION postgis;")
        if status.get("migrations_up_to_date") is False:
            logger.error("Database schema is at %s but code expects %s — run `alembic upgrade head`.",
                         status.get("migration_revision"), status.get("migration_head"))
            return
        from app.services.retraining import get_scheduler
        logger.info("Retraining executor: %s", settings.effective_retrain_executor)
        get_scheduler().start()   # no-op in "worker" mode (the worker process owns execution)

    threading.Thread(target=_warm_and_recover, daemon=True).start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    from app.services.retraining import get_scheduler
    get_scheduler().shutdown()


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
        except IntegrityError:
            logger.warning("Integrity error during %s %s", request.method, request.url.path)
            return JSONResponse(
                status_code=409,
                content={"detail": "The change conflicts with existing data (duplicate or invalid reference)."},
            )
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
    # The frontend sends a bearer token header, not cookies, so credentialed
    # CORS is unnecessary; keeping it off means a misconfigured "*" origin can
    # never expose authenticated responses.
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Forecast-Included", "X-Forecast-Skipped", "X-Model-Version"],
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
@app.get(f"{settings.api_v1_prefix}/health", tags=["health"], include_in_schema=False)
def health():
    """Simple liveness check. Hit this first to confirm the server is up."""
    return {"status": "ok", "service": settings.project_name}


@app.get("/health/db", tags=["health"])
@app.get(f"{settings.api_v1_prefix}/health/db", tags=["health"], include_in_schema=False)
def health_db():
    """Readiness: database reachable, PostGIS installed, migrations current.

    Never includes the connection string or credentials.
    """
    status = check_database(engine)
    ok = (status.get("database") == "ok"
          and (status.get("dialect") != "postgresql" or bool(status.get("postgis")))
          and status.get("migrations_up_to_date") is not False)
    return JSONResponse(status_code=200 if ok else 503, content={"ready": ok, **status})


@app.get("/")
def root():
    return {
        "message": "WCO Predictive Mapping API",
        "docs": "/api/docs",
        "health": "/health",
    }
