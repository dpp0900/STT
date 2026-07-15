import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import { completePlaudLoopbackOAuthCallback } from "@/lib/plaud/oauth-loopback";

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      callbackUrl?: unknown;
    } | null;
    if (!body || typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "Paste the complete Plaud OAuth callback URL.",
        400,
        { field: "callbackUrl" }
      );
    }

    await completePlaudLoopbackOAuthCallback(body.callbackUrl.trim());
    return NextResponse.json({ success: true });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
