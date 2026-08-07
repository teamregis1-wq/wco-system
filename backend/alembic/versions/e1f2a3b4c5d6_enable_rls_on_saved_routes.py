"""enable RLS on saved_routes

The app connects as the table owner (postgres), which bypasses RLS, so this
only blocks access through Supabase's auto-generated REST API (anon key).
All other app tables already have RLS enabled.

Revision ID: e1f2a3b4c5d6
Revises: 9c43835c3d40
Create Date: 2026-07-06
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = 'e1f2a3b4c5d6'
down_revision = '9c43835c3d40'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE public.saved_routes ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.execute("ALTER TABLE public.saved_routes DISABLE ROW LEVEL SECURITY")
