import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readDb } from "@/lib/db";
import { errorBody, normalizeError } from "@/lib/errors";
import { syncRecordings } from "@/lib/sync";

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    return NextResponse.json({
      success: true,
      syncProgress: db.syncProgress
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      fileIds?: unknown;
    } | null;
    const fileIds = Array.isArray(body?.fileIds)
      ? body.fileIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : undefined;
    const result = await syncRecordings(fileIds);
    const db = await readDb();
    return NextResponse.json({ success: true, ...result, syncProgress: db.syncProgress });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
