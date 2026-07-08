import { encryptSecret } from "@/lib/crypto-store";
import { updateDb } from "@/lib/db";
import { PlaudDeveloperClient } from "@/lib/plaud/developer-client";
import {
  normalizePlaudDeveloperApiBase,
  plaudOAuthTokenExpiresAtIso,
  type PlaudOAuthTokenSet
} from "@/lib/plaud/oauth";

function extractEmail(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct =
    typeof record.email === "string"
      ? record.email
      : typeof record.mail === "string"
        ? record.mail
        : typeof record.account === "string"
          ? record.account
          : null;
  if (direct?.includes("@")) return direct.trim().toLowerCase();
  return extractEmail(record.data);
}

export async function savePlaudOAuthConnection(options: {
  tokenSet: PlaudOAuthTokenSet;
  apiBase?: string;
  tokenFile?: string | null;
}): Promise<{
  apiBase: string;
  plaudEmail: string | null;
  accessTokenExpiresAt: string | null;
}> {
  const apiBase = normalizePlaudDeveloperApiBase(options.apiBase);
  const client = new PlaudDeveloperClient(options.tokenSet.access_token, apiBase);
  const user = await client.getCurrentUser();
  const plaudEmail = extractEmail(user);
  const now = new Date().toISOString();
  const encryptedAccessToken = await encryptSecret(options.tokenSet.access_token);
  const encryptedRefreshToken = options.tokenSet.refresh_token
    ? await encryptSecret(options.tokenSet.refresh_token)
    : null;
  const accessTokenExpiresAt = plaudOAuthTokenExpiresAtIso(options.tokenSet);

  await updateDb((db) => {
    db.connection = {
      encryptedAccessToken,
      encryptedRefreshToken,
      authMode: "oauth",
      apiBase,
      workspaceId: null,
      plaudEmail,
      accessTokenExpiresAt,
      tokenType: options.tokenSet.token_type ?? "Bearer",
      oauthTokenFile: options.tokenFile ?? null,
      devices: [],
      connectedAt: db.connection?.connectedAt ?? now,
      updatedAt: now,
      lastSync: db.connection?.lastSync ?? null
    };
  });

  return {
    apiBase,
    plaudEmail,
    accessTokenExpiresAt
  };
}
