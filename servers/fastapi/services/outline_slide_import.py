"""Load Outline attachments for a slide without persisting image bytes or signed URLs."""

from dataclasses import dataclass, field
from hashlib import sha256
from io import BytesIO
import os
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import aiohttp
import httpx
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError
from yarl import URL

from models.presentation_outline_model import PresentationOutlineModel
from models.sql.outline_asset_reference import OutlineAssetReference
from models.sql.presentation import PresentationModel, PresentationVersion
from models.sql.slide import SlideModel
from utils.llm_calls.generate_presentation_outlines import generate_ppt_outline

ASSET_PREFIX = "/api/v1/ppt/outline-import"
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


@dataclass(frozen=True)
class OutlineImportSettings:
    document_url: str
    document_id: UUID
    owner_id: UUID
    api_token: str
    r2_host: str
    additional_document_ids: frozenset[UUID] = frozenset()
    retention_token: str | None = field(default=None, repr=False)
    use_retained_originals: bool = False

    def allows_document(self, document_id: UUID) -> bool:
        return document_id == self.document_id or document_id in self.additional_document_ids

    @property
    def origin(self) -> str:
        url = urlsplit(self.document_url)
        return f"{url.scheme}://{url.netloc}"


class OutlineNode(BaseModel):
    type: str
    attrs: dict = Field(default_factory=dict)
    text: str = ""
    content: list["OutlineNode"] = Field(default_factory=list)


class OutlineDocument(BaseModel):
    id: UUID
    title: str
    language: str | None = None
    revision: int = Field(ge=0)
    data: OutlineNode


class OutlineDocumentPayload(BaseModel):
    document: OutlineDocument


class OutlineDocumentResponse(BaseModel):
    data: OutlineDocumentPayload


@dataclass(frozen=True)
class OutlineImage:
    content: bytes
    media_type: str

    @property
    def digest(self) -> str:
        return sha256(self.content).hexdigest()


def outline_import_settings() -> OutlineImportSettings:
    try:
        document_url = os.environ["OUTLINE_IMPORT_DOCUMENT_URL"].rstrip("/")
        url = urlsplit(document_url)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.query
            or url.fragment
            or not url.path.startswith("/doc/")
        ):
            raise ValueError
        r2_host = os.environ["OUTLINE_IMPORT_R2_HOST"].strip().lower()
        if not r2_host.endswith(".r2.cloudflarestorage.com"):
            raise ValueError
        token = os.environ["OUTLINE_IMPORT_API_TOKEN"].strip()
        if not token:
            raise ValueError
        retention_token = os.getenv("OUTLINE_IMPORT_RETAIN_API_TOKEN", "").strip() or None
        use_retained_originals = os.getenv("OUTLINE_IMPORT_USE_RETAINED_ORIGINALS") == "true"
        if use_retained_originals and not retention_token:
            raise ValueError
        return OutlineImportSettings(
            document_url=document_url,
            document_id=UUID(os.environ["OUTLINE_IMPORT_DOCUMENT_ID"]),
            owner_id=UUID(os.environ["OUTLINE_IMPORT_OWNER_ID"]),
            api_token=token,
            r2_host=r2_host,
            retention_token=retention_token,
            use_retained_originals=use_retained_originals,
            additional_document_ids=frozenset(
                UUID(value.strip())
                for value in os.getenv("OUTLINE_IMPORT_ADDITIONAL_DOCUMENT_IDS", "").split(",")
                if value.strip()
            ),
        )
    except (KeyError, ValueError):
        raise HTTPException(503, "Outline import is not configured") from None


async def _read_bounded(response: httpx.Response, limit: int) -> bytes:
    content = bytearray()
    async for chunk in response.aiter_bytes():
        if len(content) + len(chunk) > limit:
            raise HTTPException(422, "Outline response exceeds the import size limit")
        content.extend(chunk)
    return bytes(content)


