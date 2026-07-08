import { createHmac, timingSafeEqual } from "node:crypto";
import { getRawSecret } from "@/lib/crypto-store";

export interface PlaudOAuthWebState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  exp: number;
}

function encodeJson(value: PlaudOAuthWebState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function sign(value: string): Promise<string> {
  const secret = await getRawSecret();
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isPlaudOAuthWebState(value: unknown): value is PlaudOAuthWebState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    typeof record.codeVerifier === "string" &&
    typeof record.redirectUri === "string" &&
    typeof record.exp === "number"
  );
}

export async function createSignedPlaudOAuthState(
  payload: PlaudOAuthWebState
): Promise<string> {
  const encoded = encodeJson(payload);
  return `${encoded}.${await sign(encoded)}`;
}

export async function verifySignedPlaudOAuthState(
  token: string | undefined
): Promise<PlaudOAuthWebState | null> {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = await sign(encoded);
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as unknown;
    if (!isPlaudOAuthWebState(payload)) return null;
    if (payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
