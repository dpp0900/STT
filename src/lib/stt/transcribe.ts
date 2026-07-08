import { decryptSecret } from "@/lib/crypto-store";
import {
  readDb,
  updateDb,
  type LocalRecording,
  type SttSettings,
  type TranscriptionChunk,
  type TranscriptionProgress,
  type TranscriptionPostprocessState,
  type TranscriptionState,
  type TranscriptionUsage
} from "@/lib/db";
import { AppError, ErrorCode } from "@/lib/errors";
import { getAudioFilePath } from "@/lib/storage";
import { chunkAudioFile } from "@/lib/stt/chunk-audio";
import { transcribeChunkWithDeepgram } from "@/lib/stt/deepgram";
import { transcribeChunkWithOpenRouter } from "@/lib/stt/openrouter";
import { postprocessTranscriptWithOpenRouter } from "@/lib/stt/postprocess";
import { transcribeFileWithSoniox } from "@/lib/stt/soniox";

const DEFAULT_CLEANUP_RECORDING_CONCURRENCY = 2;
const MAX_CLEANUP_RECORDING_CONCURRENCY = 3;
const CLEANUP_FAILURE_WARNING_PREFIX = "Transcript cleanup failed:";

export interface RunTranscriptionResult {
  recordingId: string;
  status: TranscriptionState["status"];
  text: string;
  chunks: number;
  warnings: string[];
  error?: string;
}

function mergeUsage(
  left: TranscriptionUsage | undefined,
  right: TranscriptionUsage | undefined
): TranscriptionUsage | undefined {
  if (!left && !right) return undefined;
  const merged: TranscriptionUsage = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) {
    if (typeof value !== "number") continue;
    const typedKey = key as keyof TranscriptionUsage;
    merged[typedKey] = ((merged[typedKey] as number | undefined) ?? 0) + value;
  }
  return merged;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanupRecordingConcurrency(): number {
  return boundedEnvInt(
    "CLEANUP_RECORDING_CONCURRENCY",
    DEFAULT_CLEANUP_RECORDING_CONCURRENCY,
    1,
    MAX_CLEANUP_RECORDING_CONCURRENCY
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && !firstError) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        firstError ??= error;
      }
    }
  });

  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function progress(
  stage: TranscriptionProgress["stage"],
  completed: number,
  total: number,
  details: Partial<Omit<TranscriptionProgress, "stage" | "completed" | "total">> = {}
): TranscriptionProgress {
  const safeTotal = Math.max(1, total);
  const safeCompleted = Math.min(safeTotal, Math.max(0, completed));
  const rawPercent =
    typeof details.percent === "number"
      ? details.percent
      : Math.round((safeCompleted / safeTotal) * 100);
  return {
    stage,
    completed: safeCompleted,
    total: safeTotal,
    percent: Math.min(100, Math.max(0, Math.round(rawPercent))),
    ...(typeof details.active === "number" ? { active: details.active } : {}),
    ...(typeof details.generatedChars === "number"
      ? { generatedChars: details.generatedChars }
      : {}),
    ...(typeof details.estimatedOutputTokens === "number"
      ? { estimatedOutputTokens: details.estimatedOutputTokens }
      : {}),
    ...(typeof details.tokensPerSecond === "number"
      ? { tokensPerSecond: details.tokensPerSecond }
      : {}),
    ...(typeof details.charsPerSecond === "number"
      ? { charsPerSecond: details.charsPerSecond }
      : {})
  };
}

function newRunningState(
  previous: TranscriptionState | null | undefined,
  model: string,
  language: string
): TranscriptionState {
  return {
    status: "running",
    model,
    language,
    text: previous?.text ?? "",
    chunks: [],
    progress: progress("stt", 0, 1),
    warnings: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString()
  };
}

function newRunningPostprocessState(
  previous: TranscriptionPostprocessState | null | undefined,
  model: string
): TranscriptionPostprocessState {
  return {
    status: "running",
    model,
    text: previous?.text ?? "",
    chunks: [],
    progress: progress("cleanup", 0, 1),
    warnings: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString()
  };
}

function withoutCleanupFailureWarnings(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter(
    (warning) => !warning.startsWith(CLEANUP_FAILURE_WARNING_PREFIX)
  );
}

async function setRecordingTranscription(
  recordingId: string,
  updater: (recording: LocalRecording) => void
): Promise<void> {
  await updateDb((db) => {
    const recording = db.recordings.find((item) => item.id === recordingId);
    if (!recording) {
      throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
    }
    updater(recording);
    recording.updatedAt = new Date().toISOString();
  });
}

