"""Validated direct editing inputs, independent of natural-language editing."""

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from models.sql.slide import SlideModel


class SlideChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None
    html_content: str | None = None
    speaker_note: str | None = None
    properties: dict[str, Any] | None = None


class SlideEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    changes: SlideChanges


class SlideCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    layout_group: str = Field(min_length=1)
    layout: str = Field(min_length=1)
    content: dict[str, Any]
    position: int | None = Field(default=None, ge=0)
    ui: dict[str, Any] | None = None
    html_content: str | None = None
    speaker_note: str | None = None
    properties: dict[str, Any] | None = None


class SlideOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    slide_ids: list[uuid.UUID] = Field(min_length=1)


class SlideEditResult(BaseModel):
    edit_revision: int
    slide: SlideModel
