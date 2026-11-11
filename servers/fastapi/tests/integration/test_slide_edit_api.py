import asyncio
import copy
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from api.v1.ppt.endpoints import slide as slide_endpoint
from api.v1.ppt.endpoints.presentation import PRESENTATION_ROUTER
from models.sql.presentation import PresentationModel, PresentationVersion
from models.sql.slide import SlideModel
from services.database import get_async_session


def _template_layout():
    return {
        "id": "title",
        "description": "Title slide",
        "components": [
            {
                "id": "hero",
                "description": "Main heading",
                "elements": [
                    {
                        "type": "text",
                        "decorative": False,
                        "name": "headline",
                        "runs": [{"text": "Original heading"}],
                    }
                ],
            }
        ],
    }


@pytest.fixture
def slide_edit_client(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'slides.db'}")
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async def create_tables():
        async with engine.begin() as connection:
            await connection.run_sync(PresentationModel.__table__.create)
            await connection.run_sync(SlideModel.__table__.create)

    asyncio.run(create_tables())

    async def override_session():
        async with session_maker() as session:
            yield session

    async def select_layout(_prompt, layout, _slide, _memory):
        assert layout.icon_weight == "bold"
        assert layout.slides[0].id == "title"
        return layout.slides[0]

    selector = AsyncMock(side_effect=select_layout)
    editor = AsyncMock(
        return_value={
            "hero": {"headline": "Edited heading"},
            "__speaker_note__": "Updated speaker note",
        }
    )
    assets = AsyncMock(return_value=[])
    monkeypatch.setattr(slide_endpoint, "get_slide_layout_from_prompt", selector)
    monkeypatch.setattr(slide_endpoint, "get_edited_slide_content", editor)
    monkeypatch.setattr(
        slide_endpoint, "process_old_and_new_slides_and_fetch_assets", assets
    )
    monkeypatch.setattr(slide_endpoint, "get_images_directory", lambda: str(tmp_path))
    monkeypatch.setattr(slide_endpoint, "ImageGenerationService", lambda _path: object())
    monkeypatch.setattr(
        slide_endpoint.MEM0_PRESENTATION_MEMORY_SERVICE,
        "retrieve_context",
        AsyncMock(return_value=""),
    )
    memory = AsyncMock()
    monkeypatch.setattr(
        slide_endpoint.MEM0_PRESENTATION_MEMORY_SERVICE, "store_slide_edit", memory
    )

    app = FastAPI()
    app.include_router(slide_endpoint.SLIDE_ROUTER, prefix="/api/v1/ppt")
    app.include_router(PRESENTATION_ROUTER, prefix="/api/v1/ppt")
    app.dependency_overrides[get_async_session] = override_session
    with TestClient(app, raise_server_exceptions=False) as client:
        yield SimpleNamespace(
            client=client,
            sessions=session_maker,
            selector=selector,
            editor=editor,
            assets=assets,
            memory=memory,
        )
    asyncio.run(engine.dispose())


def _seed_deck(sessions, *, template=True, alternate_layout=False, owner_id=None):
    layout = (
        {"name": "template:qa", "icon_type": "bold", "layouts": [_template_layout()]}
        if template
        else {
            "name": "legacy",
            "icon_type": "bold",
            "slides": [
                {
                    "id": "title",
                    "json_schema": {"type": "object", "properties": {}},
                }
            ],
        }
    )
    if alternate_layout:
        alternate = _template_layout()
        alternate["id"] = "alternate"
        alternate["components"][0]["id"] = "body"
        layout["layouts"].append(alternate)
    presentation = PresentationModel(
        id=uuid.uuid4(),
        owner_id=owner_id,
        version=PresentationVersion.V2_STANDARD,
        content="Slide edit regression",
        n_slides=1,
        language="English",
        layout=layout,
    )
    slide = SlideModel(
        owner_id=owner_id,
        id=uuid.uuid4(),
        presentation=presentation.id,
        index=0,
        layout_group="template:qa" if template else "legacy",
        layout="title",
        content={"hero": {"headline": "Original heading"}},
        speaker_note="Original note",
        ui=copy.deepcopy(_template_layout()) if template else None,
    )
    if slide.ui is not None:
        slide.ui["description"] = "User-adjusted title UI"

    async def seed():
        async with sessions() as session:
            session.add(presentation)
            session.add(slide)
            await session.commit()

    asyncio.run(seed())
    return presentation, slide


