import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AppError, ErrorCode } from "@/lib/errors";
import { decodeAccessTokenExpiry } from "@/lib/plaud/auth";
import { isValidPlaudApiUrl } from "@/lib/plaud/servers";

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REFRESH_MARGIN_MS = 60_000;

export const PLAUD_OAUTH_DEFAULT_API_BASE =
  "https://platform.plaud.ai/developer/api";
export const PLAUD_OAUTH_DEFAULT_AUTHORIZATION_URL =
  "https://web.plaud.ai/platform/oauth";
export const PLAUD_OAUTH_DEFAULT_TOKEN_URL =
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";
export const PLAUD_OAUTH_DEFAULT_REFRESH_URL =
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";
export const PLAUD_OAUTH_DEFAULT_CLIENT_ID =
  "client_f9e0b214-c11f-434b-8b95-c4497d1feb81";

export interface PlaudOAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
}

export interface LoadedPlaudOAuthTokenSet {
  tokenSet: PlaudOAuthTokenSet;
  path: string;
}

export interface PlaudOAuthAuthorizationRequest {
  url: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}

function oauthClientId(): string {
  return (
    process.env.PLAUD_CLI_CLIENT_ID?.trim() ||
    process.env.PLAUD_CLIENT_ID?.trim() ||
    PLAUD_OAUTH_DEFAULT_CLIENT_ID
  );
}

function oauthClientSecret(): string {
  return process.env.PLAUD_CLIENT_SECRET?.trim() || "";
}

export function normalizePlaudDeveloperApiBase(
  value = defaultPlaudDeveloperApiBase()
): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || !isValidPlaudApiUrl(trimmed)) {
    throw new AppError(
      ErrorCode.PlaudInvalidApiBase,
      "Invalid Plaud OAuth API base",
      400
    );
  }
  return trimmed;
}

function defaultPlaudDeveloperApiBase(): string {
  const explicit = process.env.PLAUD_OAUTH_API_BASE?.trim();
  if (explicit) return explicit;

  const officialCliEnv = process.env.PLAUD_API_BASE?.trim();
  if (
    officialCliEnv &&
    (officialCliEnv.includes("platform.plaud.ai") ||
      officialCliEnv.includes("/developer/api"))
  ) {
    return officialCliEnv;
  }

  return PLAUD_OAUTH_DEFAULT_API_BASE;
}

function endpointFromEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!isValidPlaudApiUrl(value)) {
    throw new AppError(
      ErrorCode.PlaudInvalidApiBase,
      `Invalid Plaud OAuth endpoint in ${name}`,
      400
    );
  }
  return value;
}

function authorizationEndpoint(): string {
  return endpointFromEnv(
    "PLAUD_AUTH_URL",
    PLAUD_OAUTH_DEFAULT_AUTHORIZATION_URL
  );
}

function tokenEndpoint(): string {
  return endpointFromEnv("PLAUD_TOKEN_URL", PLAUD_OAUTH_DEFAULT_TOKEN_URL);
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("base64url");
}

export function createPlaudOAuthAuthorizationRequest(
  redirectUri: string
): PlaudOAuthAuthorizationRequest {
  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const params = new URLSearchParams({
    client_id: oauthClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: generateCodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state
  });

  return {
    url: `${authorizationEndpoint()}?${params.toString()}`,
    codeVerifier,
    state,
    redirectUri
  };
}

function oauthExtraHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.PLAUD_ENV) headers["x-pld-env"] = process.env.PLAUD_ENV;
  if (process.env.PLAUD_REGION) headers["x-pld-region"] = process.env.PLAUD_REGION;
  return headers;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolvePlaudOAuthTokenFilePath(path: string): string {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

function defaultTokenFileCandidates(): string[] {
  const configured = process.env.PLAUD_OAUTH_TOKEN_FILE?.trim();
  return [
    ...(configured ? [configured] : []),
    "~/.plaud/tokens.json",
    "~/.plaud/tokens-mcp.json"
  ];
}

function parseTokenSet(raw: unknown, path: string): PlaudOAuthTokenSet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(
      ErrorCode.InvalidInput,
      `Plaud token file is not a JSON object: ${path}`,
      400
    );
  }

  const record = raw as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!JWT_SHAPE.test(accessToken)) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      `Plaud token file does not contain a valid access_token: ${path}`,
      400
    );
  }

  const refreshToken =
    typeof record.refresh_token === "string" && record.refresh_token.trim()
      ? record.refresh_token.trim()
      : undefined;
  const tokenType =
    typeof record.token_type === "string" && record.token_type.trim()
      ? record.token_type.trim()
      : "Bearer";
  const expiresAt =
    typeof record.expires_at === "number" && Number.isFinite(record.expires_at)
      ? record.expires_at
      : typeof record.expires_at === "string" && Number.isFinite(Number(record.expires_at))
        ? Number(record.expires_at)
        : undefined;

  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    token_type: tokenType,
    ...(expiresAt ? { expires_at: expiresAt } : {})
  };
}

