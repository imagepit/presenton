"""Allow multiple Outline image references per presentation."""

from alembic import op
import sqlalchemy as sa

revision = "ip_outline_multi_image"
down_revision = "ip_outline_asset_reference"
branch_labels = None
depends_on = None

TABLE = "outline_asset_references"


def upgrade():
    constraint = sa.inspect(op.get_bind()).get_pk_constraint(TABLE)
    primary_key = constraint.get("name") or f"pk_{TABLE}"
    op.add_column(TABLE, sa.Column("id", sa.Uuid(), nullable=True))
    op.execute(sa.text(f"UPDATE {TABLE} SET id = presentation_id"))
    with op.batch_alter_table(
        TABLE,
        naming_convention={"pk": "pk_%(table_name)s"},
        reflect_kwargs={"resolve_fks": False},
    ) as batch:
        batch.drop_constraint(primary_key, type_="primary")
        batch.alter_column("id", existing_type=sa.Uuid(), nullable=False)
        batch.create_primary_key(f"pk_{TABLE}", ["id"])
        batch.create_index(f"ix_{TABLE}_presentation_id", ["presentation_id"])


def downgrade():
    bind = op.get_bind()
    extra = bind.execute(sa.text(
        f"SELECT 1 FROM {TABLE} WHERE id <> presentation_id LIMIT 1"
    )).first()
    if extra:
        raise RuntimeError("Restore multi-image deck data before downgrading Outline references")
    with op.batch_alter_table(TABLE) as batch:
        batch.drop_index(f"ix_{TABLE}_presentation_id")
        batch.drop_constraint(f"pk_{TABLE}", type_="primary")
        batch.create_primary_key(f"pk_{TABLE}", ["presentation_id"])
        batch.drop_column("id")
