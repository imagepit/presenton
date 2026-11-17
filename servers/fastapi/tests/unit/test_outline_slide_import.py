import asyncio
import hashlib
import json
from io import BytesIO
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException
from PIL import Image
from sqlalchemy.ext.asyncio import async_sessionmaker

from api import middlewares
from api.middlewares import SessionAuthMiddleware
from api.v1.ppt.endpoints import outline_import
from api.v1.ppt.endpoints.presentation import PRESENTATION_ROUTER
from models.sql.outline_asset_reference import OutlineAssetReference
from models.sql.presentation import PresentationModel
from models.sql.slide import SlideModel
from services import outline_slide_import
from tests.integration.test_auth_endpoints import _build_client

PREFIX = "/api/v1/ppt/outline-import"
PAGE = "https://outline.example/doc/test-1234567890"
R2 = "originals.r2.cloudflarestorage.com"


def test_import_saves_only_reference_and_requires_deck_owner(tmp_path, monkeypatch):
    doc_id, attachment_id, second_doc = uuid4(), uuid4(), uuid4()
    image = BytesIO()
    Image.new("RGB", (2, 2), "red").save(image, format="PNG")
    png = image.getvalue()
    blocks = [
        {"type": "paragraph", "content": [{"type": "text", "text": "元ページの内容"}]},
        {"type": "image", "attrs": {"src": f"/api/attachments.redirect?id={attachment_id}"}},
    ]
    signed_requests = []
    downloads = []
    unavailable = False
    document_reads = []

    def outline_api(request):
        assert request.url.host == "outline.example"
        if request.url.path == "/api/slideAssetReferences.redirect":
            assert request.headers["authorization"] == "Bearer test-retention-token"
            assert json.loads(request.content) == {
                "documentId": str(doc_id),
                "attachmentId": str(attachment_id),
                "sha256": hashlib.sha256(png).hexdigest(),
            }
            return httpx.Response(302, headers={
                "Location": f"https://{R2}/bucket/retained.png?X-Amz-Signature=retained"
            })
        if request.url.path == "/api/slideAssetReferences.retain":
            assert request.headers["authorization"] == "Bearer test-retention-token"
            assert json.loads(request.content) == {
                "documentId": str(doc_id),
                "attachmentId": str(attachment_id),
                "sha256": hashlib.sha256(png).hexdigest(),
                "bytes": len(png),
                "mediaType": "image/png",
            }
            return httpx.Response(200, json={"success": True})
        assert request.headers["authorization"] == "Bearer test-outline-token"
        if request.url.path == "/api/documents.info":
            document_reads.append(request.url.path)
            assert request.headers["x-api-version"] == "3"
            requested = UUID(json.loads(request.content)["id"])
            assert requested in {doc_id, second_doc}
            return httpx.Response(
                200,
                json={
                    "data": {
                        "document": {
                            "id": str(requested),
                            "title": "元ページ",
                            "language": "ja",
                            "revision": 1,
                            "data": {"type": "doc", "content": blocks},
                        }
                    }
                },
            )
        assert request.url.path == "/api/attachments.redirect"
        assert request.url.params["id"] == str(attachment_id)
        url = f"https://{R2}/bucket/original.png?X-Amz-Signature={len(signed_requests)}"
        signed_requests.append(url)
        return httpx.Response(302, headers={"Location": url})

    async def download(url):
        if unavailable:
            raise HTTPException(502, "Original unavailable")
        downloads.append(url)
        return png

    async def generate(**kwargs):
        assert kwargs["language"] == "ja"
        assert "元ページの内容" in kwargs["content"]
        yield '{"slides":[{"content":"本文の要点"}]}'

    for key, value in {
        "OUTLINE_IMPORT_DOCUMENT_URL": PAGE,
        "OUTLINE_IMPORT_DOCUMENT_ID": str(doc_id),
        "OUTLINE_IMPORT_R2_HOST": R2,
        "OUTLINE_IMPORT_API_TOKEN": "test-outline-token",
        "APP_DATA_DIRECTORY": str(tmp_path / "app_data"),
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("DISABLE_AUTH", raising=False)
    monkeypatch.setenv("USER_CONFIG_PATH", str(tmp_path / "config.json"))
    async_client = httpx.AsyncClient
    monkeypatch.setattr(
        outline_import.httpx,
        "AsyncClient",
        lambda **kwargs: async_client(transport=httpx.MockTransport(outline_api), **kwargs),
    )
    monkeypatch.setattr(outline_slide_import, "_download_r2_image", download)
    monkeypatch.setattr(outline_slide_import, "generate_ppt_outline", generate)

    client, engine = _build_client(tmp_path)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def create_tables():
        async with engine.begin() as connection:
            for model in (PresentationModel, SlideModel, OutlineAssetReference):
                await connection.run_sync(model.__table__.create)

    asyncio.run(create_tables())
    monkeypatch.setattr(middlewares, "async_session_maker", sessions)
    client.app.add_middleware(SessionAuthMiddleware)
    client.app.include_router(outline_import.OUTLINE_IMPORT_ROUTER, prefix="/api/v1/ppt")
    client.app.include_router(PRESENTATION_ROUTER, prefix="/api/v1/ppt")

    try:
        login = {"username": "admin", "password": "secret123"}
        assert client.post("/api/v1/auth/setup", json=login).status_code == 200
        assert client.post("/api/v1/auth/login", json=login).status_code == 200
        owner = client.get("/api/v1/auth/status").json()["user_id"]
        monkeypatch.setenv("OUTLINE_IMPORT_OWNER_ID", owner)
        assert client.post(PREFIX, json={"page_url": PAGE + "-other"}).status_code == 404
        assert not signed_requests

        result = client.post(PREFIX, json={"page_url": PAGE})
        assert result.status_code == 201, result.text
        deck_id = result.json()["presentation_id"]
        deck_path = f"/api/v1/ppt/presentation/{deck_id}"
        image_path = f"{PREFIX}/{deck_id}/image"
        deck = client.get(deck_path)
        assert deck.status_code == 200
        elements = deck.json()["slides"][0]["ui"]["elements"]
        assert elements[1]["runs"] == [{"text": "本文の要点"}]
        assert elements[2]["data"] == image_path
        assert R2 not in deck.text
        assert not list((tmp_path / "app_data").rglob("*.png"))

        for _ in range(2):
            response = client.get(image_path)
            assert response.status_code == 200, response.text
            assert response.content == png
            assert response.headers["cache-control"] == "private, no-store"
        assert len(set(downloads)) == 3

        second_ref = uuid4()
        second_url = f"{PREFIX}/{second_ref}/image"

        async def register_second_image():
            async with sessions() as session:
                slide = await session.get(SlideModel, UUID(deck.json()["slides"][0]["id"]))
                slide.ui = {**slide.ui, "elements": [
                    *slide.ui["elements"], {"type": "image", "data": second_url},
                ]}
                session.add(OutlineAssetReference(
                    id=second_ref,
                    presentation_id=UUID(deck_id),
                    document_id=second_doc,
                    document_revision=1,
                    attachment_id=attachment_id,
                    sha256=hashlib.sha256(png).hexdigest(),
                    size_bytes=len(png),
                    media_type="image/png",
                ))
                await session.commit()

        asyncio.run(register_second_image())
        assert client.get(second_url).status_code == 404
        monkeypatch.setenv("OUTLINE_IMPORT_ADDITIONAL_DOCUMENT_IDS", str(second_doc))
        assert client.get(second_url).content == png

        copy = client.post(f"{deck_path}/duplicate")
        assert copy.status_code == 200, copy.text
        copy_image_path = f"{PREFIX}/{copy.json()['id']}/image"
        assert copy.json()["slides"][0]["ui"]["elements"][2]["data"] == copy_image_path
        second_copy = copy.json()["slides"][0]["ui"]["elements"][3]["data"]
        assert second_copy != second_url
        assert client.delete(deck_path).status_code == 204
        assert client.get(copy_image_path).content == png
        assert client.get(second_copy).content == png

        monkeypatch.setenv("OUTLINE_IMPORT_RETAIN_API_TOKEN", "test-retention-token")
        assert client.post(PREFIX, json={"page_url": PAGE}).status_code == 201

        unavailable = True
        assert client.get(copy_image_path).status_code == 502
        unavailable = False
        blocks.pop()
        before = len(signed_requests)
        assert client.get(copy_image_path).status_code == 404
        assert client.post(PREFIX, json={"page_url": PAGE}).status_code == 422
        assert len(signed_requests) == before

        reads = len(document_reads)
        monkeypatch.setenv("OUTLINE_IMPORT_USE_RETAINED_ORIGINALS", "true")
        assert client.get(copy_image_path).content == png
        assert len(document_reads) == reads

        member = {"username": "member", "password": "secret456"}
        assert client.post("/api/v1/admin/users", json=member).status_code == 201
        client.cookies.clear()
        assert client.get(copy_image_path).status_code == 401
        assert client.post("/api/v1/auth/login", json=member).status_code == 200
        assert client.get(copy_image_path).status_code == 404
        assert client.post(PREFIX, json={"page_url": PAGE}).status_code == 404
        assert len(signed_requests) == before
    finally:
        client.close()
        asyncio.run(engine.dispose())


def test_does_not_follow_attachment_redirect_to_another_host(monkeypatch):
    settings = outline_slide_import.OutlineImportSettings(
        PAGE, uuid4(), uuid4(), "test-outline-token", R2
    )
    contacted = []

    async def download(url):
        contacted.append(url)

    monkeypatch.setattr(outline_slide_import, "_download_r2_image", download)

    async def get():
        transport = httpx.MockTransport(
            lambda _: httpx.Response(
                302, headers={"Location": f"https://{R2}.example.com/image?X-Amz-Signature=test"}
            )
        )
        async with httpx.AsyncClient(transport=transport) as client:
            try:
                await outline_slide_import.read_outline_image(client, settings, uuid4())
            except HTTPException as error:
                assert error.status_code == 502
            else:
                raise AssertionError("Unexpected storage origin was accepted")

    asyncio.run(get())
    assert not contacted