export async function loadPlaudOAuthTokenFile(
  tokenFile?: string | null
): Promise<LoadedPlaudOAuthTokenSet> {
  const candidates = tokenFile?.trim() ? [tokenFile] : defaultTokenFileCandidates();
  const errors: string[] = [];

  for (const candidate of candidates) {
    const path = resolvePlaudOAuthTokenFilePath(candidate);
    try {
      const text = await readFile(path, "utf8");
      return {
        tokenSet: parseTokenSet(JSON.parse(text), path),
        path
      };
    } catch (error) {
      errors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new AppError(
    ErrorCode.NotFound,
    "Could not read Plaud OAuth token file. Run `plaud login` first or set PLAUD_OAUTH_TOKEN_FILE.",
    404,
    { tried: errors }
  );
}

export function plaudOAuthTokenExpiresAt(tokenSet: PlaudOAuthTokenSet): Date | null {
  if (tokenSet.expires_at && Number.isFinite(tokenSet.expires_at)) {
    return new Date(tokenSet.expires_at);
  }
  return decodeAccessTokenExpiry(tokenSet.access_token);
}

export function plaudOAuthTokenExpiresAtIso(
  tokenSet: PlaudOAuthTokenSet
): string | null {
  return plaudOAuthTokenExpiresAt(tokenSet)?.toISOString() ?? null;
}

export function shouldRefreshPlaudOAuthToken(
  tokenSet: PlaudOAuthTokenSet,
  marginMs = REFRESH_MARGIN_MS
): boolean {
  const expiresAt = plaudOAuthTokenExpiresAt(tokenSet);
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() - marginMs;
}

export async function refreshPlaudOAuthTokenSet(
  refreshToken: string
): Promise<PlaudOAuthTokenSet> {
  const refreshUrl = endpointFromEnv(
    "PLAUD_REFRESH_URL",
    PLAUD_OAUTH_DEFAULT_REFRESH_URL
  );
  const response = await fetch(refreshUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...oauthExtraHeaders()
    },
    body: new URLSearchParams({ refresh_token: refreshToken })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError(
      response.status >= 500 ? ErrorCode.PlaudUpstreamError : ErrorCode.PlaudInvalidToken,
      `Plaud OAuth token refresh failed: ${response.status}`,
      response.status >= 500 ? 502 : 401,
      { bodySnippet: body.slice(0, 300) }
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!JWT_SHAPE.test(accessToken)) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "Plaud OAuth refresh response did not include a valid access_token.",
      401
    );
  }

  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? data.expires_in
      : undefined;
  const nextRefreshToken =
    typeof data.refresh_token === "string" && data.refresh_token.trim()
      ? data.refresh_token.trim()
      : refreshToken;
  const tokenType =
    typeof data.token_type === "string" && data.token_type.trim()
      ? data.token_type.trim()
      : "Bearer";

  return {
    access_token: accessToken,
    refresh_token: nextRefreshToken,
    token_type: tokenType,
    ...(expiresIn ? { expires_at: Date.now() + expiresIn * 1000 } : {})
  };
}

export async function exchangePlaudOAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  state?: string
): Promise<PlaudOAuthTokenSet> {
  const basicAuth = Buffer.from(
    `${oauthClientId()}:${oauthClientSecret()}`
  ).toString("base64");
  const body = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
  if (state) body.set("state", state);

  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
      ...oauthExtraHeaders()
    },
    body
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AppError(
      response.status >= 500 ? ErrorCode.PlaudUpstreamError : ErrorCode.PlaudInvalidToken,
      `Plaud OAuth token exchange failed: ${response.status}`,
      response.status >= 500 ? 502 : 401,
      { bodySnippet: text.slice(0, 300) }
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!JWT_SHAPE.test(accessToken)) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "Plaud OAuth response did not include a valid access_token.",
      401
    );
  }

  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token.trim()
      ? data.refresh_token.trim()
      : undefined;
  const tokenType =
    typeof data.token_type === "string" && data.token_type.trim()
      ? data.token_type.trim()
      : "Bearer";
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? data.expires_in
      : undefined;

  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    token_type: tokenType,
    ...(expiresIn ? { expires_at: Date.now() + expiresIn * 1000 } : {})
  };
}

export async function ensureFreshPlaudOAuthTokenSet(
  tokenSet: PlaudOAuthTokenSet
): Promise<PlaudOAuthTokenSet> {
  if (!shouldRefreshPlaudOAuthToken(tokenSet)) return tokenSet;
  if (!tokenSet.refresh_token) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "Plaud OAuth access token is expired and no refresh_token is available.",
      401
    );
  }
  return refreshPlaudOAuthTokenSet(tokenSet.refresh_token);
}
