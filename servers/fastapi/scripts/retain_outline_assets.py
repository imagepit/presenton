"""Register the original images used by existing Presenton decks in Outline."""

import asyncio

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from models.sql.outline_asset_reference import OutlineAssetReference
from models.sql.presentation import PresentationModel
from services.database import async_session_maker
from services.outline_slide_import import (
    outline_import_settings,
    read_retained_outline_image,
    retain_outline_reference,
)


async def retain_existing():
    settings = outline_import_settings()
    if not settings.retention_token:
        raise SystemExit("Set OUTLINE_IMPORT_RETAIN_API_TOKEN before registering references")

    async with async_session_maker() as session:
        references = list(await session.scalars(
            select(OutlineAssetReference)
            .join(PresentationModel, OutlineAssetReference.presentation_id == PresentationModel.id)
            .where(PresentationModel.owner_id == settings.owner_id)
            .order_by(OutlineAssetReference.id)
        ))
    invalid = {ref.document_id for ref in references if not settings.allows_document(ref.document_id)}
    if invalid:
        raise SystemExit(f"References use {len(invalid)} unconfigured Outline document(s)")

    unique = {
        (ref.document_id, ref.attachment_id, ref.sha256): ref for ref in references
    }
    async with httpx.AsyncClient(
        timeout=25, trust_env=False, follow_redirects=False
    ) as client:
        for ref in unique.values():
            try:
                await retain_outline_reference(client, settings, ref)
                image = await read_retained_outline_image(client, settings, ref)
                if (
                    image.digest != ref.sha256
                    or len(image.content) != ref.size_bytes
                    or image.media_type != ref.media_type
                ):
                    raise HTTPException(409, "Retained image differs from the deck reference")
            except HTTPException as exc:
                raise SystemExit(f"Reference {ref.id}: {exc.detail}") from None
    print(f"Verified {len(unique)} retained originals for {len(references)} slide references")


if __name__ == "__main__":
    asyncio.run(retain_existing())
