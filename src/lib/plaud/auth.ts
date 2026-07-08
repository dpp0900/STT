import { AppError, ErrorCode } from "@/lib/errors";
import { plaudFetch } from "@/lib/plaud/fetch";
import { DEFAULT_PLAUD_API_BASE } from "@/lib/plaud/servers";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_SCAN_PATTERN = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const b64 =
      parts[1].replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function maybeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maybeUnwrapJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export function decodeAccessTokenExpiry(token: string): Date | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return null;
  }
  return new Date(payload.exp * 1000);
}

export function validateAccessTokenShape(accessToken: string): void {
  if (!JWT_PATTERN.test(accessToken)) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "That does not look like a Plaud access token.",
      400,
      { field: "accessToken" }
    );
  }

  const expiry = decodeAccessTokenExpiry(accessToken);
  if (expiry && expiry.getTime() < Date.now()) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "This Plaud access token has expired. Sign in to Plaud again.",
      400
    );
  }
}

export function extractAccessTokenFromPaste(input: string): string {
  const variants = new Set<string>();
  const trimmed = input.trim();
  variants.add(trimmed);
  variants.add(trimmed.replace(/^Bearer\s+/i, ""));
  variants.add(trimmed.replace(/^bearer\s+/i, ""));

  for (const value of [...variants]) {
    const decoded = maybeDecodeURIComponent(value);
    variants.add(decoded);
    variants.add(maybeUnwrapJsonString(decoded));
  }

  const matches: string[] = [];
  for (const value of variants) {
    if (JWT_PATTERN.test(value)) matches.push(value);
    matches.push(...(value.match(JWT_SCAN_PATTERN) ?? []));
  }

  const accessToken = matches.sort((a, b) => b.length - a.length)[0];
  if (!accessToken) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Could not find a Plaud access token in the pasted value.",
      400,
      { field: "accessToken" }
    );
  }

  validateAccessTokenShape(accessToken);
  return accessToken;
}

export function inferApiBaseFromAccessToken(token: string): string {
  const payload = decodeJwtPayload(token);
  const region = typeof payload?.region === "string" ? payload.region : null;
  switch (region) {
    case "aws:eu-central-1":
      return "https://api-euc1.plaud.ai";
    case "aws:ap-southeast-1":
      return "https://api-apse1.plaud.ai";
    case "aws:ap-northeast-1":
      return "https://api-apne1.plaud.ai";
    case "aws:us-west-2":
      return "https://api.plaud.ai";
    default:
      return DEFAULT_PLAUD_API_BASE;
  }
}

export async function fetchPlaudUserMeEmail(
  accessToken: string,
  apiBase: string
): Promise<string | null> {
  try {
    const response = await plaudFetch(`${apiBase}/user/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      email?: unknown;
      data?: { email?: unknown };
    };
    const email =
      typeof body.email === "string"
        ? body.email
        : typeof body.data?.email === "string"
          ? body.data.email
          : null;
    return email?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}
