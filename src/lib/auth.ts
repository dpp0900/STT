import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { getRawSecret } from "@/lib/crypto-store";
import { AppError, ErrorCode } from "@/lib/errors";

const SESSION_COOKIE = "plaude_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 210_000;
const DEFAULT_LOGIN_ID = "admin";
const SECURE_COOKIE_ENV = "APP_AUTH_COOKIE_SECURE";

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

function base64UrlJson(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function signPayload(encodedPayload: string): Promise<string> {
  const secret = await getRawSecret();
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

async function createSessionToken(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: username,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url")
  };
  const encodedPayload = base64UrlJson(payload);
  const signature = await signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifySessionToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = await signPayload(encodedPayload);
  if (!timingSafeStringEqual(signature, expectedSignature)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (!payload.sub || typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload.sub;
}

export async function getSessionUser(): Promise<string | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function isAuthenticated(): Promise<boolean> {
  return Boolean(await getSessionUser());
}

export async function requireAuth(): Promise<string> {
  const user = await getSessionUser();
  if (!user) {
    throw new AppError(ErrorCode.AuthRequired, "Login required.", 401);
  }
  return user;
}

export function verifyLogin(username: string, password: string): boolean {
  const expectedUsername = process.env.APP_LOGIN_ID?.trim() || DEFAULT_LOGIN_ID;
  if (!timingSafeStringEqual(username, expectedUsername)) return false;

  const plaintextPassword = process.env.APP_LOGIN_PASSWORD;
  if (plaintextPassword) {
    return timingSafeStringEqual(password, plaintextPassword);
  }

  const salt = process.env.APP_LOGIN_PASSWORD_SALT?.trim();
  const expectedHash = process.env.APP_LOGIN_PASSWORD_HASH?.trim();
  if (!salt || !expectedHash) return false;

  const actualHash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("base64url");
  return timingSafeStringEqual(actualHash, expectedHash);
}

function configuredSecureCookie(): boolean | null {
  const configured = process.env[SECURE_COOKIE_ENV]?.trim().toLowerCase();
  if (!configured) return null;
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  return null;
}

function requestUsesHttps(request: Request): boolean {
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === "https";

  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function shouldUseSecureCookie(request: Request): boolean {
  const configured = configuredSecureCookie();
  if (configured !== null) return configured;
  if (process.env.NODE_ENV !== "production") return false;
  return requestUsesHttps(request);
}

export async function setSessionCookie(
  response: NextResponse,
  username: string,
  request: Request
): Promise<void> {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(username),
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: 0
  });
}
