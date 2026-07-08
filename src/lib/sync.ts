import { AppError, ErrorCode } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/crypto-store";
import {
  defaultSyncProgressState,
  readDb,
  updateDb,
  type LocalRecording,
  type PlaudConnection,
  type SyncProgressState
} from "@/lib/db";
import { PlaudClient } from "@/lib/plaud/client";
import { PlaudDeveloperClient } from "@/lib/plaud/developer-client";
import {
  ensureFreshPlaudOAuthTokenSet,
  plaudOAuthTokenExpiresAtIso,
  type PlaudOAuthTokenSet
} from "@/lib/plaud/oauth";
import type { PlaudRecording } from "@/lib/plaud/types";
import { audioFileExists, saveAudioFile, storageKeyForRecording } from "@/lib/storage";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

export interface SyncResult {
  newRecordings: number;
  updatedRecordings: number;
  skippedRecordings: number;
  errors: string[];
}

type SyncProgressPatch = Partial<SyncProgressState>;

interface PlaudAudioClient {
  readonly workspaceId?: string;
  getRecordings(skip?: number, limit?: number): Promise<{
    data_file_total?: number;
    data_file_list?: PlaudRecording[];
  }>;
  downloadRecording(fileId: string, preferOpus?: boolean): Promise<Buffer>;
}

function epochMsFromIso(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function createDeveloperClientFromConnection(
  connection: PlaudConnection
): Promise<PlaudDeveloperClient> {
  const accessToken = await decryptSecret(connection.encryptedAccessToken);
  const refreshToken = connection.encryptedRefreshToken
    ? await decryptSecret(connection.encryptedRefreshToken)
    : undefined;
  const tokenSet: PlaudOAuthTokenSet = {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(connection.tokenType ? { token_type: connection.tokenType } : {}),
    ...(epochMsFromIso(connection.accessTokenExpiresAt)
      ? { expires_at: epochMsFromIso(connection.accessTokenExpiresAt) }
      : {})
  };

  const freshTokenSet = await ensureFreshPlaudOAuthTokenSet(tokenSet);
  const tokenChanged =
    freshTokenSet.access_token !== tokenSet.access_token ||
    freshTokenSet.refresh_token !== tokenSet.refresh_token ||
    freshTokenSet.expires_at !== tokenSet.expires_at;

  if (tokenChanged) {
    await updateDb(async (db) => {
      if (!db.connection || db.connection.authMode !== "oauth") return;
      db.connection.encryptedAccessToken = await encryptSecret(freshTokenSet.access_token);
      db.connection.encryptedRefreshToken = freshTokenSet.refresh_token
        ? await encryptSecret(freshTokenSet.refresh_token)
        : null;
      db.connection.tokenType = freshTokenSet.token_type ?? "Bearer";
      db.connection.accessTokenExpiresAt = plaudOAuthTokenExpiresAtIso(freshTokenSet);
      db.connection.updatedAt = new Date().toISOString();
    });
  }

  return new PlaudDeveloperClient(freshTokenSet.access_token, connection.apiBase);
}

export async function createClientFromConnection(
  connection: PlaudConnection
): Promise<PlaudAudioClient> {
  if (connection.authMode === "oauth") {
    return createDeveloperClientFromConnection(connection);
  }
  const accessToken = await decryptSecret(connection.encryptedAccessToken);
  return new PlaudClient(accessToken, connection.apiBase, connection.workspaceId);
}

function toLocalRecording(
  remote: PlaudRecording,
  storagePath: string | null,
  downloadedAt: string | null,
  existing?: LocalRecording
): LocalRecording {
  const now = new Date().toISOString();
  return {
    id: remote.id,
    filename: remote.filename,
    duration: remote.duration,
    startTime: new Date(remote.start_time).toISOString(),
    endTime: new Date(remote.end_time).toISOString(),
    filesize: remote.filesize,
    fileMd5: remote.file_md5,
    serialNumber: remote.serial_number,
    versionMs: remote.version_ms,
    timezone: remote.timezone,
    zonemins: remote.zonemins,
    scene: remote.scene,
    isTrash: remote.is_trash,
    storagePath,
    downloadedAt,
    updatedAt: now,
    transcription: existing?.transcription ?? null,
    transcriptions: existing?.transcriptions
  };
}

export async function getRemoteRecordings(limit = PAGE_SIZE): Promise<{
  records: PlaudRecording[];
  total: number;
}> {
  const db = await readDb();
  if (!db.connection) {
    throw new AppError(ErrorCode.NotConnected, "Plaud is not connected.", 400);
  }
  const client = await createClientFromConnection(db.connection);
  const response = await client.getRecordings(0, Math.min(limit, 99999));
  return {
    records: [...(response.data_file_list ?? [])].sort(
      (left, right) => right.start_time - left.start_time
    ),
    total: response.data_file_total ?? response.data_file_list?.length ?? 0
  };
}

async function listAllRemoteRecordings(
  client: PlaudAudioClient,
  selectedIds?: Set<string>
): Promise<PlaudRecording[]> {
  const all: PlaudRecording[] = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const response = await client.getRecordings(page * PAGE_SIZE, PAGE_SIZE);
    const records = response.data_file_list ?? [];
    all.push(...records);

    if (selectedIds) {
      const found = new Set(all.map((record) => record.id));
      if ([...selectedIds].every((id) => found.has(id))) break;
    }
    if (records.length < PAGE_SIZE) break;
    page += 1;
  }

  return selectedIds ? all.filter((record) => selectedIds.has(record.id)) : all;
}

