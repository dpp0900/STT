import json

import pytest
import httpx

from app.openclaw_client import (
    OpenClawError,
    build_openclaw_cli_message,
    build_openclaw_payload,
    submit_transcript_to_openclaw,
)
from app.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        webhook_token="zapier-secret",
        openclaw_mode="http",
        openclaw_webhook_url="https://openclaw.example/webhook",
        openclaw_auth_token="openclaw-secret",
    )


def test_build_openclaw_payload(settings: Settings) -> None:
    payload = build_openclaw_payload(
        text="다음 주 화요일 오전 10시에 미팅. 민수는 자료 준비.",
        request_id="request-123",
        settings=settings,
    )

    assert payload["source"] == "plaud"
    assert payload["text"].startswith("다음 주")
    assert "Discord" in payload["instruction"]
    assert "Apple Calendar only" in payload["instruction"]
    assert "MacBook Pro node's Apple Calendar osascript route" in payload["instruction"]
    assert "context" in payload["instruction"]
    assert "affiliation" in payload["instruction"]
    assert "project, team, client, customer" in payload["instruction"]
    assert "Do not invent affiliation context" in payload["instruction"]
    assert "Calendar notes" in payload["instruction"]
    assert "calendar_items" in payload["instruction"]
    assert "undated_todos" in payload["instruction"]
    assert "source_type" in payload["instruction"]
    assert "Do not use Apple Reminders" in payload["instruction"]
    assert "OpenClaw cron/reminder fallback" in payload["instruction"]
    assert "or Reminder from MacBook Pro node's skills" not in payload["instruction"]
    assert payload["metadata"]["received_via"] == "zapier"
    assert payload["metadata"]["service"] == "plaud-to-openclaw"
    assert payload["metadata"]["request_id"] == "request-123"
    assert payload["metadata"]["text_length"] == len(payload["text"])


def test_build_openclaw_cli_message(settings: Settings) -> None:
    message = build_openclaw_cli_message(
        text="내일 오전 10시에 캘린더 테스트. TODO는 보고서 작성.",
        request_id="request-cli",
        settings=settings,
    )

    assert "Request ID: request-cli" in message
    assert "Transcript:" in message
    assert "Discord" in message
    assert "Apple Calendar only" in message
    assert "MacBook Pro node's Apple Calendar osascript route" in message
    assert "context" in message
    assert "affiliation" in message
    assert "Do not invent affiliation context" in message
    assert "Calendar notes" in message
    assert "calendar_items" in message
    assert "undated_todos" in message
    assert "Do not use Apple Reminders" in message
    assert "or Reminder from MacBook Pro node's skills" not in message


async def test_submit_transcript_sends_json_and_auth(settings: Settings) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("Authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    result = await submit_transcript_to_openclaw(
        text="오늘 회의에서 금요일까지 견적서 보내기로 함.",
        request_id="request-456",
        settings=settings,
        transport=httpx.MockTransport(handler),
    )

    assert result == {"ok": True}
    assert captured["url"] == "https://openclaw.example/webhook"
    assert captured["authorization"] == "Bearer openclaw-secret"
    assert captured["payload"]["source"] == "plaud"
    assert captured["payload"]["metadata"]["request_id"] == "request-456"


async def test_submit_transcript_wraps_remote_errors(settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "failed"})

    with pytest.raises(OpenClawError) as exc_info:
        await submit_transcript_to_openclaw(
            text="등록 실패 테스트",
            request_id="request-789",
            settings=settings,
            transport=httpx.MockTransport(handler),
        )

    assert exc_info.value.status_code == 500
