import { AppError, ErrorCode } from "@/lib/errors";

export const PLAUD_OAUTH_CALLBACK_PATH = "/api/plaud/auth/oauth/callback";

export function normalizePlaudOAuthRedirectUri(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Plaud OAuth callback URL must be a string.",
      400,
      { field: "redirectUri" }
    );
  }

  const trimmed = value.trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Plaud OAuth callback URL must be an absolute URL.",
      400,
      { field: "redirectUri" }
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Plaud OAuth callback URL must use HTTP or HTTPS.",
      400,
      { field: "redirectUri" }
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Plaud OAuth callback URL cannot include credentials, query parameters, or a fragment.",
      400,
      { field: "redirectUri" }
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== PLAUD_OAUTH_CALLBACK_PATH) {
    throw new AppError(
      ErrorCode.InvalidInput,
      `Plaud OAuth callback URL must end with ${PLAUD_OAUTH_CALLBACK_PATH}.`,
      400,
      { field: "redirectUri" }
    );
  }

  return `${parsed.origin}${PLAUD_OAUTH_CALLBACK_PATH}`;
}

export function envPlaudOAuthRedirectUri(): string {
  const configured = process.env.PLAUD_OAUTH_REDIRECT_URI?.trim();
  return configured ? normalizePlaudOAuthRedirectUri(configured) : "";
}
