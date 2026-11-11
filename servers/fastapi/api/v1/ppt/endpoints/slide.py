import logging
from typing import Annotated, Optional
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
import uuid

from models.sql.presentation import PresentationModel
from models.sql.slide import SlideModel
from models.presentation_with_slides import PresentationWithSlides
from models.slide_edit_request import SlideCreateRequest, SlideEditRequest, SlideOrderRequest, SlideEditResult
from services import slide_service
from services.database import get_async_session
from services.image_generation_service import ImageGenerationService
from services.mem0_presentation_memory_service import (
    MEM0_PRESENTATION_MEMORY_SERVICE,
)
from utils.asset_directory_utils import get_images_directory
from utils.llm_calls.edit_slide import get_edited_slide_content
from utils.llm_calls.edit_slide_html import get_edited_slide_html
from utils.llm_calls.select_slide_type_on_edit import get_slide_layout_from_prompt
from utils.process_slides import (
    image_target_sizes_from_template,
    process_old_and_new_slides_and_fetch_assets,
)
from api.v1.ppt.endpoints.presentation import (
    _apply_template_content_to_ui,
    _presentation_response_data,
    _get_presentation_stream_layout,
    _hydrate_template_slide_ui,
    _template_slide_ui,
)


SLIDE_ROUTER = APIRouter(prefix="/slide", tags=["Slide"])
LOGGER = logging.getLogger(__name__)


def _is_template_layout_payload(layout: object) -> bool:
    return isinstance(layout, dict) and isinstance(layout.get("layouts"), list)


@SLIDE_ROUTER.post("/edit")
async def edit_slide(
    id: Annotated[uuid.UUID, Body()],
    prompt: Annotated[str, Body()],
    sql_session: AsyncSession = Depends(get_async_session),
):
    slide = await sql_session.get(SlideModel, id)
    if not slide:
        raise HTTPException(status_code=404, detail="Slide not found")
    presentation = await sql_session.get(PresentationModel, slide.presentation)
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    memory_context = await MEM0_PRESENTATION_MEMORY_SERVICE.retrieve_context(
        presentation.id,
        prompt,
    )

    presentation_layout = _get_presentation_stream_layout(presentation)
    slide_layout = await get_slide_layout_from_prompt(
        prompt,
        presentation_layout,
        slide,
        memory_context,
    )

    edited_slide_content = await get_edited_slide_content(
        prompt,
        slide,
        presentation.language,
        slide_layout,
        presentation.tone,
        presentation.verbosity,
        presentation.instructions,
        memory_context,
    )

    image_generation_service = ImageGenerationService(get_images_directory())

    # This will mutate edited_slide_content
    image_warnings: list[dict] = []
    new_assets = await process_old_and_new_slides_and_fetch_assets(
        image_generation_service,
        slide.content,
        edited_slide_content,
        icon_weight=presentation_layout.icon_weight,
        use_template_asset_fields=(
            _is_template_layout_payload(presentation.layout)
            or isinstance(slide.ui, dict)
        ),
        allow_image_fallback=True,
        image_warnings=image_warnings,
        old_image_target_sizes=image_target_sizes_from_template(
            _template_slide_ui(presentation.layout, slide.layout) or slide.ui,
            slide.content,
            _apply_template_content_to_ui,
        ),
        new_image_target_sizes=image_target_sizes_from_template(
            _template_slide_ui(presentation.layout, slide_layout.id),
            edited_slide_content,
            _apply_template_content_to_ui,
        ),
    )
    for warning in image_warnings:
        LOGGER.warning(
            "Slide edit image generation warning: presentation_id=%s slide_id=%s detail=%s",
            presentation.id,
            slide.id,
            warning.get("detail"),
        )

    # Always assign a new unique id to the slide
    slide.id = uuid.uuid4()

    sql_session.add(slide)
    slide.content = edited_slide_content
    if (
        slide.layout != slide_layout.id
        and _is_template_layout_payload(presentation.layout)
    ):
        slide.ui = _template_slide_ui(presentation.layout, slide_layout.id)
    slide.layout = slide_layout.id
    _hydrate_template_slide_ui(slide, presentation.layout)
    slide.speaker_note = edited_slide_content.get("__speaker_note__", "")
    sql_session.add_all(new_assets)
    await sql_session.commit()

    await MEM0_PRESENTATION_MEMORY_SERVICE.store_slide_edit(
        presentation_id=presentation.id,
        slide_index=slide.index,
        edit_prompt=prompt,
        edited_slide_content=edited_slide_content,
    )

    return slide


