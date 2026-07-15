import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, ErrorCode } from "@/lib/errors";
import { savePlaudOAuthConnection } from "@/lib/plaud/oauth-connection";
import {
  createPlaudOAuthAuthorizationRequest,
  exchangePlaudOAuthCode
} from "@/lib/plaud/oauth";

const CALLBACK_PORT = 8199;
const CALLBACK_HOST = process.env.PLAUD_OAUTH_LOOPBACK_HOST?.trim() || "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const PENDING_TTL_MS = 10 * 60 * 1000;
const HEALTH_PATH = "/__plaude-stt/oauth-loopback/health";
const PENDING_PATH = join(process.cwd(), "data", "plaud-oauth-pending.json");

interface PendingOAuthRequest {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appOrigin: string;
  expiresAt: number;
}

interface GlobalLoopbackState {
  server?: ReturnType<typeof createServer>;
  pending: Map<string, PendingOAuthRequest>;
  closeTimer?: NodeJS.Timeout;
}

const loopbackState: GlobalLoopbackState =
  ((globalThis as typeof globalThis & {
    __plaudOAuthLoopback?: GlobalLoopbackState;
  }).__plaudOAuthLoopback ??= {
    pending: new Map()
  });

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function writeHtml(
  response: ServerResponse,
  pending: PendingOAuthRequest | undefined,
  status: "success" | "error",
  message: string
): void {
  const appOrigin = pending?.appOrigin ?? "*";
  const payload = JSON.stringify({
    type: "plaud-oauth",
    status,
    message
  });
  const targetOrigin = JSON.stringify(appOrigin);
  response.writeHead(status === "success" ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Plaud OAuth</title>
    <style>
      body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#f6f8f5;color:#18201b}
      main{width:min(420px,calc(100vw - 32px));border:1px solid #d8ded6;border-radius:8px;background:#fbfdfb;padding:22px;box-shadow:0 16px 44px rgba(28,42,32,.12)}
      h1{font-size:1rem;margin:0 0 8px}p{margin:0;color:#526158;line-height:1.5;font-size:.92rem}
    </style>
  </head>
  <body>
    <main>
      <h1>${status === "success" ? "Plaud connected" : "Plaud connection failed"}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
    <script>
      const payload = ${payload};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, ${targetOrigin});
        window.setTimeout(() => window.close(), 450);
      }
    </script>
  </body>
</html>`);
}

async function readPendingFile(): Promise<Record<string, PendingOAuthRequest>> {
  try {
    const parsed = JSON.parse(await readFile(PENDING_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, PendingOAuthRequest>;
  } catch {
    return {};
  }
}

async function writePendingFile(
  pending: Record<string, PendingOAuthRequest>
): Promise<void> {
  await mkdir(dirname(PENDING_PATH), { recursive: true });
  const tmpPath = `${PENDING_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  await rename(tmpPath, PENDING_PATH);
}

async function cleanupPending(): Promise<void> {
  const now = Date.now();
  for (const [state, pending] of loopbackState.pending) {
    if (pending.expiresAt <= now) loopbackState.pending.delete(state);
  }
  const filePending = await readPendingFile();
  let changed = false;
  for (const [state, pending] of Object.entries(filePending)) {
    if (pending.expiresAt <= now) {
      delete filePending[state];
      changed = true;
    }
  }
  if (changed) await writePendingFile(filePending);
}

async function upsertPending(pending: PendingOAuthRequest): Promise<void> {
  loopbackState.pending.set(pending.state, pending);
  const filePending = await readPendingFile();
  filePending[pending.state] = pending;
  await writePendingFile(filePending);
}

async function getPending(state: string): Promise<PendingOAuthRequest | undefined> {
  return loopbackState.pending.get(state) ?? (await readPendingFile())[state];
}

async function deletePending(state: string): Promise<void> {
  loopbackState.pending.delete(state);
  const filePending = await readPendingFile();
  if (filePending[state]) {
    delete filePending[state];
    await writePendingFile(filePending);
  }
  if (Object.keys(filePending).length === 0) {
    await rm(PENDING_PATH).catch(() => undefined);
  }
}

async function pendingCount(): Promise<number> {
  await cleanupPending();
  return loopbackState.pending.size + Object.keys(await readPendingFile()).length;
}

function scheduleIdleClose(): void {
  if (loopbackState.closeTimer) clearTimeout(loopbackState.closeTimer);
  loopbackState.closeTimer = setTimeout(() => {
    void pendingCount().then((count) => {
      if (count > 0 || !loopbackState.server?.listening) return;
      loopbackState.server.close(() => {
        loopbackState.server = undefined;
      });
    });
  }, PENDING_TTL_MS + 1000);
  loopbackState.closeTimer.unref?.();
}

async function closeIfIdle(): Promise<void> {
  if ((await pendingCount()) > 0 || !loopbackState.server?.listening) return;
  await new Promise<void>((resolve) => {
    loopbackState.server?.close(() => resolve());
  });
  loopbackState.server = undefined;
}

function parseCallbackUrl(callbackUrl: string): URL {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Paste the complete Plaud OAuth callback URL from the browser address bar.",
      400,
      { field: "callbackUrl" }
    );
  }

  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== CALLBACK_PATH) {
    throw new AppError(
      ErrorCode.InvalidInput,
      `Plaud OAuth callback URL must use the ${CALLBACK_PATH} path.`,
      400,
      { field: "callbackUrl" }
    );
  }
  return url;
}

