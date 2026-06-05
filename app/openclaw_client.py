import asyncio
from datetime import datetime, timezone
import json
from typing import Any

import httpx

from app.settings import Settings


OPENCLAW_INSTRUCTION = (
    "Extract important schedule items and todos from this Plaud transcript. "
    "Send a concise summary to the user's Discord. "
    "Register explicit appointments, meetings, dated TODOs, and deadlines using Apple Calendar only, "
    "via the MacBook Pro node's Apple Calendar osascript route. "
    "Do not use Apple Reminders or OpenClaw cron/reminder fallback unless the user explicitly requests a chat reminder. "
    "If the transcript lets you infer affiliation or ownership context such as project, team, client, customer, "
    "organization, meeting group, or key participants, include that context in Calendar titles when useful and "
    "always include the relevant context and short transcript evidence in Calendar notes. "
    "Do not invent affiliation context; if it is uncertain, say so in the notes. "
    "If a TODO has no date or time, include it in the Discord summary only. "
    "If Calendar registration fails, include the exact failure reason in the Discord summary."
)


class OpenClawError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def build_openclaw_payload(
    *,
    text: str,
    request_id: str,
    settings: Settings,
) -> dict[str, Any]:
    return {
        "source": "plaud",
        "text": text,
        "instruction": OPENCLAW_INSTRUCTION,
        "metadata": {
            "received_via": "zapier",
            "service": settings.service_name,
            "request_id": request_id,
            "text_length": len(text),
            "received_at": datetime.now(timezone.utc).isoformat(),
        },
    }


async def submit_transcript_to_openclaw(
    *,
    text: str,
    request_id: str,
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    if settings.openclaw_mode == "cli":
        return await submit_transcript_to_openclaw_cli(
            text=text,
            request_id=request_id,
            settings=settings,
        )

    return await submit_transcript_to_openclaw_http(
        text=text,
        request_id=request_id,
        settings=settings,
        transport=transport,
    )


async def submit_transcript_to_openclaw_http(
    *,
    text: str,
    request_id: str,
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if settings.openclaw_auth_token is not None:
        headers["Authorization"] = (
            f"Bearer {settings.openclaw_auth_token.get_secret_value()}"
        )

    payload = build_openclaw_payload(
        text=text,
        request_id=request_id,
        settings=settings,
    )

    try:
        async with httpx.AsyncClient(
            timeout=settings.openclaw_timeout_seconds,
            transport=transport,
        ) as client:
            response = await client.post(
                str(settings.openclaw_webhook_url),
                json=payload,
                headers=headers,
            )
    except httpx.TimeoutException as exc:
        raise OpenClawError("Timed out while calling remote OpenClaw server") from exc
    except httpx.HTTPError as exc:
        raise OpenClawError("Failed to call remote OpenClaw server") from exc

    if response.is_error:
        raise OpenClawError(
            "Remote OpenClaw server returned an error",
            status_code=response.status_code,
        )

    if not response.content:
        return {}

    try:
        data = response.json()
    except ValueError:
        return {"raw_response": response.text}

    return data if isinstance(data, dict) else {"response": data}


def build_openclaw_cli_message(
    *,
    text: str,
    request_id: str,
    settings: Settings,
) -> str:
    payload = build_openclaw_payload(
        text=text,
        request_id=request_id,
        settings=settings,
    )
    return (
        f"{payload['instruction']}\n\n"
        f"Request ID: {request_id}\n"
        "Transcript:\n"
        f"{text}"
    )


async def submit_transcript_to_openclaw_cli(
    *,
    text: str,
    request_id: str,
    settings: Settings,
) -> dict[str, Any]:
    message = build_openclaw_cli_message(
        text=text,
        request_id=request_id,
        settings=settings,
    )

    args = [
        settings.openclaw_cli_path,
        "agent",
        "--agent",
        settings.openclaw_agent,
        "--message",
        message,
        "--json",
        "--timeout",
        str(int(settings.openclaw_timeout_seconds)),
    ]

    if settings.openclaw_session_key:
        args.extend(["--session-key", settings.openclaw_session_key])

    if settings.openclaw_deliver:
        args.append("--deliver")
        args.extend(["--reply-channel", settings.openclaw_reply_channel])
        if settings.openclaw_reply_to:
            args.extend(["--reply-to", settings.openclaw_reply_to])

    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise OpenClawError("Failed to start OpenClaw CLI") from exc

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=settings.openclaw_timeout_seconds + 5,
        )
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise OpenClawError("Timed out while running OpenClaw CLI") from exc

    stdout_text = stdout.decode(errors="replace").strip()
    stderr_text = stderr.decode(errors="replace").strip()

    if process.returncode != 0:
        raise OpenClawError(
            f"OpenClaw CLI failed with exit code {process.returncode}: {stderr_text}"
        )

    if not stdout_text:
        return {}

    try:
        data = json.loads(stdout_text)
    except ValueError:
        return {"raw_response": stdout_text, "stderr": stderr_text}

    result = data if isinstance(data, dict) else {"response": data}
    if stderr_text:
        result["stderr"] = stderr_text
    return result
