"""Application configuration loaded from environment variables.

All settings come from a .env file (see backend/.env.example). Never hardcode
secrets here. pydantic-settings validates and types every value at startup,
so a missing or malformed variable fails loudly instead of silently.
"""
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Placeholder values that must never be accepted as a real signing secret.
# The first one was the hardcoded default in earlier versions of this file and
# is public in the repository history, so any token signed with it is forgeable.
_KNOWN_INSECURE_SECRETS = {
    "CHANGE_ME_dev_only_secret",
    "change-me",
    "changeme",
    "secret",
    "<generate-a-random-64-char-hex-string>",
}


def normalize_database_url(url: str) -> str:
    """Make Supabase-style URLs use the installed Psycopg 3 driver.

    Supabase's dashboard hands out ``postgresql://...`` (and some tools emit
    ``postgres://...``). SQLAlchemy maps both to psycopg2, which is not
    installed, so rewrite them to ``postgresql+psycopg://``.
    """
    url = url.strip()
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", protected_namespaces=("settings_",)
    )

    # --- Environment ---
    # "development" | "production" | "test". Only affects log verbosity and
    # a few safety messages; security checks apply in every environment.
    app_env: str = "development"

    # --- Database ---
    # Supabase connection string (Session pooler recommended). Format:
    # postgresql+psycopg://postgres.<ref>:<password>@<host>:5432/postgres
    database_url: str

    # --- Auth ---
    # REQUIRED. Generate with: python -c "import secrets; print(secrets.token_hex(32))"
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 1 day
    # Public self-registration always creates *viewer* accounts. Set to false
    # to disable self-registration entirely (admins can still create users).
    allow_public_registration: bool = True

    # --- App ---
    project_name: str = "WCO Predictive Mapping System"
    api_v1_prefix: str = "/api/v1"

    # Comma-separated list of allowed frontend origins for CORS.
    # In production set this to your Vercel URL.
    cors_origins: str = "http://localhost:3000"

    # Center of the map (Batangas City, Batangas).
    map_center_lat: float = 13.7565
    map_center_lng: float = 121.0583

    # Study-area bounding box used to validate establishment coordinates.
    # Generous on purpose: it includes Verde Island (part of Batangas City)
    # and rejects swapped lat/lng, which would land in another country.
    study_area_lat_min: float = 13.2
    study_area_lat_max: float = 14.4
    study_area_lng_min: float = 120.3
    study_area_lng_max: float = 121.8

    # --- Data provenance ---
    # Applied to new WCO records / establishments that don't state a source.
    # For the final defense (synthetic dataset) set DEFAULT_DATA_SOURCE=synthetic.
    default_data_source: str = "unspecified"

    # --- Forecasting / automatic batch retraining ---
    auto_retrain_enabled: bool = True
    # Rapid edits within this window are coalesced into ONE retraining job.
    retrain_debounce_seconds: float = 20.0
    # How often each worker checks the database for a pending job it did not
    # schedule itself (queued by another worker or by a script). 0 = off.
    retrain_poll_seconds: float = 30.0
    # Local directory for model artifact files (a cache; the database holds
    # the durable copy). Empty = app/services/model_artifacts.
    model_artifact_dir: str = ""
    ml_random_seed: int = 42
    ml_max_epochs: int = 80
    ml_patience: int = 8
    # Chronological split (calendar weeks, counted back from the latest record):
    # the last ML_TEST_WEEKS are held out for evaluation; the ML_VAL_WEEKS
    # before them are used only for early stopping.
    ml_test_weeks: int = 16
    ml_val_weeks: int = 6
    # Minimum consecutive weekly records an establishment needs before the
    # API will produce a forecast for it (the LSTM input window is 12 weeks).
    ml_min_history_weeks: int = 12

    # --- Routing ---
    # The public OSRM demo server has a fair-use policy and no SLA; point this
    # at a self-hosted OSRM instance for anything beyond a demonstration.
    osrm_base_url: str = "https://router.project-osrm.org"
    osrm_timeout_seconds: float = 12.0
    # Average speed used to turn route distance into an estimated duration.
    route_avg_speed_kmh: float = 30.0

    @field_validator("database_url")
    @classmethod
    def _normalize_db_url(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("DATABASE_URL is empty. See backend/.env.example.")
        return normalize_database_url(v)

    @field_validator("jwt_secret")
    @classmethod
    def _require_strong_secret(cls, v: str) -> str:
        v = (v or "").strip()
        if v in _KNOWN_INSECURE_SECRETS or v.upper().startswith("CHANGE_ME"):
            raise ValueError(
                "JWT_SECRET is a known placeholder. Generate a real one with: "
                "python -c \"import secrets; print(secrets.token_hex(32))\""
            )
        if len(v) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters long.")
        return v

    @field_validator("default_data_source")
    @classmethod
    def _valid_source(cls, v: str) -> str:
        from app.core.constants import DATA_SOURCES
        if v not in DATA_SOURCES:
            raise ValueError(f"DEFAULT_DATA_SOURCE must be one of {sorted(DATA_SOURCES)}")
        return v

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
