import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";
import { startTranscriptCleanupJob } from "@/lib/stt/cleanup-jobs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      model?: unknown;
    } | null;
    const model = typeof body?.model === "string" ? body.model : undefined;
    const job = await startTranscriptCleanupJob(id, model);
    return NextResponse.json(
      { success: true, job },
      { status: job.started ? 202 : 200 }
    );
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
