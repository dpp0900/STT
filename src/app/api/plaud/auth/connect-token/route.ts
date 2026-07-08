import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto-store";
import { updateDb } from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import {
  decodeAccessTokenExpiry,
  extractAccessTokenFromPaste,
  fetchPlaudUserMeEmail,
  inferApiBaseFromAccessToken
} from "@/lib/plaud/auth";
import { PlaudClient } from "@/lib/plaud/client";
import {
  isValidPlaudApiUrl,
  normalizePlaudApiBase
} from "@/lib/plaud/servers";
import { listPlaudWorkspaces, pickPersonalWorkspaceId } from "@/lib/plaud/workspace";

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      accessToken?: unknown;
      cookieValue?: unknown;
      apiBase?: unknown;
      source?: unknown;
    } | null;

    const pastedValue =
      typeof body?.accessToken === "string"
        ? body.accessToken
        : typeof body?.cookieValue === "string"
          ? body.cookieValue
          : "";

    if (!pastedValue.trim()) {
      throw new AppError(
        ErrorCode.MissingRequiredField,
        "accessToken or cookieValue is required",
        400,
        { field: "accessToken" }
      );
    }

    const accessToken = extractAccessTokenFromPaste(pastedValue);

    const requestedApiBase = body?.apiBase;
    const apiBase =
      typeof requestedApiBase === "string" && requestedApiBase.trim()
        ? normalizePlaudApiBase(requestedApiBase.trim())
        : inferApiBaseFromAccessToken(accessToken);
    if (!isValidPlaudApiUrl(apiBase)) {
      throw new AppError(
        ErrorCode.PlaudInvalidApiBase,
        "Invalid Plaud API base",
        400
      );
    }

    let workspaceId: string | null = null;
    try {
      workspaceId = pickPersonalWorkspaceId(
        await listPlaudWorkspaces(accessToken, apiBase)
      );
    } catch (error) {
      console.warn(
        "[plaud/connect-token] workspace discovery failed:",
        error instanceof Error ? error.message : error
      );
    }

    const client = new PlaudClient(accessToken, apiBase, workspaceId);
    const devicesResponse = await client.listDevices();
    const plaudEmail = await fetchPlaudUserMeEmail(accessToken, apiBase);
    const encryptedAccessToken = await encryptSecret(accessToken);
    const accessTokenExpiry = decodeAccessTokenExpiry(accessToken);
    const now = new Date().toISOString();

    await updateDb((db) => {
      db.connection = {
        encryptedAccessToken,
        encryptedRefreshToken: null,
        authMode: "web-token",
        apiBase,
        workspaceId: client.workspaceId ?? workspaceId,
        plaudEmail,
        accessTokenExpiresAt: accessTokenExpiry?.toISOString() ?? null,
        tokenType: "Bearer",
        oauthTokenFile: null,
        devices: devicesResponse.data_devices ?? [],
        connectedAt: db.connection?.connectedAt ?? now,
        updatedAt: now,
        lastSync: db.connection?.lastSync ?? null
      };
    });

    return NextResponse.json({
      success: true,
      devices: devicesResponse.data_devices ?? [],
      apiBase,
      workspaceId: client.workspaceId ?? workspaceId,
      plaudEmail
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