async def read_outline_document(
    client: httpx.AsyncClient,
    settings: OutlineImportSettings,
    document_id: UUID | None = None,
) -> OutlineDocument:
    document_id = document_id or settings.document_id
    if not settings.allows_document(document_id):
        raise HTTPException(404, "Outline source not found")
    try:
        async with client.stream(
            "POST",
            f"{settings.origin}/api/documents.info",
            headers={
                "Authorization": f"Bearer {settings.api_token}",
                "X-API-Version": "3",
            },
            json={"id": str(document_id)},
        ) as response:
            if response.status_code != 200:
                raise HTTPException(502, "Outline document is unavailable")
            body = await _read_bounded(response, MAX_DOCUMENT_BYTES)
        document = OutlineDocumentResponse.model_validate_json(body).data.document
    except (httpx.HTTPError, ValidationError):
        raise HTTPException(502, "Unable to read the Outline document") from None
    if document.id != document_id:
        raise HTTPException(502, "Outline returned an unexpected document")
    return document


def outline_source(
    document: OutlineDocument, settings: OutlineImportSettings
) -> tuple[str, set[UUID]]:
    """Return text blocks and unique attachments from Outline's editor document."""
    blocks: list[str] = []
    attachments: set[UUID] = set()

    def visit(node: OutlineNode) -> str:
        if node.type == "image":
            source = node.attrs.get("src")
            if isinstance(source, str):
                try:
                    link = urlsplit(source)
                except ValueError:
                    return ""
                same_origin = (
                    (not link.scheme and not link.netloc)
                    or f"{link.scheme}://{link.netloc}" == settings.origin
                )
                if same_origin and link.path == "/api/attachments.redirect":
                    ids = parse_qs(link.query).get("id", [])
                    if len(ids) == 1:
                        try:
                            attachments.add(UUID(ids[0]))
                        except ValueError:
                            pass
            return ""
        text = node.text + "".join(visit(child) for child in node.content)
        if node.type in {"paragraph", "heading", "code_block"} and text.strip():
            blocks.append(text.strip())
            return ""
        return text

    remaining_text = visit(document.data).strip()
    if remaining_text:
        blocks.append(remaining_text)
    return "\n".join(blocks), attachments


async def read_outline_image(
    client: httpx.AsyncClient, settings: OutlineImportSettings, attachment_id: UUID
) -> OutlineImage:
    return await _read_redirected_image(
        client, settings, "GET", "/api/attachments.redirect",
        settings.api_token, params={"id": str(attachment_id)},
    )


def _retained_identity(reference: OutlineAssetReference) -> dict[str, str]:
    return {
        "documentId": str(reference.document_id),
        "attachmentId": str(reference.attachment_id),
        "sha256": reference.sha256,
    }


async def retain_outline_reference(
    client: httpx.AsyncClient,
    settings: OutlineImportSettings,
    reference: OutlineAssetReference,
) -> None:
    if settings.retention_token is None:
        return
    if not settings.allows_document(reference.document_id):
        raise HTTPException(404, "Outline source not found")
    try:
        response = await client.post(
            f"{settings.origin}/api/slideAssetReferences.retain",
            headers={"Authorization": f"Bearer {settings.retention_token}"},
            json={
                **_retained_identity(reference),
                "bytes": reference.size_bytes,
                "mediaType": reference.media_type,
            },
            follow_redirects=False,
        )
        if response.status_code == 200 and response.json() == {"success": True}:
            return
    except (httpx.HTTPError, ValueError):
        pass
    raise HTTPException(502, "Outline could not retain the original image")


async def read_retained_outline_image(
    client: httpx.AsyncClient,
    settings: OutlineImportSettings,
    reference: OutlineAssetReference,
) -> OutlineImage:
    if settings.retention_token is None:
        raise HTTPException(503, "Outline retention is not configured")
    return await _read_redirected_image(
        client, settings, "POST", "/api/slideAssetReferences.redirect",
        settings.retention_token, body=_retained_identity(reference),
    )