@SLIDE_ROUTER.post("/edit-html", response_model=SlideModel)
async def edit_slide_html(
    id: Annotated[uuid.UUID, Body()],
    prompt: Annotated[str, Body()],
    html: Annotated[Optional[str], Body()] = None,
    sql_session: AsyncSession = Depends(get_async_session),
):
    slide = await sql_session.get(SlideModel, id)
    if not slide:
        raise HTTPException(status_code=404, detail="Slide not found")

    presentation = await sql_session.get(PresentationModel, slide.presentation)
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    html_to_edit = html or slide.html_content
    if not html_to_edit:
        raise HTTPException(status_code=400, detail="No HTML to edit")

    memory_context = await MEM0_PRESENTATION_MEMORY_SERVICE.retrieve_context(
        presentation.id,
        prompt,
    )

    edited_slide_html = await get_edited_slide_html(
        prompt,
        html_to_edit,
        memory_context,
    )

    # Always assign a new unique id to the slide
    # This is to ensure that the nextjs can track slide updates
    slide.id = uuid.uuid4()

    sql_session.add(slide)
    slide.html_content = edited_slide_html
    await sql_session.commit()

    await MEM0_PRESENTATION_MEMORY_SERVICE.store_slide_edit(
        presentation_id=presentation.id,
        slide_index=slide.index,
        edit_prompt=prompt,
        edited_slide_content=edited_slide_html,
    )

    return slide


@SLIDE_ROUTER.get(
    "/{presentation_id}/{slide_id}",
    response_model=SlideEditResult,
    operation_id="get_slide",
)
async def get_slide(
    presentation_id: uuid.UUID,
    slide_id: uuid.UUID,
    sql_session: AsyncSession = Depends(get_async_session),
):
    presentation, slides = await slide_service.load_deck_slides(
        sql_session, presentation_id
    )
    slide = slide_service.find_deck_slide(slides, slide_id)
    return SlideEditResult(edit_revision=presentation.edit_revision, slide=slide)


@SLIDE_ROUTER.patch(
    "/{presentation_id}/{slide_id}",
    response_model=SlideEditResult,
    operation_id="update_slide",
)
async def update_slide(
    presentation_id: uuid.UUID,
    slide_id: uuid.UUID,
    data: SlideEditRequest,
    sql_session: AsyncSession = Depends(get_async_session),
):
    presentation, slide = await slide_service.save_slide_changes(
        sql_session, presentation_id, slide_id, data
    )
    return SlideEditResult(edit_revision=presentation.edit_revision, slide=slide)


@SLIDE_ROUTER.post(
    "/{presentation_id}",
    response_model=PresentationWithSlides,
    operation_id="add_slide",
)
async def add_slide(
    presentation_id: uuid.UUID,
    data: SlideCreateRequest,
    sql_session: AsyncSession = Depends(get_async_session),
):
    presentation, slides = await slide_service.insert_slide(
        sql_session, presentation_id, data
    )
    return PresentationWithSlides(
        **_presentation_response_data(presentation), slides=slides
    )


@SLIDE_ROUTER.delete(
    "/{presentation_id}/{slide_id}",
    response_model=PresentationWithSlides,
    operation_id="delete_slide",
)
async def delete_slide(
    presentation_id: uuid.UUID,
    slide_id: uuid.UUID,
    expected_revision: Annotated[int, Body(embed=True, ge=0)],
    sql_session: AsyncSession = Depends(get_async_session),
):
    presentation, slides = await slide_service.remove_slide(
        sql_session, presentation_id, slide_id, expected_revision
    )
    return PresentationWithSlides(
        **_presentation_response_data(presentation), slides=slides
    )


@SLIDE_ROUTER.post(
    "/{presentation_id}/order",
    response_model=PresentationWithSlides,
    operation_id="reorder_slides",
)
async def order_slides(
    presentation_id: uuid.UUID,
    data: SlideOrderRequest,
    sql_session: AsyncSession = Depends(get_async_session),
):
    presentation, slides = await slide_service.reorder_slides(
        sql_session, presentation_id, data
    )
    return PresentationWithSlides(
        **_presentation_response_data(presentation), slides=slides
    )
