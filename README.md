# Plaud to OpenClaw

FastAPI gateway for receiving Plaud transcripts from Zapier and forwarding them
to a remote OpenClaw server.

## Configuration

Set these environment variables before running the server:

```sh
export WEBHOOK_TOKEN="shared-zapier-token"
export OPENCLAW_WEBHOOK_URL="https://openclaw.example/webhook"
export OPENCLAW_AUTH_TOKEN="optional-openclaw-token"
export OPENCLAW_TIMEOUT_SECONDS="60"
```

`OPENCLAW_AUTH_TOKEN` is optional. When set, the app sends it to the remote
OpenClaw server as `Authorization: Bearer <token>`.

If the gateway runs on the same host as OpenClaw, use CLI mode instead:

```sh
export WEBHOOK_TOKEN="shared-zapier-token"
export OPENCLAW_MODE="cli"
export OPENCLAW_CLI_PATH="/home/dpp/.npm-global/bin/openclaw"
export OPENCLAW_SESSION_KEY="agent:main:discord:direct:652697683777028131"
export OPENCLAW_DELIVER="true"
export OPENCLAW_REPLY_CHANNEL="discord"
export OPENCLAW_REPLY_TO="user:652697683777028131"
export OPENCLAW_TIMEOUT_SECONDS="600"
```

## Run

```sh
uv sync
uv run python -m app
```

The default port is `9999`. Override it with `PORT` if needed.

Zapier should call:

```sh
curl -X POST "http://localhost:9999/" \
  -H "Authorization: Bearer shared-zapier-token" \
  -H "Content-Type: application/json" \
  -d '{"text":"Plaud transcript text here"}'
```

The app also accepts `text` from form data or the query string.
