import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readDb, type LocalRecording } from "@/lib/db";
import { errorBody, normalizeError } from "@/lib/errors";
import { getRemoteRecordings } from "@/lib/sync";
import type { PlaudRecording } from "@/lib/plaud/types";

const REMOTE_RECORDINGS_CACHE_MS = 60_000;

type RemoteRecordingsResult = Awaited<ReturnType<typeof getRemoteRecordings>>;

let remoteRecordingsCache:
  | (RemoteRecordingsResult & { fetchedAt: number; limit: number })
  | null = null;

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

function localRow(record: LocalRecording) {
  return {
    ...record,
    downloaded: Boolean(record.storagePath),
    audioUrl: record.storagePath ? `/api/audio/${encodeURIComponent(record.id)}` : null,
    transcription: record.transcription ?? null,
    transcriptions: record.transcriptions ?? {}
  };
}

function remoteRow(record: PlaudRecording, local: LocalRecording | undefined) {
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
}

function cachedRemoteRecordings(limit: number, freshOnly: boolean): RemoteRecordingsResult | null {
  if (!remoteRecordingsCache) return null;
  const fresh = Date.now() - remoteRecordingsCache.fetchedAt < REMOTE_RECORDINGS_CACHE_MS;
  if (freshOnly && (!fresh || remoteRecordingsCache.limit < limit)) return null;
  return {
    records: remoteRecordingsCache.records.slice(0, limit),
    total: remoteRecordingsCache.total
  };
}

export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const limit = Math.min(
      Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100,
      500
    );
    const includeRemote =
      url.searchParams.get("remote") !== "false" &&
      url.searchParams.get("localOnly") !== "true";
    const db = await readDb();
    let remoteResult: RemoteRecordingsResult = { records: [], total: 0 };
    let remoteWarning: string | null = null;

    if (db.connection && includeRemote) {
      const cached = cachedRemoteRecordings(limit, true);
      if (cached) {
        remoteResult = cached;
      } else {
        try {
          const fetched = await getRemoteRecordings(limit);
          remoteRecordingsCache = {
            ...fetched,
            fetchedAt: Date.now(),
            limit
          };
          remoteResult = fetched;
        } catch (error) {
          const stale = cachedRemoteRecordings(limit, false);
          if (stale) {
            remoteResult = stale;
          } else {
            remoteResult = { records: [], total: db.recordings.length };
          }
          remoteWarning =
            error instanceof Error ? error.message : "Failed to load remote Plaud recordings.";
          console.warn("Failed to load remote Plaud recordings.", error);
        }
      }
    } else if (!includeRemote) {
      remoteResult = { records: [], total: db.recordings.length };
    }

    const { records, total } = remoteResult;
    const localById = new Map(db.recordings.map((record) => [record.id, record]));

    return NextResponse.json({
      success: true,
      connected: Boolean(db.connection),
      total,
      remoteWarning,
      recordings: [...records]
        .sort(newestFirst)
        .map((record) => remoteRow(record, localById.get(record.id))),
      localOnly: db.recordings
        .filter((record) => !records.some((remote) => remote.id === record.id))
        .sort(newestFirst)
        .map(localRow)
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
