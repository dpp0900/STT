from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    webhook_token: SecretStr = Field(min_length=1)
    openclaw_mode: Literal["http", "cli"] = "http"
    openclaw_webhook_url: AnyHttpUrl | None = None
    openclaw_auth_token: SecretStr | None = None
    openclaw_timeout_seconds: float = Field(default=60.0, gt=0)
    openclaw_cli_path: str = "openclaw"
    openclaw_agent: str = "main"
    openclaw_session_key: str | None = None
    openclaw_deliver: bool = False
    openclaw_reply_channel: str = "discord"
    openclaw_reply_to: str | None = None
    service_name: str = "plaud-to-openclaw"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def require_mode_specific_settings(self) -> "Settings":
        if self.openclaw_mode == "http" and self.openclaw_webhook_url is None:
            raise ValueError("OPENCLAW_WEBHOOK_URL is required when OPENCLAW_MODE=http")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
