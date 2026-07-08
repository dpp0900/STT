import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";
import { runTranscriptionForRecording } from "@/lib/stt/transcribe";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await context.params;
    const result = await runTranscriptionForRecording(id);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
