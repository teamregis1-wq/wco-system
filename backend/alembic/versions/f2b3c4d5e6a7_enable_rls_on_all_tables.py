"""enable RLS on all application tables

Supabase exposes the public schema through its auto-generated REST API, so any
table without RLS is readable with the project's anon key — bypassing the
FastAPI auth layer entirely. The app connects as the table owner (postgres),
which bypasses RLS, so enabling it changes nothing for the application.

spatial_ref_sys is owned by supabase_admin and cannot be altered from here; it
holds only public PostGIS coordinate-system definitions.

Revision ID: f2b3c4d5e6a7
Revises: e1f2a3b4c5d6
Create Date: 2026-08-11
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = 'f2b3c4d5e6a7'
down_revision = 'e1f2a3b4c5d6'
branch_labels = None
depends_on = None

TABLES = [
    "alembic_version",
    "audit_logs",
    "candidate_sites",
    "establishments",
    "forecast_results",
    "forecast_runs",
    "hotspot_scores",
    "optimization_results",
    "road_network",
    "route_results",
    "simulation_runs",
    "users",
    "wco_generation_records",
    "wco_quality_tests",
]


def upgrade() -> None:
    for table in TABLES:
        op.execute(f"ALTER TABLE IF EXISTS public.{table} ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"ALTER TABLE IF EXISTS public.{table} DISABLE ROW LEVEL SECURITY")