async function completeCallbackUrl(
  url: URL
): Promise<PendingOAuthRequest> {
  await cleanupPending();
  const state = url.searchParams.get("state") ?? "";
  const pending = await getPending(state);

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      url.searchParams.get("error_description") || upstreamError,
      401
    );
  }
  if (!state || !pending) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "OAuth state expired. Start Plaud web connect again and paste the new callback URL.",
      401
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new AppError(
      ErrorCode.MissingRequiredField,
      "Plaud OAuth callback URL did not include an authorization code.",
      400
    );
  }

  const tokenSet = await exchangePlaudOAuthCode(
    code,
    pending.codeVerifier,
    pending.redirectUri,
    pending.state
  );
  await savePlaudOAuthConnection({ tokenSet });
  await deletePending(state);
  void closeIfIdle();
  return pending;
}

export async function completePlaudLoopbackOAuthCallback(
  callbackUrl: string
): Promise<void> {
  await completeCallbackUrl(parseCallbackUrl(callbackUrl));
}

async function handleCallback(requestUrl: string | undefined, response: ServerResponse) {
  const url = new URL(requestUrl ?? "/", CALLBACK_URI);
  if (url.pathname === HEALTH_PATH) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "plaude-stt-oauth-loopback" }));
    return;
  }
  if (url.pathname !== CALLBACK_PATH) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const state = url.searchParams.get("state") ?? "";
  const pending = state ? await getPending(state) : undefined;

  try {
    const completed = await completeCallbackUrl(url);
    writeHtml(response, completed, "success", "You can close this window.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plaud OAuth failed.";
    writeHtml(response, pending, "error", message);
  }
}

async function isExistingLoopbackOurs(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${CALLBACK_PORT}${HEALTH_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as {
      service?: unknown;
    } | null;
    return body?.service === "plaude-stt-oauth-loopback";
  } catch {
    return false;
  }
}

async function ensureLoopbackServer(): Promise<void> {
  if (loopbackState.server?.listening) return;

  const server = createServer((request, response) => {
    void handleCallback(request.url, response);
  });
  let reusedExistingServer = false;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EADDRINUSE" &&
      (await isExistingLoopbackOurs())
    ) {
      reusedExistingServer = true;
      return;
    }
    throw new AppError(
      ErrorCode.PlaudApiError,
      `Could not start Plaud OAuth callback server on localhost:${CALLBACK_PORT}. Another process is using that port.`,
      400,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  });

  if (!reusedExistingServer) {
    loopbackState.server = server;
    scheduleIdleClose();
  }
}

export async function createPlaudLoopbackAuthorizationUrl(
  appOrigin: string
): Promise<string> {
  await cleanupPending();
  await ensureLoopbackServer();
  const authorization = createPlaudOAuthAuthorizationRequest(CALLBACK_URI);
  await upsertPending({
    state: authorization.state,
    codeVerifier: authorization.codeVerifier,
    redirectUri: authorization.redirectUri,
    appOrigin,
    expiresAt: Date.now() + PENDING_TTL_MS
  });
  scheduleIdleClose();
  return authorization.url;
}
