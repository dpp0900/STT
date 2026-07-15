import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";
import { createPlaudLoopbackAuthorizationUrl } from "@/lib/plaud/oauth-loopback";
import { createPlaudOAuthAuthorizationRequest } from "@/lib/plaud/oauth";
import { createSignedPlaudOAuthState } from "@/lib/plaud/oauth-state";

const OAUTH_STATE_COOKIE = "plaud_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

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

export async function GET(request: Request) {
  try {
    await requireAuth();
    const redirectUri = process.env.PLAUD_OAUTH_REDIRECT_URI?.trim();
    if (!redirectUri) {
      return NextResponse.redirect(
        await createPlaudLoopbackAuthorizationUrl(appOrigin(request))
      );
    }

    const authorization = createPlaudOAuthAuthorizationRequest(redirectUri);
    const response = NextResponse.redirect(authorization.url);
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: await createSignedPlaudOAuthState({
        state: authorization.state,
        codeVerifier: authorization.codeVerifier,
        redirectUri: authorization.redirectUri,
        exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000
      }),
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.NODE_ENV === "production" &&
        authorization.redirectUri.startsWith("https://"),
      path: "/api/plaud/auth/oauth",
      maxAge: OAUTH_STATE_TTL_SECONDS
    });
    return response;
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
