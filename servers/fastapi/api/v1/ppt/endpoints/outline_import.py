from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
import httpx
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.v1.auth.context import get_current_owner_id
from models.sql.outline_asset_reference import OutlineAssetReference
from models.sql.presentation import PresentationModel
from services.database import get_async_session
from services.outline_slide_import import (
    ASSET_PREFIX,
    build_outline_deck,
    outline_import_settings,
    outline_source,
    read_outline_document,
    read_outline_image,
    summarize_outline,
)

OUTLINE_IMPORT_ROUTER = APIRouter(prefix=ASSET_PREFIX.removeprefix("/api/v1/ppt"))


class OutlineImportRequest(BaseModel):
    page_url: str


class OutlineImportResponse(BaseModel):
    presentation_id: UUID


@OUTLINE_IMPORT_ROUTER.post("", status_code=201)
async def import_outline(
    request: OutlineImportRequest,
    session: AsyncSession = Depends(get_async_session),
) -> OutlineImportResponse:
    owner_id = get_current_owner_id()
    if owner_id is None:
        raise HTTPException(401, "Authentication required")
    settings = outline_import_settings()
    if owner_id != settings.owner_id or request.page_url.rstrip("/") != settings.document_url:
        raise HTTPException(404, "Outline import source not found")

    async with httpx.AsyncClient(follow_redirects=False, timeout=15, trust_env=False) as client:
        document = await read_outline_document(client, settings)
        text, attachments = outline_source(document, settings)
        if not text or len(attachments) != 1:
            raise HTTPException(422, "Outline source must contain text and one attached image")
        attachment = next(iter(attachments))
        image = await read_outline_image(client, settings, attachment)
    summary = await summarize_outline(document, text)
    presentation, slide, reference = build_outline_deck(document, summary, attachment, image)

    session.add(presentation)
    await session.flush()
    session.add_all([slide, reference])
    await session.commit()
    return OutlineImportResponse(presentation_id=presentation.id)


@OUTLINE_IMPORT_ROUTER.get("/{reference_id}/image")
async def get_outline_image(
    reference_id: UUID,
    session: AsyncSession = Depends(get_async_session),
) -> Response:
    owner_id = get_current_owner_id()
    if owner_id is None:
        raise HTTPException(401, "Authentication required")
    reference = await session.get(OutlineAssetReference, reference_id)
    if reference is None:
        raise HTTPException(404, "Outline image not found")
    presentation = await session.get(PresentationModel, reference.presentation_id)
    if presentation is None or presentation.owner_id != owner_id:
        raise HTTPException(404, "Outline image not found")
    settings = outline_import_settings()
    if not settings.allows_document(reference.document_id) or owner_id != settings.owner_id:
        raise HTTPException(404, "Outline image not found")
    async with httpx.AsyncClient(follow_redirects=False, timeout=15, trust_env=False) as client:
        document = await read_outline_document(client, settings, reference.document_id)
        _, attachments = outline_source(document, settings)
        if reference.attachment_id not in attachments:
            raise HTTPException(404, "Outline attachment is no longer in this document")
        image = await read_outline_image(client, settings, reference.attachment_id)
    if (
        image.digest != reference.sha256
        or len(image.content) != reference.size_bytes
        or image.media_type != reference.media_type
    ):
        raise HTTPException(409, "Outline image changed since import")
    return Response(
        image.content,
        media_type=image.media_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
