import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readDb } from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import { readAudioFile, statAudioFile } from "@/lib/storage";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await context.params;
    const db = await readDb();
    const recording = db.recordings.find((item) => item.id === id);
    if (!recording?.storagePath) {
      throw new AppError(ErrorCode.NotFound, "Recording audio not found", 404);
    }

    const stats = await statAudioFile(recording.storagePath);
    const range = request.headers.get("range");
    const filename = `${recording.filename.replace(/[/\\:*?"<>|]/g, "-")}.mp3`;
    const download = new URL(request.url).searchParams.get("download") === "1";

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;
        const audio = await readAudioFile(recording.storagePath);
        const chunk = audio.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            "Content-Type": "audio/mpeg",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${stats.size}`,
            "Content-Length": String(chunk.length),
            ...(download
              ? { "Content-Disposition": `attachment; filename="${filename}"` }
              : {})
          }
        });
      }
    }

    const audio = await readAudioFile(recording.storagePath);
    return new Response(new Uint8Array(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Length": String(audio.length),
        ...(download
          ? { "Content-Disposition": `attachment; filename="${filename}"` }
          : {})
      }
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
