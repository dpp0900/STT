import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import { startTranscriptCleanupJobs } from "@/lib/stt/cleanup-jobs";

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      recordingIds?: unknown;
    } | null;
    const recordingIds = Array.isArray(body?.recordingIds)
      ? body.recordingIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      : [];

    if (recordingIds.length === 0) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "recordingIds must include at least one recording id.",
        400,
        { field: "recordingIds" }
      );
    }

    const results = await startTranscriptCleanupJobs(recordingIds);
    return NextResponse.json({ success: true, results }, { status: 202 });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
