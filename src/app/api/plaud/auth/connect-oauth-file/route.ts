import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";
import { savePlaudOAuthConnection } from "@/lib/plaud/oauth-connection";
import {
  ensureFreshPlaudOAuthTokenSet,
  loadPlaudOAuthTokenFile
} from "@/lib/plaud/oauth";

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      tokenFile?: unknown;
      apiBase?: unknown;
    } | null;

    const requestedTokenFile =
      typeof body?.tokenFile === "string" && body.tokenFile.trim()
        ? body.tokenFile.trim()
        : undefined;
    const requestedApiBase =
      typeof body?.apiBase === "string" && body.apiBase.trim()
        ? body.apiBase.trim()
        : undefined;

    const loaded = await loadPlaudOAuthTokenFile(requestedTokenFile);
    const tokenSet = await ensureFreshPlaudOAuthTokenSet(loaded.tokenSet);
    const saved = await savePlaudOAuthConnection({
      tokenSet,
      apiBase: requestedApiBase,
      tokenFile: loaded.path
    });

    return NextResponse.json({
      success: true,
      apiBase: saved.apiBase,
      tokenFile: loaded.path,
      plaudEmail: saved.plaudEmail,
      accessTokenExpiresAt: saved.accessTokenExpiresAt
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
