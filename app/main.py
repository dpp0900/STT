from json import JSONDecodeError
import logging
from typing import Annotated, Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from pydantic import ValidationError

from app.openclaw_client import OpenClawError, submit_transcript_to_openclaw
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

app = FastAPI(title="Plaud to OpenClaw", version="0.1.0")


def require_webhook_auth(
    authorization: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    expected = f"Bearer {settings.webhook_token.get_secret_value()}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
        )


async def extract_text(request: Request, query_text: str | None) -> str:
    text: Any = query_text

    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            body = await request.json()
        except JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
        if isinstance(body, dict) and body.get("text") is not None:
            text = body["text"]
    elif (
        "application/x-www-form-urlencoded" in content_type
        or "multipart/form-data" in content_type
    ):
        form = await request.form()
        form_text = form.get("text")
        if form_text is not None:
            text = form_text

    if not isinstance(text, str) or not text.strip():
        raise HTTPException(
            status_code=422,
            detail="A non-empty text value is required",
        )

    return text.strip()


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    try:
        settings = get_settings()
    except ValidationError as exc:
        return {
            "status": "degraded",
            "configured": False,
            "missing_or_invalid_settings": [
                ".".join(str(part) for part in error["loc"]) for error in exc.errors()
            ],
        }

    return {
        "status": "ok",
        "configured": True,
        "service": settings.service_name,
        "openclaw_mode": settings.openclaw_mode,
        "openclaw_webhook_url_configured": bool(settings.openclaw_webhook_url),
    }


@app.post("/", status_code=status.HTTP_202_ACCEPTED)
async def receive_transcript(
    request: Request,
    query_text: Annotated[str | None, Query(alias="text")] = None,
    _: None = Depends(require_webhook_auth),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    request_id = str(uuid4())
    text = await extract_text(request, query_text)

    logger.info(
        "Received Plaud transcript request_id=%s text_length=%s",
        request_id,
        len(text),
    )

    try:
        openclaw_response = await submit_transcript_to_openclaw(
            text=text,
            request_id=request_id,
            settings=settings,
        )
    except OpenClawError as exc:
        logger.warning(
            "OpenClaw forwarding failed request_id=%s remote_status=%s error=%s",
            request_id,
            exc.status_code,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to forward transcript to remote OpenClaw server",
        ) from exc

    logger.info("Forwarded Plaud transcript request_id=%s", request_id)

    return {
        "status": "accepted",
        "request_id": request_id,
        "openclaw_response": openclaw_response,
    }
