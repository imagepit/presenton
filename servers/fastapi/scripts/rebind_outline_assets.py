"""Replace resized illustration data URLs with verified private Outline image references."""

import argparse
import asyncio
import base64
from dataclasses import dataclass
from io import BytesIO
from uuid import UUID

import httpx
from PIL import Image, ImageChops, ImageStat
from sqlalchemy import select

from api.v1.auth.context import reset_current_owner_id, set_current_owner_id
from models.sql.outline_asset_reference import OutlineAssetReference
from services.database import async_session_maker
from services.outline_slide_import import (
    MAX_IMAGE_BYTES,
    outline_asset_url,
    outline_import_settings,
    outline_source,
    read_outline_document,
    read_outline_image,
    replace_outline_assets,
    retain_outline_reference,
)
from services.slide_service import load_deck_slides

PNG_DATA_URL = "data:image/png;base64,"
MAX_RMS = 0.01
MIN_RUNNER_UP = 0.05


@dataclass(frozen=True)
class Target:
    deck_id: UUID
    document_id: UUID
    expected_images: int


def parse_target(value: str) -> Target:
    try:
        deck_id, document_id, expected = value.split(":")
        count = int(expected)
        if count < 1:
            raise ValueError
        return Target(UUID(deck_id), UUID(document_id), count)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected deck UUID:document UUID:image count") from exc


def image_urls(value):
    if isinstance(value, dict):
        if (
            value.get("type") == "image"
            and "imagepit_code_block" not in value
            and not value.get("decorative")
            and isinstance(value.get("data"), str)
        ):
            yield value["data"]
        for child in value.values():
            yield from image_urls(child)
    elif isinstance(value, list):
        for child in value:
            yield from image_urls(child)


def fingerprint(content: bytes) -> Image.Image:
    with Image.open(BytesIO(content)) as image:
        scaled = image.convert("RGBA").resize((48, 48), Image.Resampling.BICUBIC)
    background = Image.new("RGBA", scaled.size, "white")
    background.alpha_composite(scaled)
    return background.convert("RGB")


def image_distance(left: Image.Image, right: Image.Image) -> float:
    differences = ImageStat.Stat(ImageChops.difference(left, right)).rms
    return (sum(channel ** 2 for channel in differences) / 3) ** 0.5 / 255


def select_original(url, originals):
    encoded = url.removeprefix(PNG_DATA_URL)
    if len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
        raise ValueError("Embedded illustration exceeds the image limit")
    preview = fingerprint(base64.b64decode(encoded, validate=True))
    ranked = sorted(
        ((image_distance(preview, sample), attachment, image)
         for attachment, image, sample in originals),
        key=lambda result: result[0],
    )
    best, attachment, image = ranked[0]
    if best > MAX_RMS or (len(ranked) > 1 and ranked[1][0] < MIN_RUNNER_UP):
        raise ValueError("Embedded illustration has no unambiguous Outline original")
    return attachment, image


async def prepare_target(session, client, settings, target, semaphore, apply):
    presentation, slides = await load_deck_slides(session, target.deck_id)
    if presentation.owner_id != settings.owner_id:
        raise ValueError("Deck does not belong to the configured Outline importer")

    urls = [url for slide in slides for url in image_urls(slide.ui)]
    references = list(await session.scalars(
        select(OutlineAssetReference).where(
            OutlineAssetReference.presentation_id == target.deck_id
        )
    ))
    if references:
        if (
            len(references) == len(urls) == target.expected_images
            and all(ref.document_id == target.document_id for ref in references)
            and set(urls) == {outline_asset_url(ref.id) for ref in references}
        ):
            print(f"{target.deck_id}: already connected to {len(urls)} originals")
            return
        raise ValueError("Deck already has unexpected Outline references")

    embedded = set(urls)
    if (
        len(embedded) != target.expected_images
        or len(urls) != len(embedded)
        or any(not url.startswith(PNG_DATA_URL) for url in embedded)
    ):
        raise ValueError(f"Deck {target.deck_id} does not have the expected embedded PNGs")

    document = await read_outline_document(client, settings, target.document_id)
    _, attachments = outline_source(document, settings)
    if len(attachments) != target.expected_images:
        raise ValueError(f"Outline document {target.document_id} has unexpected image count")

    async def original(attachment):
        async with semaphore:
            image = await read_outline_image(client, settings, attachment)
        return attachment, image, fingerprint(image.content)

    originals = await asyncio.gather(*(original(attachment) for attachment in attachments))
    replacements: dict[str, str] = {}
    chosen = set()
    for url in embedded:
        attachment, image = select_original(url, originals)
        if attachment in chosen:
            raise ValueError("Two illustrations selected the same Outline original")
        chosen.add(attachment)
        reference = OutlineAssetReference(
            presentation_id=target.deck_id,
            document_id=document.id,
            document_revision=document.revision,
            attachment_id=attachment,
            sha256=image.digest,
            size_bytes=len(image.content),
            media_type=image.media_type,
        )
        if apply:
            await retain_outline_reference(client, settings, reference)
        session.add(reference)
        replacements[url] = outline_asset_url(reference.id)

    for slide in slides:
        if any(url in replacements for url in image_urls(slide.ui)):
            slide.ui = replace_outline_assets(slide.ui, replacements)
    print(f"{target.deck_id}: verified {len(chosen)} original images")


async def run(targets, apply):
    settings = outline_import_settings()
    owner = set_current_owner_id(settings.owner_id)
    semaphore = asyncio.Semaphore(4)
    try:
        async with async_session_maker() as session, httpx.AsyncClient(
            follow_redirects=False, timeout=15, trust_env=False
        ) as client:
            with session.no_autoflush:
                for target in targets:
                    await prepare_target(session, client, settings, target, semaphore, apply)
            if apply:
                await session.commit()
                print("Committed all deck changes")
            else:
                await session.rollback()
                print("Verification only")
    finally:
        reset_current_owner_id(owner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=parse_target, nargs="+")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args.target, args.apply))
