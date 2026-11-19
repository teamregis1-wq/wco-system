"""Pydantic schemas — the shapes of data going in and out of the API.

Separating these from the ORM models lets the API contract evolve
independently from the database, and keeps internal columns (like hashed
passwords) out of responses.

Input schemas are strict (they are the first line of data validation);
output schemas are deliberately lenient so that a legacy row in the database
can never turn a list endpoint into a 500.
"""
from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.core.constants import DATA_SOURCES, ESTABLISHMENT_TYPES, MAX_WEEKLY_LITERS, ROLES

RoleLiteral = Literal["admin", "researcher", "viewer"]
DataSourceLiteral = Literal["synthetic", "observed", "unspecified"]
EstablishmentTypeLiteral = Literal["restaurant", "fast_food", "food_manufacturer"]

assert set(RoleLiteral.__args__) == set(ROLES)  # keep constants and literals in sync
assert set(DataSourceLiteral.__args__) == set(DATA_SOURCES)
assert set(EstablishmentTypeLiteral.__args__) == set(ESTABLISHMENT_TYPES)


def _check_study_area(lat: float | None, lng: float | None) -> None:
    """Reject coordinates outside the configured Batangas study area."""
    from app.core.config import settings
    if lat is None or lng is None:
        return
    in_box = (settings.study_area_lat_min <= lat <= settings.study_area_lat_max and
              settings.study_area_lng_min <= lng <= settings.study_area_lng_max)
    if not in_box:
        swapped = (settings.study_area_lat_min <= lng <= settings.study_area_lat_max and
                   settings.study_area_lng_min <= lat <= settings.study_area_lng_max)
        if swapped:
            raise ValueError(
                f"coordinates ({lat}, {lng}) look swapped — latitude must come first")
        raise ValueError(f"coordinates ({lat}, {lng}) are outside the Batangas study area")


def _not_in_future(d: date | None) -> date | None:
    # One day of slack covers timezone differences between client and server.
    if d is not None and d > date.today() + timedelta(days=1):
        raise ValueError(f"{d} is in the future; weekly totals can only be recorded for past weeks")
    return d


def _week_starts_monday(d: date | None) -> date | None:
    # Collection weeks run Monday–Sunday. A week starting on any other day would
    # sit between two regular weeks and break the 7-day series the forecaster reads.
    if d is not None and d.weekday() != 0:
        monday = d - timedelta(days=d.weekday())
        raise ValueError(
            f"{d} is a {d.strftime('%A')}; collection weeks run Monday to Sunday, "
            f"so week_date must be a Monday (the week containing {d} starts {monday})")
    return d


# --- Auth -------------------------------------------------------------------

class UserCreate(BaseModel):
    """Public self-registration. Always creates a viewer account."""
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    # Accepted for backward compatibility with older clients; anything other
    # than "viewer" is rejected by the endpoint (no self-assigned privileges).
    role: str = "viewer"


class AdminUserCreate(BaseModel):
    """Admin-only user creation; may assign any role."""
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    role: RoleLiteral = "viewer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str        # plain str — EmailStr rejects .local TLDs used in dev seeds
    full_name: str
    role: str
    created_at: datetime


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut | None = None  # returned by /auth/login to save a /auth/me round-trip


# --- Establishments ---------------------------------------------------------