@pytest.mark.parametrize("template", [True, False], ids=["template", "legacy"])
def test_slide_edit_persists_content_with_supported_layouts(slide_edit_client, template):
    harness = slide_edit_client
    presentation, slide = _seed_deck(harness.sessions, template=template)
    original_id = slide.id

    response = harness.client.post(
        "/api/v1/ppt/slide/edit",
        json={"id": str(original_id), "prompt": "Change the heading"},
    )

    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["id"] != str(original_id)
    assert edited["content"]["hero"]["headline"] == "Edited heading"
    assert edited["speaker_note"] == "Updated speaker note"
    assert edited["presentation"] == str(presentation.id)
    assert edited["index"] == 0
    assert edited["layout_group"] == slide.layout_group
    assert harness.assets.call_args.kwargs["icon_weight"] == "bold"
    assert harness.assets.call_args.kwargs["use_template_asset_fields"] is template
    harness.memory.assert_awaited_once()

    stored = harness.client.get(f"/api/v1/ppt/presentation/{presentation.id}")
    assert stored.status_code == 200
    assert stored.json()["slides"] == [edited]

    async def saved_slide_ids():
        async with harness.sessions() as session:
            return list(await session.scalars(select(SlideModel.id)))

    assert asyncio.run(saved_slide_ids()) == [uuid.UUID(edited["id"])]


@pytest.mark.parametrize("switch_layout", [False, True], ids=["same", "switch"])
def test_template_slide_edit_hydrates_selected_ui(slide_edit_client, switch_layout):
    harness = slide_edit_client
    presentation, slide = _seed_deck(harness.sessions, alternate_layout=True)
    original_layout = copy.deepcopy(presentation.layout)
    selected_index = 1 if switch_layout else 0
    component_id = "body" if switch_layout else "hero"

    async def select_layout(_prompt, layout, _slide, _memory):
        return layout.slides[selected_index]

    harness.selector.side_effect = select_layout
    harness.editor.return_value = {
        component_id: {"headline": "Edited heading"},
        "__speaker_note__": "Updated speaker note",
    }

    response = harness.client.post(
        "/api/v1/ppt/slide/edit",
        json={"id": str(slide.id), "prompt": "Change the heading"},
    )

    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["layout"] == ("alternate" if switch_layout else "title")
    assert edited["ui"]["id"] == edited["layout"]
    assert edited["ui"]["description"] == (
        "Title slide" if switch_layout else "User-adjusted title UI"
    )
    component = edited["ui"]["components"][0]
    assert component["id"] == component_id
    assert component["elements"][0]["runs"][0]["text"] == "Edited heading"
    stored = harness.client.get(f"/api/v1/ppt/presentation/{presentation.id}")
    assert stored.json()["slides"][0]["ui"] == edited["ui"]

    async def saved_layout():
        async with harness.sessions() as session:
            saved = await session.get(PresentationModel, presentation.id)
            return saved.layout

    assert asyncio.run(saved_layout()) == original_layout