async function setSyncProgress(patch: SyncProgressPatch): Promise<void> {
  await updateDb((db) => {
    db.syncProgress = {
      ...defaultSyncProgressState(),
      ...db.syncProgress,
      ...patch,
      updatedAt: new Date().toISOString()
    };
  });
}

export async function syncRecordings(fileIds?: string[]): Promise<SyncResult> {
  const db = await readDb();
  if (!db.connection) {
    throw new AppError(ErrorCode.NotConnected, "Plaud is not connected.", 400);
  }

  const client = await createClientFromConnection(db.connection);
  const selectedIds = fileIds?.length ? new Set(fileIds) : undefined;
  const result: SyncResult = {
    newRecordings: 0,
    updatedRecordings: 0,
    skippedRecordings: 0,
    errors: []
  };

  await setSyncProgress({
    status: "running",
    stage: "listing",
    scope: selectedIds ? "selected" : "all",
    requested: selectedIds?.size ?? null,
    total: selectedIds?.size ?? 0,
    completed: 0,
    newRecordings: 0,
    updatedRecordings: 0,
    skippedRecordings: 0,
    failedRecordings: 0,
    currentRecordingId: null,
    currentFilename: selectedIds ? "Finding selected recordings" : "Finding recordings",
    errors: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  });

  try {
    const remotes = await listAllRemoteRecordings(client, selectedIds);

    await setSyncProgress({
      stage: "downloading",
      total: remotes.length,
      currentFilename: remotes.length ? remotes[0].filename : "No recordings to download"
    });

    const existingById = new Map(db.recordings.map((record) => [record.id, record]));
    const updates = new Map<string, LocalRecording>();

    for (const remote of remotes) {
      await setSyncProgress({
        currentRecordingId: remote.id,
        currentFilename: remote.filename
      });

      try {
        const existing = existingById.get(remote.id);
        const versionMatches = existing?.versionMs === remote.version_ms;
        const fileExists = await audioFileExists(existing?.storagePath ?? null);

        if (existing && versionMatches && fileExists) {
          result.skippedRecordings += 1;
          updates.set(remote.id, {
            ...toLocalRecording(remote, existing.storagePath, existing.downloadedAt, existing),
            updatedAt: new Date().toISOString()
          });
        } else {
          const storagePath = storageKeyForRecording(remote.id, remote.filename);
          const audio = await client.downloadRecording(remote.id, false);
          await saveAudioFile(storagePath, audio);
          const downloadedRemote = {
            ...remote,
            filesize: remote.filesize || audio.length
          };
          updates.set(
            remote.id,
            toLocalRecording(downloadedRemote, storagePath, new Date().toISOString(), existing)
          );

          if (existing) result.updatedRecordings += 1;
          else result.newRecordings += 1;
        }
      } catch (error) {
        result.errors.push(
          `${remote.filename}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      await setSyncProgress({
        completed: result.newRecordings + result.updatedRecordings + result.skippedRecordings + result.errors.length,
        newRecordings: result.newRecordings,
        updatedRecordings: result.updatedRecordings,
        skippedRecordings: result.skippedRecordings,
        failedRecordings: result.errors.length,
        errors: result.errors.slice(-5)
      });
    }

    await updateDb((current) => {
      const merged = new Map(current.recordings.map((record) => [record.id, record]));
      for (const [id, record] of updates) merged.set(id, record);
      current.recordings = [...merged.values()].sort(
        (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );
      if (current.connection) {
        current.connection.lastSync = new Date().toISOString();
        current.connection.updatedAt = new Date().toISOString();
        if (client.workspaceId) current.connection.workspaceId = client.workspaceId;
      }
    });

    await setSyncProgress({
      status: result.errors.length ? "failed" : "completed",
      stage: result.errors.length ? "failed" : "completed",
      completed: remotes.length,
      total: remotes.length,
      newRecordings: result.newRecordings,
      updatedRecordings: result.updatedRecordings,
      skippedRecordings: result.skippedRecordings,
      failedRecordings: result.errors.length,
      currentRecordingId: null,
      currentFilename: null,
      errors: result.errors.slice(-5),
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    await setSyncProgress({
      status: "failed",
      stage: "failed",
      currentRecordingId: null,
      currentFilename: null,
      errors: [error instanceof Error ? error.message : String(error)],
      completedAt: new Date().toISOString()
    });
    throw error;
  }

  return result;
}
