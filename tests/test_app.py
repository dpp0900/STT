import pytest
from fastapi.testclient import TestClient

from app import main
from app.openclaw_client import OpenClawError
from app.settings import get_settings


@pytest.fixture(autouse=True)
def configured_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBHOOK_TOKEN", "zapier-secret")
    monkeypatch.setenv("OPENCLAW_MODE", "http")
    monkeypatch.setenv("OPENCLAW_WEBHOOK_URL", "https://openclaw.example/webhook")
    monkeypatch.setenv("OPENCLAW_AUTH_TOKEN", "openclaw-secret")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer zapier-secret"}


async def fake_submit(
    *,
    text: str,
    request_id: str,
    settings,
) -> dict[str, str]:
    assert text
    assert request_id
    assert settings.openclaw_auth_token.get_secret_value() == "openclaw-secret"
    return {"remote": "accepted"}


def test_accepts_json_text(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "submit_transcript_to_openclaw", fake_submit)

    response = client.post("/", json={"text": "회의는 내일 오후 3시입니다."}, headers=auth_headers)

    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
    assert response.json()["openclaw_response"] == {"remote": "accepted"}


def test_healthz_reports_configured(client: TestClient) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["configured"] is True


def test_accepts_form_text(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "submit_transcript_to_openclaw", fake_submit)

    response = client.post("/", data={"text": "todo: 계약서 검토"}, headers=auth_headers)

    assert response.status_code == 202


def test_accepts_query_text(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "submit_transcript_to_openclaw", fake_submit)

    response = client.post("/?text=calendar%20candidate", headers=auth_headers)

    assert response.status_code == 202


def test_rejects_missing_auth(client: TestClient) -> None:
    response = client.post("/", json={"text": "hello"})

    assert response.status_code == 401


def test_rejects_empty_text(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post("/", json={"text": "   "}, headers=auth_headers)

    assert response.status_code == 422


def test_rejects_invalid_json(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/",
        content="{",
        headers={**auth_headers, "Content-Type": "application/json"},
    )

    assert response.status_code == 400


def test_returns_bad_gateway_when_openclaw_fails(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_submit(**kwargs) -> dict[str, str]:
        raise OpenClawError("remote failed", status_code=500)

    monkeypatch.setattr(main, "submit_transcript_to_openclaw", fail_submit)

    response = client.post("/", json={"text": "일정 등록해줘"}, headers=auth_headers)

    assert response.status_code == 502