def test_slide_edit_rejects_unknown_slide(slide_edit_client):
    harness = slide_edit_client
    response = harness.client.post(
        "/api/v1/ppt/slide/edit",
        json={"id": str(uuid.uuid4()), "prompt": "Change the heading"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Slide not found"
    harness.selector.assert_not_awaited()
    harness.editor.assert_not_awaited()


def test_failed_ai_edit_leaves_saved_slide_unchanged(slide_edit_client):
    harness = slide_edit_client
    presentation, slide = _seed_deck(harness.sessions)
    url = f"/api/v1/ppt/presentation/{presentation.id}"
    before = harness.client.get(url).json()["slides"]
    harness.editor.side_effect = HTTPException(503, "AI unavailable")

    response = harness.client.post(
        "/api/v1/ppt/slide/edit",
        json={"id": str(slide.id), "prompt": "Change the heading"},
    )

    assert response.status_code == 503
    assert harness.client.get(url).json()["slides"] == before
    harness.assets.assert_not_awaited()
    harness.memory.assert_not_awaited()


def test_autosave_requires_revision_and_preserves_first_save(slide_edit_client):
    client = slide_edit_client.client
    deck, slide = _seed_deck(slide_edit_client.sessions)
    url = f"/api/v1/ppt/presentation/{deck.id}"
    before = client.get(url).json()
    assert before["edit_revision"] == 0
    missing = client.patch("/api/v1/ppt/presentation/update", json={"id": str(deck.id), "title": "Missing"})
    assert missing.status_code == 428
    first = client.patch("/api/v1/ppt/presentation/update", json={"id": str(deck.id), "title": "First", "expected_revision": 0})
    assert first.status_code == 200, first.text
    assert first.json()["edit_revision"] == 1
    stale_slide = {**before["slides"][0], "speaker_note": "Stale"}
    stale = client.patch("/api/v1/ppt/presentation/slide_update", json={"slide": stale_slide, "expected_revision": 0})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current_revision"] == 1
    after = client.get(url).json()
    assert after["title"] == "First"
    assert after["slides"] == before["slides"]
    saved = client.patch("/api/v1/ppt/presentation/slide_update", json={"slide": stale_slide, "expected_revision": 1})
    assert saved.status_code == 200, saved.text
    assert saved.headers["X-Presentation-Revision"] == "2"


def test_whole_deck_save_is_atomic_and_checks_slide_membership(slide_edit_client):
    client = slide_edit_client.client
    first, slide = _seed_deck(slide_edit_client.sessions)
    second, other = _seed_deck(slide_edit_client.sessions)
    first_url = f"/api/v1/ppt/presentation/{first.id}"
    original = client.get(first_url).json()
    invalid = client.patch("/api/v1/ppt/presentation/update", json={
        "id": str(first.id), "expected_revision": 0,
        "title": "Must roll back", "slides": [other.model_dump(mode="json")],
    })
    assert invalid.status_code == 422, invalid.text
    assert client.get(first_url).json() == original
    changed_slide = {**original["slides"][0], "speaker_note": "Kept"}
    saved = client.patch("/api/v1/ppt/presentation/update", json={
        "id": str(first.id), "expected_revision": 0, "slides": [changed_slide],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["edit_revision"] == 1
    assert client.get(first_url).json()["slides"][0]["speaker_note"] == "Kept"
    assert client.get(f"/api/v1/ppt/presentation/{second.id}").json()["slides"][0]["id"] == str(other.id)


def test_late_ai_edit_cannot_overwrite_a_newer_save(slide_edit_client):
    harness = slide_edit_client
    deck, slide = _seed_deck(harness.sessions)
    async def edit_after_concurrent_save(*_args):
        async with harness.sessions() as session:
            newer = await session.get(PresentationModel, deck.id)
            newer.title = "Concurrent save"
            await session.commit()
        return {"hero": {"headline": "Late AI"}}
    harness.editor.side_effect = edit_after_concurrent_save
    response = harness.client.post("/api/v1/ppt/slide/edit", json={"id": str(slide.id), "prompt": "Edit"})
    assert response.status_code == 409, response.text
    after = harness.client.get(f"/api/v1/ppt/presentation/{deck.id}").json()
    assert after["title"] == "Concurrent save"
    assert after["edit_revision"] == 1
    assert after["slides"][0]["id"] == str(slide.id)
    assert after["slides"][0]["content"] == slide.content


def test_read_revision_survives_release_of_parent_orm_reference(slide_edit_client):
    import gc
    from services.slide_service import PresentationConflict
    deck, slide = _seed_deck(slide_edit_client.sessions)
    async def run():
        async with slide_edit_client.sessions() as stale:
            original = await stale.get(PresentationModel, deck.id)
            assert original.edit_revision == 0
            del original
            gc.collect()
            async with slide_edit_client.sessions() as current:
                saved = await current.get(PresentationModel, deck.id)
                saved.title = "Newer user change"
                await current.commit()
            # Chat tools may load the parent again after the model has generated
            # an edit. Retain the original read revision across that reload.
            loaded = await stale.get(PresentationModel, deck.id)
            assert loaded.edit_revision == 1
            edited = await stale.get(SlideModel, slide.id)
            edited.speaker_note = "Late generated edit"
            with pytest.raises(PresentationConflict):
                await stale.commit()
            await stale.rollback()
        async with slide_edit_client.sessions() as current:
            saved = await current.get(SlideModel, slide.id)
            assert saved.speaker_note == "Original note"
    asyncio.run(run())


def test_direct_slide_api_round_trip_and_stale_rejection(slide_edit_client):
    client = slide_edit_client.client
    deck, slide = _seed_deck(slide_edit_client.sessions)
    base = f"/api/v1/ppt/slide/{deck.id}"
    loaded = client.get(f"{base}/{slide.id}")
    assert loaded.status_code == 200
    assert loaded.json()["edit_revision"] == 0
    assert loaded.json()["slide"]["id"] == str(slide.id)
    content = {"hero": {"headline": "Direct edit"}}
    saved = client.patch(f"{base}/{slide.id}", json={"expected_revision": 0, "changes": {"content": content}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["edit_revision"] == 1
    changed = saved.json()["slide"]
    assert changed["content"] == content
    assert changed["ui"]["components"][0]["elements"][0]["runs"][0]["text"] == "Direct edit"
    assert changed["ui"]["description"] == "User-adjusted title UI"
    assert changed["id"] == str(slide.id)
    stale = client.patch(f"{base}/{slide.id}", json={"expected_revision": 0, "changes": {"speaker_note": "Stale"}})
    assert stale.status_code == 409
    added = client.post(base, json={
        "expected_revision": 1, "layout_group": slide.layout_group, "layout": slide.layout,
        "content": {"hero": {"headline": "Second"}}, "position": 0,
    })
    assert added.status_code == 200, added.text
    new_id = added.json()["slides"][0]["id"]
    assert added.json()["edit_revision"] == 2
    assert added.json()["n_slides"] == 2
    ordered = client.post(f"{base}/order", json={"expected_revision": 2, "slide_ids": [str(slide.id), new_id]})
    assert ordered.status_code == 200, ordered.text
    assert [item["id"] for item in ordered.json()["slides"]] == [str(slide.id), new_id]
    assert ordered.json()["edit_revision"] == 3
    deleted = client.request("DELETE", f"{base}/{new_id}", json={"expected_revision": 3})
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["edit_revision"] == 4
    assert deleted.json()["n_slides"] == 1
    assert deleted.json()["slides"][0]["index"] == 0
    final = client.get(f"/api/v1/ppt/presentation/{deck.id}").json()
    assert final["slides"][0]["content"] == content
    assert final["edit_revision"] == 4
    last = client.request("DELETE", f"{base}/{slide.id}", json={"expected_revision": 4})
    assert last.status_code == 400


def test_direct_slide_api_rejects_mismatched_ids_and_invalid_changes(slide_edit_client):
    client = slide_edit_client.client
    deck, slide = _seed_deck(slide_edit_client.sessions)
    other_deck, other_slide = _seed_deck(slide_edit_client.sessions)
    base = f"/api/v1/ppt/slide/{deck.id}"
    assert client.get(f"{base}/{other_slide.id}").status_code == 404
    assert client.patch(f"{base}/{other_slide.id}", json={"expected_revision": 0, "changes": {"speaker_note": "Denied"}}).status_code == 404
    for changes in ({}, {"content": None}, {"owner_id": str(uuid.uuid4())}, {"index": 9}):
        denied = client.patch(f"{base}/{slide.id}", json={"expected_revision": 0, "changes": changes})
        assert denied.status_code == 422, denied.text
    for ids in ([str(slide.id), str(slide.id)], [str(other_slide.id)]):
        denied = client.post(f"{base}/order", json={"expected_revision": 0, "slide_ids": ids})
        assert denied.status_code == 422
    for presentation in (deck, other_deck):
        unchanged = client.get(f"/api/v1/ppt/presentation/{presentation.id}").json()
        assert unchanged["edit_revision"] == 0
        assert len(unchanged["slides"]) == 1


def test_direct_edit_authentication_owner_scope_and_revocation(monkeypatch, tmp_path):
    from tests.integration.test_auth_endpoints import _build_client
    from api import middlewares
    from api.middlewares import SessionAuthMiddleware
    monkeypatch.delenv("DISABLE_AUTH", raising=False)
    monkeypatch.setenv("USER_CONFIG_PATH", str(tmp_path / "config.json"))
    client, engine = _build_client(tmp_path)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async def create_deck_tables():
        async with engine.begin() as connection:
            await connection.run_sync(PresentationModel.__table__.create)
            await connection.run_sync(SlideModel.__table__.create)
    asyncio.run(create_deck_tables())
    monkeypatch.setattr(middlewares, "async_session_maker", sessions)
    client.app.add_middleware(SessionAuthMiddleware)
    client.app.include_router(slide_endpoint.SLIDE_ROUTER, prefix="/api/v1/ppt")
    client.app.include_router(PRESENTATION_ROUTER, prefix="/api/v1/ppt")
    try:
        assert client.post("/api/v1/auth/setup", json={"username": "admin", "password": "secret123"}).status_code == 200
        assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret123"}).status_code == 200
        admin_id = uuid.UUID(client.get("/api/v1/auth/status").json()["user_id"])
        member = client.post("/api/v1/admin/users", json={"username": "member", "password": "secret456"})
        assert member.status_code in (200, 201)
        member_id = uuid.UUID(member.json()["id"])
        issued = client.post("/api/v1/admin/api-keys", json={"user_id": str(admin_id), "label": "editing test"})
        assert issued.status_code == 201
        key = issued.json()
        own, slide = _seed_deck(sessions, owner_id=admin_id)
        other, foreign = _seed_deck(sessions, owner_id=member_id)
        client.cookies.clear()
        own_path = f"/api/v1/ppt/slide/{own.id}/{slide.id}"
        assert client.get(own_path).status_code == 401
        assert client.get(own_path, headers={"Authorization": "Bearer invalid"}).status_code == 401
        headers = {"Authorization": f"Bearer {key['token']}"}
        accessible = client.get(own_path, headers=headers)
        assert accessible.status_code == 200, accessible.text
        assert client.get(f"/api/v1/ppt/slide/{other.id}/{foreign.id}", headers=headers).status_code == 404
        denied = client.patch(f"/api/v1/ppt/slide/{other.id}/{foreign.id}", headers=headers, json={"expected_revision": 0, "changes": {"speaker_note": "Denied"}})
        assert denied.status_code == 404
        changed = client.patch(own_path, headers=headers, json={"expected_revision": 0, "changes": {"speaker_note": "Authorized edit"}})
        assert changed.status_code == 200
        assert changed.json()["edit_revision"] == 1
        assert client.get("/api/v1/ppt/presentation/all", headers=headers).json()[0]["id"] == str(own.id)
        client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret123"})
        assert client.post(f"/api/v1/admin/api-keys/{key['id']}/revoke").status_code == 200
        client.cookies.clear()
        assert client.get(own_path, headers=headers).status_code == 401
    finally:
        client.close()
        asyncio.run(engine.dispose())
