import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readDb } from "@/lib/db";
import { errorBody, normalizeError } from "@/lib/errors";
import { getRemoteRecordings } from "@/lib/sync";

function newestFirst(
  left: { startTime?: string; start_time?: number },
  right: { startTime?: string; start_time?: number }
): number {
  const leftTime =
    typeof left.start_time === "number" ? left.start_time : Date.parse(left.startTime ?? "");
  const rightTime =
    typeof right.start_time === "number" ? right.start_time : Date.parse(right.startTime ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  return 0;
}

export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const limit = Math.min(
      Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100,
      500
    );
    const db = await readDb();
    const { records, total } = db.connection
      ? await getRemoteRecordings(limit)
      : { records: [], total: 0 };
    const localById = new Map(db.recordings.map((record) => [record.id, record]));

    return NextResponse.json({
      success: true,
      connected: Boolean(db.connection),
      total,
      recordings: [...records]
        .sort(newestFirst)
        .map((record) => {
          const local = localById.get(record.id);
          return {
            id: record.id,
            filename: record.filename,
            duration: record.duration,
            startTime: new Date(record.start_time).toISOString(),
            endTime: new Date(record.end_time).toISOString(),
            filesize: record.filesize,
            serialNumber: record.serial_number,
            versionMs: record.version_ms,
            isTrash: record.is_trash,
            downloaded: Boolean(local?.storagePath),
            downloadedAt: local?.downloadedAt ?? null,
            audioUrl: local?.storagePath ? `/api/audio/${encodeURIComponent(record.id)}` : null,
            transcription: local?.transcription ?? null,
            transcriptions: local?.transcriptions ?? {}
          };
        }),
      localOnly: db.recordings
        .filter((record) => !records.some((remote) => remote.id === record.id))
        .sort(newestFirst)
        .map((record) => ({
          ...record,
          downloaded: Boolean(record.storagePath),
          audioUrl: record.storagePath ? `/api/audio/${encodeURIComponent(record.id)}` : null,
          transcription: record.transcription ?? null,
          transcriptions: record.transcriptions ?? {}
        }))
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
