# Plaude STT

Local web app for signing in to Plaud through the real `web.plaud.ai` session
and downloading Plaud recorder audio files.

## Run with Docker

```bash
cp .env.example .env
```

Fill `.env` before starting. At minimum set:

```bash
PLAUDE_APP_SECRET=<32-byte hex or base64 secret>
APP_LOGIN_ID=<login id>
APP_LOGIN_PASSWORD_HASH=<pbkdf2-sha256 base64url hash>
APP_LOGIN_PASSWORD_SALT=<random salt>
```

Generate a stable app secret:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Generate a password hash:

```bash
APP_LOGIN_PASSWORD='replace-me' node -e 'const crypto=require("node:crypto"); const password=process.env.APP_LOGIN_PASSWORD; const salt=crypto.randomBytes(16).toString("base64url"); console.log(`APP_LOGIN_PASSWORD_SALT=${salt}`); console.log(`APP_LOGIN_PASSWORD_HASH=${crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("base64url")}`);'
```

Start the app:

```bash
docker compose up -d --build
```

Open `http://localhost:3000`.

The Docker image includes `ffmpeg` and stores encrypted app state, synced Plaud
audio, and transcript data in the `plaude-data` Docker volume mounted at
`/app/data`.

## Run without Docker

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The first screen is a local app login. No public default password is shipped;
configure `APP_LOGIN_PASSWORD_HASH`/`APP_LOGIN_PASSWORD_SALT` or use
`APP_LOGIN_PASSWORD` for local-only testing.

## Deployment env

Set a stable app secret before deployment so encrypted API keys and login
sessions survive restarts:

```bash
PLAUDE_APP_SECRET=<32-byte hex or base64 secret>
APP_LOGIN_ID=<login id>
APP_LOGIN_PASSWORD_HASH=<pbkdf2-sha256 base64url hash>
APP_LOGIN_PASSWORD_SALT=<random salt>
```

For local-only testing, `APP_LOGIN_PASSWORD=<plain password>` is also supported.
Do not use the plaintext password variable in hosted deployments.
Login cookies automatically use `Secure` only when the request is HTTPS. If an
HTTPS reverse proxy does not send `X-Forwarded-Proto: https`, set
`APP_AUTH_COOKIE_SECURE=true`.

Generate a password hash with:

```bash
APP_LOGIN_PASSWORD='replace-me' node -e 'const crypto=require("node:crypto"); const password=process.env.APP_LOGIN_PASSWORD; const salt=crypto.randomBytes(16).toString("base64url"); console.log({salt, hash: crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("base64url")});'
```

## Connector

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked extension from `extension/`.
4. Reload `http://localhost:3000`.
5. Press `Continue with Plaud` and sign in on `web.plaud.ai`.

The connector reads the post-login Plaud access token from Plaud's own web
session and returns it to this local app. The app stores the token encrypted in
`data/db.json`; audio files are saved in `data/audio/`.

## Official Plaud OAuth

For a non-GUI Ubuntu server, open the app in a browser, go to Settings, and
press `Connect in browser` under `Plaud web OAuth`. The browser completes the
Plaud authorization page, then the app stores the access and refresh tokens
encrypted in `data/db.json` and refreshes them server-side.

By default this follows Plaud's official CLI flow and uses the fixed callback
`http://localhost:8199/auth/callback`. If the app runs on a remote server, open
the app through SSH tunnels for both the app port and callback port:

```bash
ssh -L 3000:localhost:3000 -L 8199:localhost:8199 user@server
```

Then browse to `http://localhost:3000` and press `Connect in browser`.

On Linux, `docker-compose.yml` runs the app with host networking. The app listens
on `${APP_PORT:-3000}` directly on the host, and the Plaud loopback callback
listens on `${PLAUD_OAUTH_LOOPBACK_PORT:-8199}`. Use an SSH tunnel for both ports
when operating the server remotely.

Optional deployment overrides:

```bash
APP_BASE_URL=https://your-app.example.com
PLAUD_OAUTH_REDIRECT_URI=https://your-app.example.com/api/plaud/auth/oauth/callback
PLAUD_OAUTH_API_BASE=https://platform.plaud.ai/developer/api
PLAUD_REFRESH_URL=https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh
```

`APP_BASE_URL` should be the URL your browser uses to open this app. Use
`PLAUD_OAUTH_REDIRECT_URI` only if you have a Plaud OAuth client that allows
that exact registered callback URL. The built-in Plaud CLI client works best
with the default `localhost:8199` callback.

## Korean STT

1. Open the app.
2. In `OpenRouter STT`, paste an OpenRouter API key.
3. Pick a preset. The default is `openai/whisper-large-v3-turbo`; `openrouter/auto`
   is available as an experimental preset with fallback.
4. Sync a Plaud recording so the MP3 exists locally.
5. Press the row transcription button, or select rows and press `Transcribe selected`.

The app converts audio to 16 kHz mono WAV chunks with `ffmpeg`, sends each chunk
to `https://openrouter.ai/api/v1/audio/transcriptions` with `language: "ko"`,
and merges the chunk transcripts. This avoids a practical length ceiling for
long recordings.

Transcript cleanup defaults to `deepseek/deepseek-v4-flash` through OpenRouter
when no cleanup base URL is configured. For Codex via CLIProxyAPI, set:

```env
POSTPROCESS_BASE_URL=http://127.0.0.1:8317/v1
POSTPROCESS_API_KEY=<cli-proxy-api-key>
POSTPROCESS_MODEL=gpt-5.3-codex-spark
```

Long transcripts are split into chunks and cleaned in parallel; batch cleanup
runs two recordings at once by default. Tune it with
`CLEANUP_RECORDING_CONCURRENCY=1..3`.

Automation can be enabled from Settings. Auto sync periodically downloads Plaud
recordings on the server, and auto transcription processes newly downloaded local
audio for the currently selected STT model with a configurable per-run batch size.

## OpenClaw Auto-send

The app can send the final transcript to OpenClaw after STT completes and LLM
cleanup succeeds. It calls OpenClaw's hook agent endpoint, usually:

```text
http://127.0.0.1:18789/hooks/agent
```

Enable OpenClaw hooks in the OpenClaw Gateway config with a dedicated hook token,
then paste that URL and token in this app's Settings -> OpenClaw. The Docker
deployment uses host networking on Ubuntu, so `127.0.0.1:18789` points at the
OpenClaw Gateway running on the same host without a separate proxy container.

Optional env overrides:

```bash
OPENCLAW_ENABLED=true
OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/hooks/agent
OPENCLAW_HOOK_TOKEN=<shared hook token>
OPENCLAW_MODEL=
OPENCLAW_THINKING=
OPENCLAW_DELIVER=false
OPENCLAW_DELIVERY_CHANNEL=discord
OPENCLAW_DELIVERY_TARGET=<discord user or channel id>
```

OpenClaw sends use an idempotency key derived from the recording, STT model, and
final transcript hash. If cleanup is enabled and fails, the transcript is not
sent; after a successful cleanup retry, it is sent automatically.
When `OPENCLAW_DELIVER=true`, `OPENCLAW_DELIVERY_CHANNEL=discord`, and a delivery
target is set, OpenClaw sends the agent reply back through Discord after it
processes the transcript.

## Notes

This project reimplements the Plaud connection and sync flow used by
`riffado/riffado` and its connector. Those projects are AGPL-3.0 licensed, so
keep this project under AGPL-compatible terms if you distribute it.
