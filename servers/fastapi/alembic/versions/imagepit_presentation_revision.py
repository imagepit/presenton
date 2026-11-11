"""Add the editing revision independently of the presentation format version."""
from alembic import op
import sqlalchemy as sa

revision = "ip_edit_revision"
down_revision = "026c0ba8b35c"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "presentations" not in inspector.get_table_names():
        return
    if "edit_revision" in {column["name"] for column in inspector.get_columns("presentations")}:
        return
    op.add_column("presentations", sa.Column("edit_revision", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("presentations", "edit_revision")
