"""Store Outline asset references without storing their contents."""

from alembic import op
import sqlalchemy as sa

revision = "ip_outline_asset_reference"
down_revision = "ip_edit_revision"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "outline_asset_references",
        sa.Column("presentation_id", sa.Uuid(), primary_key=True),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("attachment_id", sa.Uuid(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("media_type", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["presentation_id"], ["presentations.id"], ondelete="CASCADE"
        ),
        if_not_exists=True,
    )


def downgrade():
    op.drop_table("outline_asset_references")