function publicResult(recording: LocalRecording): RunTranscriptionResult {
  const state = recording.transcription;
  const postprocess =
    state?.postprocess?.status === "completed" && state.postprocess.text
      ? state.postprocess
      : null;
  return {
    recordingId: recording.id,
    status: state?.status ?? "idle",
    text: postprocess?.text ?? state?.text ?? "",
    chunks: state?.chunks.length ?? 0,
    warnings: state?.warnings ?? [],
    ...(state?.error ? { error: state.error } : {})
  };
}

type SttProvider = "deepgram" | "openrouter" | "soniox";

function providerForModel(model: string): SttProvider {
  if (model.startsWith("deepgram/")) return "deepgram";
  if (model.startsWith("soniox/")) return "soniox";
  return "openrouter";
}

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function providerKeyField(provider: SttProvider): keyof Pick<
  SttSettings,
  "encryptedOpenRouterApiKey" | "encryptedDeepgramApiKey" | "encryptedSonioxApiKey"
> {
  if (provider === "deepgram") return "encryptedDeepgramApiKey";
  if (provider === "soniox") return "encryptedSonioxApiKey";
  return "encryptedOpenRouterApiKey";
}

function providerKeyEnv(provider: SttProvider): string | null {
  if (provider === "deepgram") {
    return envValue("DEEPGRAM_API_KEY", "DEEPGRAM_KEY", "deepgram", "deepgram_api_key");
  }
  if (provider === "soniox") {
    return envValue("SONIOX_API_KEY", "SONIOX_KEY", "soniox", "soniox_api_key");
  }
  return envValue("OPENROUTER_API_KEY", "OPENROUTER_KEY", "openrouter", "openrouter_api_key");
}

function providerDisplayName(provider: SttProvider): string {
  if (provider === "deepgram") return "Deepgram";
  if (provider === "soniox") return "Soniox";
  return "OpenRouter";
}

async function apiKeyForProvider(settings: SttSettings, provider: SttProvider): Promise<string> {
  const encryptedApiKey = settings[providerKeyField(provider)];
  if (encryptedApiKey) return decryptSecret(encryptedApiKey);

  const fromEnv = providerKeyEnv(provider);
  if (fromEnv) return fromEnv;

  const displayName = providerDisplayName(provider);
  throw new AppError(
    ErrorCode.InvalidInput,
    `Set a ${displayName} API key before transcribing.`,
    400,
    {
      field:
        provider === "deepgram"
          ? "deepgramApiKey"
          : provider === "soniox"
            ? "sonioxApiKey"
            : "apiKey"
    }
  );
}

function transcriptionForModel(
  recording: LocalRecording,
  model: string
): TranscriptionState | null {
  return (
    recording.transcriptions?.[model] ??
    (recording.transcription?.model === model ? recording.transcription : null)
  );
}

function setTranscriptionForModel(
  recording: LocalRecording,
  model: string,
  transcription: TranscriptionState
): void {
  recording.transcriptions = {
    ...(recording.transcriptions ?? {}),
    [model]: transcription
  };
  recording.transcription = transcription;
}

function latestCompletedTranscription(recording: LocalRecording): TranscriptionState | null {
  const states = Object.values(recording.transcriptions ?? {});
  if (recording.transcription?.model) {
    states.push(recording.transcription);
  }

  const byModel = new Map<string, TranscriptionState>();
  for (const state of states) {
    if (state.status === "completed" && state.text.trim()) {
      byModel.set(state.model, state);
    }
  }

  return (
    [...byModel.values()].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt);
      const rightTime = Date.parse(right.updatedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
        return rightTime - leftTime;
      }
      return right.model.localeCompare(left.model);
    })[0] ?? null
  );
}