async def _read_redirected_image(
    client: httpx.AsyncClient,
    settings: OutlineImportSettings,
    method: str,
    path: str,
    token: str,
    *,
    params: dict[str, str] | None = None,
    body: dict[str, str] | None = None,
) -> OutlineImage:
    try:
        async with client.stream(
            method,
            f"{settings.origin}{path}",
            params=params,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
            follow_redirects=False,
        ) as response:
            if not response.is_redirect:
                raise HTTPException(502, "Outline attachment is unavailable")
            signed_url = response.headers.get("location", "")
        target = urlsplit(signed_url)
        if (
            target.scheme != "https"
            or target.netloc != settings.r2_host
            or target.fragment
            or not parse_qs(target.query).get("X-Amz-Signature")
        ):
            raise HTTPException(502, "Outline returned an unexpected storage URL")
        content = await _download_r2_image(signed_url)
    except (httpx.HTTPError, aiohttp.ClientError, TimeoutError, ValueError):
        raise HTTPException(502, "Unable to read the Outline image") from None

    try:
        with Image.open(BytesIO(content), formats=list(IMAGE_TYPES)) as image:
            if image.width * image.height > 25_000_000 or getattr(image, "n_frames", 1) != 1:
                raise ValueError
            media_type = IMAGE_TYPES[image.format]
            image.verify()
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise HTTPException(422, "Outline attachment must be a supported still image") from None
    return OutlineImage(content, media_type)


async def _download_r2_image(signed_url: str) -> bytes:
    # Keep the signed URL out of HTTPX request logs. R2 needs no Outline credentials.
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(URL(signed_url, encoded=True), allow_redirects=False) as response:
            if response.status != 200:
                raise HTTPException(502, "Outline image is unavailable in R2")
            content = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                if len(content) + len(chunk) > MAX_IMAGE_BYTES:
                    raise HTTPException(422, "Outline image exceeds the import size limit")
                content.extend(chunk)
            return bytes(content)


async def summarize_outline(document: OutlineDocument, body: str) -> str:
    output = []
    async for chunk in generate_ppt_outline(
        content=f"{document.title}\n\n{body[:24000]}",
        n_slides=1,
        language=document.language or "Auto",
        verbosity="concise",
        instructions="Summarize the source into 3 short plain-text bullets.",
        include_title_slide=False,
    ):
        if not isinstance(chunk, str):
            raise HTTPException(502, "Outline slide generation failed")
        output.append(chunk)
    try:
        outline = PresentationOutlineModel.model_validate_json("".join(output))
        if len(outline.slides) != 1 or not outline.slides[0].content.strip():
            raise ValueError
        return outline.slides[0].content
    except ValueError:
        raise HTTPException(502, "Outline slide generation returned no summary") from None


def outline_asset_url(reference_id: UUID) -> str:
    return f"{ASSET_PREFIX}/{reference_id}/image"


def build_outline_deck(
    document: OutlineDocument, summary: str, attachment_id: UUID, image: OutlineImage
) -> tuple[PresentationModel, SlideModel, OutlineAssetReference]:
    presentation = PresentationModel(
        version=PresentationVersion.V2_STANDARD,
        content="",
        n_slides=1,
        language=document.language or "",
        title=document.title,
        include_title_slide=False,
    )
    url = outline_asset_url(presentation.id)
    title = {
        "type": "text",
        "position": {"x": 72, "y": 52},
        "size": {"width": 1136, "height": 114},
        "font": {"size": 40, "weight": 700},
        "runs": [{"text": document.title}],
    }
    body = {
        "type": "text",
        "position": {"x": 72, "y": 180},
        "size": {"width": 548, "height": 444},
        "font": {"size": 28},
        "runs": [{"text": summary}],
    }
    picture = {
        "type": "image",
        "position": {"x": 665, "y": 176},
        "size": {"width": 543, "height": 456},
        "fit": "contain",
        "data": url,
    }
    slide = SlideModel(
        presentation=presentation.id,
        layout_group="blank",
        layout="__blank_slide__",
        index=0,
        content={},
        ui={
            "id": "__blank_slide__",
            "description": "Outline import",
            "background": "#FFFFFF",
            "components": [],
            "elements": [title, body, picture],
        },
    )
    reference = OutlineAssetReference(
        id=presentation.id,
        presentation_id=presentation.id,
        document_id=document.id,
        document_revision=document.revision,
        attachment_id=attachment_id,
        sha256=image.digest,
        size_bytes=len(image.content),
        media_type=image.media_type,
    )
    return presentation, slide, reference


def replace_outline_assets(value, urls: dict[str, str]):
    if isinstance(value, list):
        return [replace_outline_assets(item, urls) for item in value]
    if isinstance(value, dict):
        return {
            key: replace_outline_assets(item, urls)
            for key, item in value.items()
        }
    return urls.get(value, value) if isinstance(value, str) else value
