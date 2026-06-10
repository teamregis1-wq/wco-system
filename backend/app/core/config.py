"""Application configuration loaded from environment variables.

All settings come from a .env file (see .env.example). Never hardcode
secrets here. pydantic-settings validates and types every value at startup,
so a missing or malformed variable fails loudly instead of silently.
"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Database ---
    # Supabase connection string. Format:
    # postgresql+psycopg://postgres:<password>@<host>:5432/postgres
    database_url: str

    # --- Auth ---
    # Generate with: python -c "import secrets; print(secrets.token_hex(32))"
    jwt_secret: str = "CHANGE_ME_dev_only_secret"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 1 day

    # --- App ---
    project_name: str = "WCO Predictive Mapping System"
    api_v1_prefix: str = "/api/v1"

    # Comma-separated list of allowed frontend origins for CORS.
    # In production set this to your Vercel URL.
    cors_origins: str = "http://localhost:3000"

    # Center of the map (Batangas City, Batangas).
    map_center_lat: float = 13.7565
    map_center_lng: float = 121.0583

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
