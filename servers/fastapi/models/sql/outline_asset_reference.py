import uuid

from sqlalchemy import Column, ForeignKey
from sqlmodel import Field, SQLModel


class OutlineAssetReference(SQLModel, table=True):
    __tablename__ = "outline_asset_references"

    presentation_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("presentations.id", ondelete="CASCADE"), primary_key=True
        )
    )
    document_id: uuid.UUID
    document_revision: int
    attachment_id: uuid.UUID
    sha256: str
    size_bytes: int
    media_type: str
