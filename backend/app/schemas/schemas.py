"""Pydantic schemas — the shapes of data going in and out of the API.

Separating these from the ORM models lets the API contract evolve
independently from the database, and keeps internal columns (like hashed
passwords) out of responses.
"""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# --- Auth -------------------------------------------------------------------

class UserCreate(BaseModel):
    email: EmailStr
    full_name: str
    password: str = Field(min_length=8)
    role: str = "viewer"


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


# --- Establishments ---------------------------------------------------------

class EstablishmentBase(BaseModel):
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


class EstablishmentCreate(EstablishmentBase):
    pass


class EstablishmentUpdate(BaseModel):
    name: str | None = None
    type: str | None = None
    address: str | None = None
    barangay: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    business_hours: str | None = None
    seating_capacity: int | None = None
    contact_info: str | None = None
    consent_given: bool | None = None
    is_active: bool | None = None


class EstablishmentOut(EstablishmentBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    is_active: bool
    created_at: datetime


# --- WCO records ------------------------------------------------------------

class WCORecordCreate(BaseModel):
    establishment_id: int
    week_date: date
    week_end_date: date | None = None
    quantity_liters: float
    notes: str | None = None


class WCORecordOut(WCORecordCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime


class QualityTestCreate(BaseModel):
    establishment_id: int
    sample_date: date
    ffa_pct: float
    viscosity_cp: float
    density_gml: float


class QualityTestOut(QualityTestCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
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


# --- GIS / hotspots ---------------------------------------------------------

class HotspotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    establishment_id: int
    score: float
    category: str
    latitude: float
    longitude: float


# --- WCO record update -------------------------------------------------------

class WCORecordUpdate(BaseModel):
    week_date: date | None = None
    week_end_date: date | None = None
    quantity_liters: float | None = None
    notes: str | None = None


# --- Weekly aggregates -------------------------------------------------------

class WeeklyTotalOut(BaseModel):
    week_date: str
    total_liters: float
    count: int


# --- Route optimization ------------------------------------------------------

class CollectionRouteRequest(BaseModel):
    depot_lat: float
    depot_lng: float
    depot_name: str = "Collection Depot"
    establishment_ids: list[int]


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

# --- Candidate sites ---------------------------------------------------------

class CandidateSiteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    latitude: float
    longitude: float
    rationale: str | None

class CandidateSiteCreate(BaseModel):
    name: str
    latitude: float
    longitude: float
    rationale: str | None = None

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


# --- Saved routes ------------------------------------------------------------

class SavedRouteCreate(BaseModel):
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
