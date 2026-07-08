import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import { notifyOpenClawForCompletedTranscription } from "@/lib/openclaw";
import { getTranscription } from "@/lib/stt/transcribe";

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
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const current = await getTranscription(id);
    const targetModel = model || current.transcription?.model;
    if (!targetModel) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "No transcript model is available for OpenClaw retry.",
        400
      );
    }
    await notifyOpenClawForCompletedTranscription(id, targetModel);
    const result = await getTranscription(id);
    return NextResponse.json({
      success: true,
      recording: {
        id: result.recording.id,
        filename: result.recording.filename
      },
      transcription: result.transcription,
      transcriptions: result.transcriptions
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