async function runPostprocessForModel(
  recordingId: string,
  transcriptionModel: string,
  settings: SttSettings,
  options: { force?: boolean; throwOnFailure?: boolean } = {}
): Promise<void> {
  if (!settings.postprocessEnabled && !options.force) return;

  const loaded = await readDb();
  const recording = loaded.recordings.find((item) => item.id === recordingId);
  const transcription = recording ? transcriptionForModel(recording, transcriptionModel) : null;
  if (!recording || !transcription || transcription.status !== "completed") {
    if (options.force) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "Cleanup requires a completed transcript.",
        400
      );
    }
    return;
  }
  if (!transcription.text.trim()) {
    if (options.force) {
      throw new AppError(
        ErrorCode.InvalidInput,
        "Cleanup requires non-empty transcript text.",
        400
      );
    }
    return;
  }

  const postprocessModel = settings.postprocessModel;
  await setRecordingTranscription(recordingId, (item) => {
    const state = transcriptionForModel(item, transcriptionModel);
    if (!state) return;
    state.postprocess = newRunningPostprocessState(state.postprocess, postprocessModel);
    state.warnings = withoutCleanupFailureWarnings(state.warnings);
    state.updatedAt = new Date().toISOString();
    setTranscriptionForModel(item, transcriptionModel, state);
  });

  let cleanupFinished = false;
  let progressWrite: Promise<void> = Promise.resolve();
  const queueProgressWrite = (progressInfo: Parameters<
    NonNullable<Parameters<typeof postprocessTranscriptWithOpenRouter>[0]["onProgress"]>
  >[0]) => {
    progressWrite = progressWrite
      .catch(() => undefined)
      .then(async () => {
        if (cleanupFinished) return;
        await setRecordingTranscription(recordingId, (item) => {
          const state = transcriptionForModel(item, transcriptionModel);
          if (state?.postprocess?.status !== "running") return;
          state.postprocess.progress = progress("cleanup", progressInfo.completed, progressInfo.total, {
            percent: progressInfo.percent,
            active: progressInfo.active,
            generatedChars: progressInfo.generatedChars,
            estimatedOutputTokens: progressInfo.estimatedOutputTokens,
            tokensPerSecond: progressInfo.tokensPerSecond,
            charsPerSecond: progressInfo.charsPerSecond
          });
          state.postprocess.updatedAt = new Date().toISOString();
          state.updatedAt = state.postprocess.updatedAt;
          setTranscriptionForModel(item, transcriptionModel, state);
        });
      });
  };

  try {
    const apiKey = await apiKeyForProvider(settings, "openrouter");
    const result = await postprocessTranscriptWithOpenRouter({
      apiKey,
      model: postprocessModel,
      transcript: transcription.text,
      onProgress: queueProgressWrite
    });
    cleanupFinished = true;
    await progressWrite.catch(() => undefined);
    const now = new Date().toISOString();

    await setRecordingTranscription(recordingId, (item) => {
      const state = transcriptionForModel(item, transcriptionModel);
      if (!state) return;
      state.postprocess = {
        status: "completed",
        model: result.model,
        text: result.text,
        chunks: result.chunks,
        progress: progress("cleanup", result.chunks.length, Math.max(1, result.chunks.length)),
        usage: result.usage,
        warnings: result.warnings,
        startedAt: state.postprocess?.startedAt ?? now,
        completedAt: now,
        updatedAt: now
      };
      state.warnings = withoutCleanupFailureWarnings(state.warnings);
      state.updatedAt = now;
      setTranscriptionForModel(item, transcriptionModel, state);
    });
  } catch (error) {
    cleanupFinished = true;
    await progressWrite.catch(() => undefined);
    const message =
      error instanceof Error ? error.message : "Transcript cleanup failed.";
    const now = new Date().toISOString();
    await setRecordingTranscription(recordingId, (item) => {
      const state = transcriptionForModel(item, transcriptionModel);
      if (!state) return;
      state.postprocess = {
        status: "failed",
        model: postprocessModel,
        text: state.postprocess?.text ?? "",
        chunks: [
          {
            index: 0,
            status: "failed",
            model: postprocessModel,
            text: "",
            error: message,
            createdAt: now,
            updatedAt: now
          }
        ],
        progress: progress("cleanup", 0, 1),
        warnings: [],
        error: message,
        startedAt: state.postprocess?.startedAt ?? now,
        completedAt: now,
        updatedAt: now
      };
      state.warnings = [
        ...new Set([
          ...withoutCleanupFailureWarnings(state.warnings),
          `${CLEANUP_FAILURE_WARNING_PREFIX} ${message}`
        ])
      ];
      state.updatedAt = now;
      setTranscriptionForModel(item, transcriptionModel, state);
    });

    if (options.throwOnFailure) throw error;
  }
}

export async function runTranscriptCleanupForRecording(
  recordingId: string,
  model?: string
): Promise<RunTranscriptionResult> {
  const db = await readDb();
  const recording = db.recordings.find((item) => item.id === recordingId);
  if (!recording) {
    throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
  }

  const target = model?.trim()
    ? transcriptionForModel(recording, model.trim())
    : latestCompletedTranscription(recording);

  if (!target) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "No completed transcript is available for cleanup.",
      400
    );
  }

  await runPostprocessForModel(recordingId, target.model, db.sttSettings, {
    force: true,
    throwOnFailure: true
  });

  const refreshed = await readDb();
  const completed = refreshed.recordings.find((item) => item.id === recordingId);
  if (!completed) {
    throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
  }
  return publicResult({
    ...completed,
    transcription: transcriptionForModel(completed, target.model)
  });
}

