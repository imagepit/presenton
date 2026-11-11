"""Shared transaction boundary for presentation and slide writes."""
import uuid

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import attributes
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
