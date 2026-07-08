import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";
import { getTranscription } from "@/lib/stt/transcribe";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await context.params;
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