export async function getTranscription(recordingId: string): Promise<{
  recording: LocalRecording;
  transcription: TranscriptionState | null;
  transcriptions: Record<string, TranscriptionState>;
}> {
  const db = await readDb();
  const recording = db.recordings.find((item) => item.id === recordingId);
  if (!recording) {
    throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
  }
  return {
    recording,
    transcription: recording.transcription ?? null,
    transcriptions: recording.transcriptions ?? {}
  };
}

export async function runTranscriptionForRecording(
  recordingId: string
): Promise<RunTranscriptionResult> {
  const db = await readDb();
  const recording = db.recordings.find((item) => item.id === recordingId);
  if (!recording) {
    throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
  }
  const storagePath = recording.storagePath;
  if (!storagePath) {
    throw new AppError(
      ErrorCode.InvalidInput,
      "Sync this recording before transcribing it.",
      400
    );
  }
  const settings = db.sttSettings;
  const provider = providerForModel(settings.model);
  const apiKey = await apiKeyForProvider(settings, provider);
  const inputPath = getAudioFilePath(storagePath);

  await setRecordingTranscription(recordingId, (item) => {
    setTranscriptionForModel(
      item,
      settings.model,
      newRunningState(transcriptionForModel(item, settings.model), settings.model, settings.language)
    );
  });

  if (provider === "soniox") {
    const durationSeconds =
      Number.isFinite(recording.duration) && recording.duration > 0
        ? recording.duration / 1000
        : undefined;

    try {
      await setRecordingTranscription(recordingId, (item) => {
        const state =
          transcriptionForModel(item, settings.model) ??
          newRunningState(null, settings.model, settings.language);
        state.progress = progress("stt", 0, 1);
        setTranscriptionForModel(item, settings.model, state);
      });
      const result = await transcribeFileWithSoniox({
        apiKey,
        audioPath: inputPath,
        model: settings.model,
        language: settings.language,
        durationSeconds
      });
      const now = new Date().toISOString();
      const completedChunk: TranscriptionChunk = {
        index: 0,
        startSeconds: 0,
        endSeconds: durationSeconds ?? null,
        status: "completed",
        model: result.model,
        text: result.text,
        usage: result.usage,
        warning: result.warning,
        createdAt: now,
        updatedAt: now
      };

      await setRecordingTranscription(recordingId, (item) => {
        const state =
          transcriptionForModel(item, settings.model) ??
          newRunningState(null, settings.model, settings.language);
        state.status = "completed";
        state.chunks = [completedChunk];
        state.progress = progress("stt", 1, 1);
        state.text = result.text;
        state.usage = result.usage;
        state.warnings = result.warning ? [result.warning] : [];
        state.error = undefined;
        state.completedAt = now;
        state.updatedAt = now;
        setTranscriptionForModel(item, settings.model, state);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed.";
      const now = new Date().toISOString();
      const failedChunk: TranscriptionChunk = {
        index: 0,
        startSeconds: 0,
        endSeconds: durationSeconds ?? null,
        status: "failed",
        model: settings.model,
        text: "",
        error: message,
        createdAt: now,
        updatedAt: now
      };

      await setRecordingTranscription(recordingId, (item) => {
        const state =
          transcriptionForModel(item, settings.model) ??
          newRunningState(null, settings.model, settings.language);
        state.status = "failed";
        state.chunks = [failedChunk];
        state.progress = progress("stt", 0, 1);
        state.text = "";
        state.warnings = [];
        state.error = message;
        state.completedAt = now;
        state.updatedAt = now;
        setTranscriptionForModel(item, settings.model, state);
      });
    }

    await runPostprocessForModel(recordingId, settings.model, settings);

    const refreshed = await readDb();
    const completed = refreshed.recordings.find((item) => item.id === recordingId);
    if (!completed) {
      throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
    }
    return publicResult({
      ...completed,
      transcription: transcriptionForModel(completed, settings.model)
    });
  }

  const chunks = await chunkAudioFile({
    recordingId,
    inputPath,
    chunkSeconds: settings.chunkSeconds,
    overlapSeconds: settings.overlapSeconds
  });

  await setRecordingTranscription(recordingId, (item) => {
    const state =
      transcriptionForModel(item, settings.model) ??
      newRunningState(null, settings.model, settings.language);
    state.status = "running";
    state.progress = progress("stt", 0, chunks.length);
    state.updatedAt = new Date().toISOString();
    setTranscriptionForModel(item, settings.model, state);
  });

  let usage: TranscriptionUsage | undefined;
  const warnings: string[] = [];
  const completedChunks: TranscriptionChunk[] = [];

  for (const chunk of chunks) {
    try {
      const result =
        provider === "deepgram"
          ? await transcribeChunkWithDeepgram({
              apiKey,
              audioPath: chunk.path,
              audioFormat: chunk.format,
              model: settings.model,
              language: settings.language
            })
          : await transcribeChunkWithOpenRouter({
              apiKey,
              audioPath: chunk.path,
              audioFormat: chunk.format,
              model: settings.model,
              fallbackModel: settings.fallbackModel,
              language: settings.language,
              temperature: settings.temperature
            });
      if (result.warning) warnings.push(result.warning);
      usage = mergeUsage(usage, result.usage);
      const now = new Date().toISOString();
      completedChunks.push({
        index: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        status: "completed",
        model: result.model,
        text: result.text,
        usage: result.usage,
        warning: result.warning,
        createdAt: now,
        updatedAt: now
      });

      await setRecordingTranscription(recordingId, (item) => {
        const state =
          transcriptionForModel(item, settings.model) ??
          newRunningState(null, settings.model, settings.language);
        state.status = "running";
        state.chunks = [...completedChunks];
        state.progress = progress("stt", completedChunks.length, chunks.length);
        state.text = completedChunks
          .map((completed) => completed.text.trim())
          .filter(Boolean)
          .join("\n\n");
        state.usage = usage;
        state.warnings = [...new Set(warnings)];
        state.updatedAt = new Date().toISOString();
        setTranscriptionForModel(item, settings.model, state);
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Transcription failed.";
      const now = new Date().toISOString();
      completedChunks.push({
        index: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        status: "failed",
        model: settings.model,
        text: "",
        error: message,
        createdAt: now,
        updatedAt: now
      });

      await setRecordingTranscription(recordingId, (item) => {
        const state =
          transcriptionForModel(item, settings.model) ??
          newRunningState(null, settings.model, settings.language);
        state.status = "failed";
        state.chunks = [...completedChunks];
        state.progress = progress("stt", completedChunks.length, chunks.length);
        state.text = completedChunks
          .map((completed) => completed.text.trim())
          .filter(Boolean)
          .join("\n\n");
        state.usage = usage;
        state.warnings = [...new Set(warnings)];
        state.error = message;
        state.completedAt = new Date().toISOString();
        state.updatedAt = new Date().toISOString();
        setTranscriptionForModel(item, settings.model, state);
      });

      const refreshed = await readDb();
      const failed = refreshed.recordings.find((item) => item.id === recordingId);
      if (!failed) throw error;
      return publicResult({
        ...failed,
        transcription: transcriptionForModel(failed, settings.model)
      });
    }
  }

  await setRecordingTranscription(recordingId, (item) => {
    const state =
      transcriptionForModel(item, settings.model) ??
      newRunningState(null, settings.model, settings.language);
    state.status = "completed";
    state.chunks = [...completedChunks];
    state.progress = progress("stt", completedChunks.length, chunks.length);
    state.text = completedChunks
      .map((completed) => completed.text.trim())
      .filter(Boolean)
      .join("\n\n");
    state.usage = usage;
    state.warnings = [...new Set(warnings)];
    state.error = undefined;
    state.completedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    setTranscriptionForModel(item, settings.model, state);
  });

  await runPostprocessForModel(recordingId, settings.model, settings);

  const refreshed = await readDb();
  const completed = refreshed.recordings.find((item) => item.id === recordingId);
  if (!completed) {
    throw new AppError(ErrorCode.NotFound, "Recording not found.", 404);
  }
  return publicResult({
    ...completed,
    transcription: transcriptionForModel(completed, settings.model)
  });
}

export async function runTranscriptions(
  recordingIds: string[]
): Promise<RunTranscriptionResult[]> {
  const results: RunTranscriptionResult[] = [];
  for (const recordingId of recordingIds) {
    results.push(await runTranscriptionForRecording(recordingId));
  }
  return results;
}

export async function runTranscriptCleanups(
  recordingIds: string[]
): Promise<RunTranscriptionResult[]> {
  return mapWithConcurrency(recordingIds, cleanupRecordingConcurrency(), (recordingId) =>
    runTranscriptCleanupForRecording(recordingId)
  );
}