class EstablishmentCreate(BaseModel):
    # Constraints mirror the CSV importer's client-side validation so bad data
    # cannot enter through a direct API call either.
    wco_code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=200)
    type: EstablishmentTypeLiteral
    address: str | None = Field(default=None, max_length=500)
    barangay: str | None = Field(default=None, max_length=120)
    latitude: float = Field(ge=-90.0, le=90.0, allow_inf_nan=False)
    longitude: float = Field(ge=-180.0, le=180.0, allow_inf_nan=False)
    business_hours: str | None = Field(default=None, max_length=120)
    seating_capacity: int | None = Field(default=None, ge=0, le=100_000)
    contact_info: str | None = Field(default=None, max_length=255)
    # Default False: consent must be explicitly recorded, never assumed.
    consent_given: bool = False
    data_source: DataSourceLiteral | None = None

    @field_validator("wco_code", "name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v

    @model_validator(mode="after")
    def _study_area(self):
        _check_study_area(self.latitude, self.longitude)
        return self


class EstablishmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: EstablishmentTypeLiteral | None = None
    address: str | None = Field(default=None, max_length=500)
    barangay: str | None = Field(default=None, max_length=120)
    latitude: float | None = Field(default=None, ge=-90.0, le=90.0, allow_inf_nan=False)
    longitude: float | None = Field(default=None, ge=-180.0, le=180.0, allow_inf_nan=False)
    business_hours: str | None = Field(default=None, max_length=120)
    seating_capacity: int | None = Field(default=None, ge=0, le=100_000)
    contact_info: str | None = Field(default=None, max_length=255)
    consent_given: bool | None = None
    is_active: bool | None = None
    data_source: DataSourceLiteral | None = None

    @model_validator(mode="after")
    def _study_area(self):
        # Partial updates are re-checked against the merged row in the router.
        if self.latitude is not None and self.longitude is not None:
            _check_study_area(self.latitude, self.longitude)
        return self


class EstablishmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    wco_code: str
    name: str
    type: str
    address: str | None = None
    barangay: str | None = None
    latitude: float
    longitude: float
    business_hours: str | None = None
    seating_capacity: int | None = None
    contact_info: str | None = None
    consent_given: bool = False
    data_source: str = "unspecified"
    is_active: bool
    created_at: datetime


# --- WCO records ------------------------------------------------------------

class WCORecordCreate(BaseModel):
    establishment_id: int = Field(gt=0)
    week_date: date
    week_end_date: date | None = None
    # A negative weekly volume is always a data-entry error; the 10,000 L ceiling
    # matches the importer and catches unit mix-ups (e.g. millilitres).
    # allow_inf_nan=False rejects NaN / Infinity, which Python's JSON parser accepts.
    quantity_liters: float = Field(ge=0.0, le=MAX_WEEKLY_LITERS, allow_inf_nan=False)
    notes: str | None = Field(default=None, max_length=500)
    data_source: DataSourceLiteral | None = None

    # Only the week's START must not be in the future: the current, in-progress
    # week may be recorded even though its end date is still ahead.
    @field_validator("week_date")
    @classmethod
    def _not_future(cls, v: date | None) -> date | None:
        return _week_starts_monday(_not_in_future(v))

    @model_validator(mode="after")
    def _end_after_start(self):
        if self.week_end_date is not None:
            if self.week_end_date < self.week_date:
                raise ValueError("week_end_date must be on or after week_date")
            if (self.week_end_date - self.week_date).days > 13:
                raise ValueError("week_end_date must be within the same week as week_date")
        return self


class WCORecordUpdate(BaseModel):
    week_date: date | None = None
    week_end_date: date | None = None
    quantity_liters: float | None = Field(
        default=None, ge=0.0, le=MAX_WEEKLY_LITERS, allow_inf_nan=False)
    notes: str | None = Field(default=None, max_length=500)
    data_source: DataSourceLiteral | None = None

    # Only the week's START must not be in the future: the current, in-progress
    # week may be recorded even though its end date is still ahead.
    @field_validator("week_date")
    @classmethod
    def _not_future(cls, v: date | None) -> date | None:
        return _week_starts_monday(_not_in_future(v))

    @field_validator("quantity_liters")
    @classmethod
    def _qty_not_null(cls, v):
        # Explicit null would violate the NOT NULL column; treat as an error.
        if v is None:
            raise ValueError("quantity_liters cannot be null")
        return v


class WCORecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    establishment_id: int
    week_date: date
    week_end_date: date | None = None
    quantity_liters: float
    notes: str | None = None
    data_source: str = "unspecified"
    created_at: datetime
    updated_at: datetime | None = None


class QualityTestCreate(BaseModel):
    establishment_id: int = Field(gt=0)
    sample_date: date
    ffa_pct: float = Field(ge=0.0, le=100.0, allow_inf_nan=False)
    viscosity_cp: float = Field(gt=0.0, le=10_000.0, allow_inf_nan=False)
    density_gml: float = Field(gt=0.0, le=5.0, allow_inf_nan=False)

    @field_validator("sample_date")
    @classmethod
    def _not_future(cls, v: date) -> date:
        return _not_in_future(v)


class QualityTestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    establishment_id: int
    sample_date: date
    ffa_pct: float
    viscosity_cp: float
    density_gml: float
    created_at: datetime


# --- Simulation runs --------------------------------------------------------

class SimulationRunCreate(BaseModel):
    temperature_c: float
    molar_ratio: float
    catalyst_loading_pct: float
    yield_pct: float
    conversion_efficiency: float | None = None
    notes: str | None = None


class SimulationRunOut(SimulationRunCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int


# --- Audit log --------------------------------------------------------------

class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_email: str
    action: str
    resource_type: str
    resource_id: int | None
    details: str | None
    created_at: datetime


# --- Forecast ---------------------------------------------------------------

class ForecastPoint(BaseModel):
    week_date: date
    predicted_liters: float


class ForecastResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    establishment_id: int
    model_version: str
    points: list[ForecastPoint]
    # The last observed week the recursive forecast starts from. If this is far
    # in the past, the "forecast" weeks may also be in the past.
    forecast_origin: date | None = None
    horizon_weeks: int | None = None
    trained_at: datetime | None = None
    warnings: list[str] = []


# --- GIS / hotspots ---------------------------------------------------------

class HotspotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    establishment_id: int
    score: float
    category: str
    latitude: float
    longitude: float


# --- Weekly aggregates -------------------------------------------------------

class WeeklyTotalOut(BaseModel):
    week_date: str
    total_liters: float
    count: int


# --- Route optimization ------------------------------------------------------

class CollectionRouteRequest(BaseModel):
    depot_lat: float = Field(ge=-90.0, le=90.0, allow_inf_nan=False)
    depot_lng: float = Field(ge=-180.0, le=180.0, allow_inf_nan=False)
    depot_name: str = Field(default="Collection Depot", max_length=255)
    # Above OSRM_MAX_TABLE_POINTS the route falls back to straight-line distances
    # (with a warning); this cap only guards against abusive requests.
    establishment_ids: list[int] = Field(max_length=1000)


class RouteStop(BaseModel):
    stop_number: int
    establishment_id: int
    name: str
    wco_code: str
    barangay: str | None
    avg_liters: float
    lat: float
    lng: float
    leg_distance_km: float
    cumulative_distance_km: float
    # 'road' (OSRM) or 'straight_line' (haversine estimate for this leg).
    leg_distance_basis: str = "road"


class CollectionRouteResponse(BaseModel):
    depot_lat: float
    depot_lng: float
    depot_name: str
    stops: list[RouteStop]
    total_distance_km: float
    total_establishments: int
    estimated_duration_min: float
    total_wco_liters: float


# --- WCO summary / completeness / monthly -----------------------------------

class WCOSummaryOut(BaseModel):
    month_total_liters: float
    ytd_total_liters: float
    current_month: int
    current_year: int
    last_updated: str | None
    # Record counts by provenance, e.g. {"synthetic": 6240}.
    data_source_counts: dict[str, int] = {}


class MonthlyTotalOut(BaseModel):
    year: int
    month: int
    total_liters: float
    record_count: int


class WCOCompletenessOut(BaseModel):
    establishment_id: int
    weeks_with_data: int
    expected_weeks: int
    completeness_pct: float
    first_record_date: str | None
    last_record_date: str | None


# --- Aggregate forecast ------------------------------------------------------

class AggregateForecastPoint(BaseModel):
    week_date: str
    total_predicted_liters: float
    establishment_count: int


# --- Route with metadata -----------------------------------------------------

class CollectionRouteResponseV2(CollectionRouteResponse):
    algorithm: str
    computation_time_ms: float
    geometry: list[list[float]] | None = None   # [[lat, lng], ...] road path
    # 'road' | 'straight_line' | 'mixed' — what the distances are based on.
    distance_basis: str = "road"
    # Nearest-neighbour ordering is a heuristic: it is NOT guaranteed optimal.
    is_heuristic: bool = True
    warnings: list[str] = []


# --- Saved routes ------------------------------------------------------------

class SavedRouteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    depot_name: str = Field(max_length=255)
    depot_lat: float = Field(ge=-90.0, le=90.0, allow_inf_nan=False)
    depot_lng: float = Field(ge=-180.0, le=180.0, allow_inf_nan=False)
    total_distance_km: float = Field(ge=0.0, allow_inf_nan=False)
    total_establishments: int = Field(ge=0)
    total_wco_liters: float = Field(ge=0.0, allow_inf_nan=False)
    estimated_duration_min: float = Field(ge=0.0, allow_inf_nan=False)
    algorithm: str = Field(max_length=100)
    stops_json: list | None = None
    geometry_json: list | None = None


class SavedRouteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    depot_name: str
    depot_lat: float
    depot_lng: float
    total_distance_km: float
    total_establishments: int
    total_wco_liters: float
    estimated_duration_min: float
    algorithm: str
    stops_json: list | None = None
    geometry_json: list | None = None
    created_at: datetime
