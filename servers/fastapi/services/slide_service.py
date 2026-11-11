"""Shared transaction boundary for presentation and slide writes."""
import uuid

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import attributes
from sqlalchemy.ext.asyncio import AsyncSession
from models.slide_edit_request import SlideCreateRequest, SlideEditRequest, SlideOrderRequest
from sqlmodel import Session

from api.v1.auth.context import get_current_owner_id
from models.sql.presentation import PresentationModel
from models.sql.slide import SlideModel


class PresentationConflict(HTTPException):
    def __init__(self, current_revision: int):
        super().__init__(409, {
            "code": "presentation_conflict",
            "message": "This presentation changed. Reload it before saving again.",
            "current_revision": current_revision,
        })


def require_revision(presentation: PresentationModel, expected_revision: int | None) -> None:
    if expected_revision is None:
        raise HTTPException(428, "expected_revision is required. Reload the presentation before saving.")
    if presentation.edit_revision != expected_revision:
        raise PresentationConflict(presentation.edit_revision)


def claim_revision(session: Session, presentation: PresentationModel) -> None:
    """Claim one revision for all writes in the current database transaction."""
    owner_id = presentation.owner_id
    authenticated_owner = get_current_owner_id()
    if authenticated_owner is not None and owner_id != authenticated_owner:
        raise HTTPException(404, "Presentation not found")
    claimed = session.info.setdefault("presentation_revision_claims", {})
    if presentation.id in claimed:
        return
    expected = session.info.get("presentation_read_revisions", {}).get(presentation.id, presentation.edit_revision)
    with session.no_autoflush:
        result = session.execute(
            update(PresentationModel)
            .where(
                PresentationModel.id == presentation.id,
                PresentationModel.owner_id == owner_id,
                PresentationModel.edit_revision == expected,
            )
            .values(edit_revision=expected + 1)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:
            current = session.scalar(select(PresentationModel.edit_revision).where(
                PresentationModel.id == presentation.id,
                PresentationModel.owner_id == owner_id,
            ))
            if current is None:
                raise HTTPException(404, "Presentation not found")
            raise PresentationConflict(current)
    attributes.set_committed_value(presentation, "edit_revision", expected + 1)
    claimed[presentation.id] = expected + 1


def protect_presentation_writes(session: Session, _flush_context, _instances) -> None:
    """Cover ORM writes from autosave, AI editing, chat and generation equally."""
    new_presentations = {row.id for row in session.new if isinstance(row, PresentationModel)}
    presentations: dict[uuid.UUID, PresentationModel] = {}
    changed = list(session.new) + list(session.dirty) + list(session.deleted)
    with session.no_autoflush:
        for row in changed:
            if isinstance(row, PresentationModel):
                if row.id not in new_presentations and (row in session.deleted or session.is_modified(row)):
                    presentations[row.id] = row
            elif isinstance(row, SlideModel) and row.presentation not in new_presentations:
                presentation = session.get(PresentationModel, row.presentation)
                if presentation is None or row.owner_id != presentation.owner_id:
                    raise HTTPException(404, "Presentation or slide not found")
                presentations[presentation.id] = presentation
        for presentation in presentations.values():
            claim_revision(session, presentation)


def remember_presentation_revision(session: Session, row) -> None:
    if isinstance(row, PresentationModel):
        session.info.setdefault("presentation_read_revisions", {}).setdefault(row.id, row.edit_revision)


def clear_revision_claims(session: Session) -> None:
    claimed = session.info.pop("presentation_revision_claims", {})
    session.info.setdefault("presentation_read_revisions", {}).update(claimed)


def discard_revision_claims(session: Session) -> None:
    session.info.pop("presentation_revision_claims", None)
    session.info.pop("presentation_read_revisions", None)




async def load_deck_slides(session: AsyncSession, presentation_id: uuid.UUID) -> tuple[PresentationModel, list[SlideModel]]:
    presentation = await session.get(PresentationModel, presentation_id)
    if presentation is None:
        raise HTTPException(404, "Presentation not found")
    owner_id = get_current_owner_id()
    if owner_id is not None and presentation.owner_id != owner_id:
        raise HTTPException(404, "Presentation not found")
    slides = list(
        await session.scalars(
            select(SlideModel)
            .where(
                SlideModel.presentation == presentation.id,
                SlideModel.owner_id == presentation.owner_id,
            )
            .order_by(SlideModel.index)
        )
    )
    return presentation, slides


def find_deck_slide(slides: list[SlideModel], slide_id: uuid.UUID) -> SlideModel:
    for slide in slides:
        if slide.id == slide_id:
            return slide
    raise HTTPException(404, "Slide not found in the supplied presentation")


async def save_slide_changes(
    session: AsyncSession,
    presentation_id: uuid.UUID,
    slide_id: uuid.UUID,
    request: SlideEditRequest,
) -> tuple[PresentationModel, SlideModel]:
    presentation, slides = await load_deck_slides(session, presentation_id)
    require_revision(presentation, request.expected_revision)
    slide = find_deck_slide(slides, slide_id)
    changes = request.changes.model_dump(exclude_unset=True)
    if not changes or changes.get("content", {}) is None:
        raise HTTPException(
            422, "Supply at least one change. Slide content cannot be null."
        )
    slide.sqlmodel_update(changes)
    if "content" in changes:
        from api.v1.ppt.endpoints.presentation import _hydrate_template_slide_ui

        _hydrate_template_slide_ui(slide, presentation.layout)
    await session.commit()
    return presentation, slide


async def insert_slide(
    session: AsyncSession, presentation_id: uuid.UUID, request: SlideCreateRequest
) -> tuple[PresentationModel, list[SlideModel]]:
    from constants.presentation import MAX_NUMBER_OF_SLIDES

    presentation, slides = await load_deck_slides(session, presentation_id)
    require_revision(presentation, request.expected_revision)
    if len(slides) >= MAX_NUMBER_OF_SLIDES:
        raise HTTPException(400, "Presentation has reached the slide limit")
    position = len(slides) if request.position is None else request.position
    if position > len(slides):
        raise HTTPException(422, "Slide position is outside the presentation")
    slide = SlideModel(
        presentation=presentation.id,
        owner_id=presentation.owner_id,
        index=position,
        **request.model_dump(exclude={"position", "expected_revision"}),
    )
    from api.v1.ppt.endpoints.presentation import _hydrate_template_slide_ui

    _hydrate_template_slide_ui(slide, presentation.layout)
    slides.insert(position, slide)
    for index, item in enumerate(slides):
        item.index = index
    presentation.n_slides = len(slides)
    session.add(slide)
    await session.commit()
    return presentation, slides


async def remove_slide(
    session: AsyncSession,
    presentation_id: uuid.UUID,
    slide_id: uuid.UUID,
    expected_revision: int,
) -> tuple[PresentationModel, list[SlideModel]]:
    presentation, slides = await load_deck_slides(session, presentation_id)
    require_revision(presentation, expected_revision)
    slide = find_deck_slide(slides, slide_id)
    if len(slides) <= 1:
        raise HTTPException(400, "A presentation must retain at least one slide")
    slides.remove(slide)
    await session.delete(slide)
    for index, item in enumerate(slides):
        item.index = index
    presentation.n_slides = len(slides)
    await session.commit()
    return presentation, slides


async def reorder_slides(
    session: AsyncSession, presentation_id: uuid.UUID, request: SlideOrderRequest
) -> tuple[PresentationModel, list[SlideModel]]:
    presentation, slides = await load_deck_slides(session, presentation_id)
    require_revision(presentation, request.expected_revision)
    if len(request.slide_ids) != len(slides) or set(request.slide_ids) != {
        slide.id for slide in slides
    }:
        raise HTTPException(422, "slide_ids must contain every slide exactly once")
    by_id = {slide.id: slide for slide in slides}
    ordered = [by_id[slide_id] for slide_id in request.slide_ids]
    for index, slide in enumerate(ordered):
        slide.index = index
    await session.commit()
    return presentation, ordered
