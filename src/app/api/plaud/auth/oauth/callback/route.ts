import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { AppError, ErrorCode, normalizeError } from "@/lib/errors";
import { savePlaudOAuthConnection } from "@/lib/plaud/oauth-connection";
import { exchangePlaudOAuthCode } from "@/lib/plaud/oauth";
import { verifySignedPlaudOAuthState } from "@/lib/plaud/oauth-state";

const OAUTH_STATE_COOKIE = "plaud_oauth_state";

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

function callbackHtml(
  origin: string,
  status: "success" | "error",
  message: string
): string {
  const payload = JSON.stringify({
    type: "plaud-oauth",
    status,
    message
  });
  const targetOrigin = JSON.stringify(origin);
  const fallbackUrl = JSON.stringify(`/?plaud_oauth=${status}`);
  return `<!doctype html>
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
        window.setTimeout(() => window.close(), 350);
      } else {
        window.setTimeout(() => window.location.replace(${fallbackUrl}), 900);
      }
    </script>
  </body>
</html>`;
}

function appOrigin(request: Request): string {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const proto =
      forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

function htmlResponse(
  request: Request,
  status: "success" | "error",
  message: string
): NextResponse {
  const response = new NextResponse(callbackHtml(appOrigin(request), status, message), {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure:
      process.env.NODE_ENV === "production" &&
      appOrigin(request).startsWith("https://"),
    path: "/api/plaud/auth/oauth",
    maxAge: 0
  });
  return response;
}

export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const upstreamError = url.searchParams.get("error");
    if (upstreamError) {
      throw new AppError(
        ErrorCode.PlaudInvalidToken,
        url.searchParams.get("error_description") || upstreamError,
        401
      );
    }

    const cookieStore = await cookies();
    const statePayload = await verifySignedPlaudOAuthState(
      cookieStore.get(OAUTH_STATE_COOKIE)?.value
    );
    if (!statePayload) {
      throw new AppError(
        ErrorCode.PlaudInvalidToken,
        "OAuth state expired. Start Plaud web connect again.",
        401
      );
    }

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || state !== statePayload.state) {
      throw new AppError(
        ErrorCode.PlaudInvalidToken,
        "OAuth state mismatch. Start Plaud web connect again.",
        401
      );
    }
    if (!code) {
      throw new AppError(
        ErrorCode.MissingRequiredField,
        "Plaud OAuth callback did not include an authorization code.",
        400
      );
    }

    const tokenSet = await exchangePlaudOAuthCode(
      code,
      statePayload.codeVerifier,
      statePayload.redirectUri,
      statePayload.state
    );
    await savePlaudOAuthConnection({ tokenSet });
    return htmlResponse(request, "success", "You can close this window.");
  } catch (error) {
    const normalized = normalizeError(error);
    return htmlResponse(request, "error", normalized.message);
  }
}
