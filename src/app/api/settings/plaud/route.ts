import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { defaultPlaudOAuthSettings, readDb, updateDb } from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import {
  envPlaudOAuthRedirectUri,
  normalizePlaudOAuthRedirectUri,
  PLAUD_OAUTH_CALLBACK_PATH
} from "@/lib/plaud/oauth-redirect";

function publicSettings(
  settings: Awaited<ReturnType<typeof readDb>>["plaudOAuthSettings"]
) {
  const envRedirectUri = envPlaudOAuthRedirectUri();
  return {
    redirectUri: envRedirectUri || settings.redirectUri,
    envRedirectUri: Boolean(envRedirectUri),
    callbackPath: PLAUD_OAUTH_CALLBACK_PATH,
    updatedAt: settings.updatedAt
  };
}

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    return NextResponse.json({
      success: true,
      settings: publicSettings(db.plaudOAuthSettings)
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}

export async function PUT(request: Request) {
  try {
    await requireAuth();
    if (envPlaudOAuthRedirectUri()) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "Plaud OAuth callback URL is fixed by PLAUD_OAUTH_REDIRECT_URI.",
        409
      );
    }

    const body = (await request.json().catch(() => null)) as {
      redirectUri?: unknown;
    } | null;
    if (!body || body.redirectUri === undefined) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "Plaud OAuth callback URL is required.",
        400,
        { field: "redirectUri" }
      );
    }

    const redirectUri = normalizePlaudOAuthRedirectUri(body.redirectUri);
    const updated = await updateDb((db) => {
      db.plaudOAuthSettings = {
        ...defaultPlaudOAuthSettings(),
        ...db.plaudOAuthSettings,
        redirectUri,
        updatedAt: new Date().toISOString()
      };
      return db.plaudOAuthSettings;
    });

    return NextResponse.json({
      success: true,
      settings: publicSettings(updated)
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
