import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlaudDevice } from "@/lib/plaud/types";

const DB_PATH = join(process.cwd(), "data", "db.json");

export interface PlaudConnection {
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  authMode?: "web-token" | "oauth";
  apiBase: string;
  workspaceId: string | null;
  plaudEmail: string | null;
  accessTokenExpiresAt?: string | null;
  tokenType?: string | null;
  oauthTokenFile?: string | null;
  devices: PlaudDevice[];
  connectedAt: string;
  updatedAt: string;
  lastSync: string | null;
}

export interface LocalRecording {
  id: string;
  filename: string;
  duration: number;
  startTime: string;
  endTime: string;
  filesize: number;
  fileMd5: string;
  serialNumber: string;
  versionMs: number;
  timezone: number;
  zonemins: number;
  scene: number;
  isTrash: boolean;
  storagePath: string | null;
  downloadedAt: string | null;
  updatedAt: string;
  transcription?: TranscriptionState | null;
  transcriptions?: Record<string, TranscriptionState>;
}

export interface SttSettings {
  encryptedOpenRouterApiKey: string | null;
  encryptedDeepgramApiKey: string | null;
  encryptedSonioxApiKey: string | null;
  model: string;
  fallbackModel: string;
  postprocessEnabled: boolean;
  postprocessModel: string;
  language: string;
  chunkSeconds: number;
  overlapSeconds: number;
  temperature: number;
  concurrency: number;
  updatedAt: string | null;
}

export interface AutomationSettings {
  autoSyncEnabled: boolean;
  autoTranscribeEnabled: boolean;
  intervalMinutes: number;
  transcribeBatchSize: number;
  lastRunStatus: "idle" | "running" | "completed" | "failed";
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunMessage: string | null;
  updatedAt: string | null;
}

export interface SyncProgressState {
  status: "idle" | "running" | "completed" | "failed";
  stage: "idle" | "listing" | "downloading" | "completed" | "failed";
  scope: "all" | "selected";
  requested: number | null;
  total: number;
  completed: number;
  newRecordings: number;
  updatedRecordings: number;
  skippedRecordings: number;
  failedRecordings: number;
  currentRecordingId: string | null;
  currentFilename: string | null;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface TranscriptionUsage {
  seconds?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
}

export interface TranscriptionProgress {
  stage: "stt" | "cleanup";
  completed: number;
  total: number;
  percent: number;
  active?: number;
  generatedChars?: number;
  estimatedOutputTokens?: number;
  tokensPerSecond?: number;
  charsPerSecond?: number;
}

export interface OpenClawDeliveryState {
  status: "pending" | "sent" | "failed" | "skipped";
  webhookUrl: string | null;
  idempotencyKey: string | null;
  transcriptHash: string | null;
  error?: string;
  sentAt: string | null;
  updatedAt: string;
}

export interface TranscriptionChunk {
  index: number;
  startSeconds: number;
  endSeconds: number | null;
  status: "completed" | "failed";
  model: string;
  text: string;
  usage?: TranscriptionUsage;
  warning?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptionPostprocessChunk {
  index: number;
  status: "completed" | "failed";
  model: string;
  text: string;
  usage?: TranscriptionUsage;
  warning?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptionPostprocessState {
  status: "idle" | "running" | "completed" | "failed";
  model: string;
  text: string;
  chunks: TranscriptionPostprocessChunk[];
  progress?: TranscriptionProgress;
  usage?: TranscriptionUsage;
  warnings: string[];
  error?: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface TranscriptionState {
  status: "idle" | "running" | "completed" | "failed";
  model: string;
  language: string;
  text: string;
  chunks: TranscriptionChunk[];
  progress?: TranscriptionProgress;
  postprocess?: TranscriptionPostprocessState;
  openClaw?: OpenClawDeliveryState | null;
  usage?: TranscriptionUsage;
  warnings: string[];
  error?: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface OpenClawSettings {
  enabled: boolean;
  webhookUrl: string;
  encryptedWebhookToken: string | null;
  agentName: string;
  model: string;
  thinking: string;
  deliver: boolean;
  deliveryChannel: string;
  deliveryTarget: string;
  promptTemplate: string;
  updatedAt: string | null;
}

export interface PlaudeDb {
  connection: PlaudConnection | null;
  recordings: LocalRecording[];
  sttSettings: SttSettings;
  automationSettings: AutomationSettings;
  syncProgress: SyncProgressState;
  openClawSettings: OpenClawSettings;
}

export const DEFAULT_STT_MODEL = "openai/whisper-large-v3-turbo";
export const DEFAULT_STT_FALLBACK_MODEL = "openai/whisper-large-v3-turbo";
export const DEFAULT_POSTPROCESS_MODEL = "deepseek/deepseek-v4-flash";
export const MIN_STT_CHUNK_SECONDS = 60;
export const MAX_STT_CHUNK_SECONDS = 300;
export const DEFAULT_STT_CHUNK_SECONDS = 300;
export const MIN_AUTOMATION_INTERVAL_MINUTES = 5;
export const MAX_AUTOMATION_INTERVAL_MINUTES = 1440;
export const DEFAULT_AUTOMATION_INTERVAL_MINUTES = 15;
export const MIN_AUTOMATION_TRANSCRIBE_BATCH_SIZE = 1;
export const MAX_AUTOMATION_TRANSCRIBE_BATCH_SIZE = 20;
export const DEFAULT_AUTOMATION_TRANSCRIBE_BATCH_SIZE = 3;
export const DEFAULT_OPENCLAW_WEBHOOK_URL =
  "http://127.0.0.1:18789/hooks/agent";
export const DEFAULT_OPENCLAW_PROMPT_TEMPLATE = [
  "Plaud transcription completed.",
  "",
  "Recording: {{filename}}",
  "Started at: {{startTime}}",
  "Duration: {{duration}}",
  "STT model: {{model}}",
  "Cleanup model: {{cleanupModel}}",
  "",
  "Transcript:",
  "{{transcript}}"
].join("\n");

export const STT_MODEL_PRESETS = [
  {
    id: "microsoft/mai-transcribe-1.5",
    label: "MAI-Transcribe 1.5",
    description: "Microsoft transcription model served through OpenRouter."
  },
  {
    id: "nvidia/parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3",
    description: "NVIDIA ASR model served through OpenRouter."
  },
  {
    id: "google/chirp-3",
    label: "Chirp 3",
    description: "Google ASR model served through OpenRouter."
  },
  {
    id: "openai/whisper-1",
    label: "Whisper 1",
    description: "OpenAI Whisper API model served through OpenRouter."
  },
  {
    id: "openai/gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    description: "OpenAI transcription model served through OpenRouter."
  },
  {
    id: "openai/whisper-large-v3-turbo",
    label: "Whisper Large V3 Turbo",
    description: "Fast, low-cost default for Korean speech."
  },
  {
    id: "openai/whisper-large-v3",
    label: "Whisper Large V3",
    description: "Higher quality Whisper preset for noisy recordings."
  },
  {
    id: "mistralai/voxtral-mini-transcribe",
    label: "Voxtral Mini Transcribe",
    description: "Efficient meeting-note transcription preset."
  },
  {
    id: "qwen/qwen3-asr-flash-2026-02-10",
    label: "Qwen3 ASR Flash",
    description: "Fast multilingual ASR preset with Korean support."
  },
  {
    id: "openai/gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    description: "Token-priced high-throughput transcription preset."
  },
  {
    id: "openrouter/auto",
    label: "OpenRouter Auto",
    description: "Experimental router preset; falls back if STT is unsupported."
  },
  {
    id: "deepgram/nova-3",
    label: "Deepgram Nova-3",
    description: "Deepgram prerecorded STT model using a separate Deepgram API key."
  },
  {
    id: "soniox/stt-async-v5",
    label: "Soniox STT Async v5",
    description: "Full-file Korean transcription with bundled speaker diarization."
  }
] as const;

export const POSTPROCESS_MODEL_PRESETS = [
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Low-cost long-context cleanup through OpenRouter with DeepInfra FP4-first routing."
  }
] as const;

export function defaultSttSettings(): SttSettings {
  return {
    encryptedOpenRouterApiKey: null,
    encryptedDeepgramApiKey: null,
    encryptedSonioxApiKey: null,
    model: DEFAULT_STT_MODEL,
    fallbackModel: DEFAULT_STT_FALLBACK_MODEL,
    postprocessEnabled: true,
    postprocessModel: DEFAULT_POSTPROCESS_MODEL,
    language: "ko",
    chunkSeconds: DEFAULT_STT_CHUNK_SECONDS,
    overlapSeconds: 3,
    temperature: 0,
    concurrency: 1,
    updatedAt: null
  };
}

export function defaultAutomationSettings(): AutomationSettings {
  return {
    autoSyncEnabled: false,
    autoTranscribeEnabled: false,
    intervalMinutes: DEFAULT_AUTOMATION_INTERVAL_MINUTES,
    transcribeBatchSize: DEFAULT_AUTOMATION_TRANSCRIBE_BATCH_SIZE,
    lastRunStatus: "idle",
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunMessage: null,
    updatedAt: null
  };
}

export function defaultSyncProgressState(): SyncProgressState {
  return {
    status: "idle",
    stage: "idle",
    scope: "all",
    requested: null,
    total: 0,
    completed: 0,
    newRecordings: 0,
    updatedRecordings: 0,
    skippedRecordings: 0,
    failedRecordings: 0,
    currentRecordingId: null,
    currentFilename: null,
    errors: [],
    startedAt: null,
    completedAt: null,
    updatedAt: null
  };
}

export function defaultOpenClawSettings(): OpenClawSettings {
  return {
    enabled: false,
    webhookUrl: DEFAULT_OPENCLAW_WEBHOOK_URL,
    encryptedWebhookToken: null,
    agentName: "Plaud transcript",
    model: "",
    thinking: "",
    deliver: false,
    deliveryChannel: "discord",
    deliveryTarget: "",
    promptTemplate: DEFAULT_OPENCLAW_PROMPT_TEMPLATE,
    updatedAt: null
  };
}

const EMPTY_DB: PlaudeDb = {
  connection: null,
  recordings: [],
  sttSettings: defaultSttSettings(),
  automationSettings: defaultAutomationSettings(),
  syncProgress: defaultSyncProgressState(),
  openClawSettings: defaultOpenClawSettings()
};

let writeLock: Promise<unknown> = Promise.resolve();

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSttSettings(settings: Partial<SttSettings> | undefined): SttSettings {
  const defaults = defaultSttSettings();
  const merged = {
    ...defaults,
    ...(settings ?? {})
  };
  return {
    ...merged,
    postprocessEnabled:
      typeof merged.postprocessEnabled === "boolean"
        ? merged.postprocessEnabled
        : defaults.postprocessEnabled,
    postprocessModel:
      typeof merged.postprocessModel === "string" && merged.postprocessModel.trim()
        ? merged.postprocessModel.trim()
        : defaults.postprocessModel,
    chunkSeconds: numberInRange(
      merged.chunkSeconds,
      defaults.chunkSeconds,
      MIN_STT_CHUNK_SECONDS,
      MAX_STT_CHUNK_SECONDS
    ),
    overlapSeconds: numberInRange(merged.overlapSeconds, defaults.overlapSeconds, 0, 30),
    temperature: Math.min(1, Math.max(0, Number(merged.temperature) || 0)),
    concurrency: 1
  };
}

function normalizeAutomationSettings(
  settings: Partial<AutomationSettings> | undefined
): AutomationSettings {
  const defaults = defaultAutomationSettings();
  const merged = {
    ...defaults,
    ...(settings ?? {})
  };
  const lastRunStatus = ["idle", "running", "completed", "failed"].includes(
    String(merged.lastRunStatus)
  )
    ? merged.lastRunStatus
    : defaults.lastRunStatus;
  return {
    ...merged,
    autoSyncEnabled:
      typeof merged.autoSyncEnabled === "boolean"
        ? merged.autoSyncEnabled
        : defaults.autoSyncEnabled,
    autoTranscribeEnabled:
      typeof merged.autoTranscribeEnabled === "boolean"
        ? merged.autoTranscribeEnabled
        : defaults.autoTranscribeEnabled,
    intervalMinutes: numberInRange(
      merged.intervalMinutes,
      defaults.intervalMinutes,
      MIN_AUTOMATION_INTERVAL_MINUTES,
      MAX_AUTOMATION_INTERVAL_MINUTES
    ),
    transcribeBatchSize: numberInRange(
      merged.transcribeBatchSize,
      defaults.transcribeBatchSize,
      MIN_AUTOMATION_TRANSCRIBE_BATCH_SIZE,
      MAX_AUTOMATION_TRANSCRIBE_BATCH_SIZE
    ),
    lastRunStatus,
    lastRunStartedAt:
      typeof merged.lastRunStartedAt === "string" ? merged.lastRunStartedAt : null,
    lastRunCompletedAt:
      typeof merged.lastRunCompletedAt === "string" ? merged.lastRunCompletedAt : null,
    lastRunMessage:
      typeof merged.lastRunMessage === "string" ? merged.lastRunMessage : null,
    updatedAt: typeof merged.updatedAt === "string" ? merged.updatedAt : null
  };
}

function normalizeSyncProgressState(
  state: Partial<SyncProgressState> | undefined
): SyncProgressState {
  const defaults = defaultSyncProgressState();
  const merged = {
    ...defaults,
    ...(state ?? {})
  };
  const status = ["idle", "running", "completed", "failed"].includes(String(merged.status))
    ? merged.status
    : defaults.status;
  const stage = ["idle", "listing", "downloading", "completed", "failed"].includes(
    String(merged.stage)
  )
    ? merged.stage
    : defaults.stage;
  const scope = merged.scope === "selected" ? "selected" : "all";
  return {
    ...merged,
    status,
    stage,
    scope,
    requested:
      typeof merged.requested === "number" && Number.isFinite(merged.requested)
        ? Math.max(0, Math.round(merged.requested))
        : null,
    total: Math.max(0, Math.round(Number(merged.total) || 0)),
    completed: Math.max(0, Math.round(Number(merged.completed) || 0)),
    newRecordings: Math.max(0, Math.round(Number(merged.newRecordings) || 0)),
    updatedRecordings: Math.max(0, Math.round(Number(merged.updatedRecordings) || 0)),
    skippedRecordings: Math.max(0, Math.round(Number(merged.skippedRecordings) || 0)),
    failedRecordings: Math.max(0, Math.round(Number(merged.failedRecordings) || 0)),
    currentRecordingId:
      typeof merged.currentRecordingId === "string" ? merged.currentRecordingId : null,
    currentFilename:
      typeof merged.currentFilename === "string" ? merged.currentFilename : null,
    errors: Array.isArray(merged.errors)
      ? merged.errors.filter((error): error is string => typeof error === "string")
      : [],
    startedAt: typeof merged.startedAt === "string" ? merged.startedAt : null,
    completedAt: typeof merged.completedAt === "string" ? merged.completedAt : null,
    updatedAt: typeof merged.updatedAt === "string" ? merged.updatedAt : null
  };
}

function normalizeOpenClawSettings(
  settings: Partial<OpenClawSettings> | undefined
): OpenClawSettings {
  const defaults = defaultOpenClawSettings();
  const merged = {
    ...defaults,
    ...(settings ?? {})
  };
  return {
    ...merged,
    enabled:
      typeof merged.enabled === "boolean" ? merged.enabled : defaults.enabled,
    webhookUrl:
      typeof merged.webhookUrl === "string" && merged.webhookUrl.trim()
        ? merged.webhookUrl.trim()
        : defaults.webhookUrl,
    encryptedWebhookToken:
      typeof merged.encryptedWebhookToken === "string" &&
      merged.encryptedWebhookToken.trim()
        ? merged.encryptedWebhookToken
        : null,
    agentName:
      typeof merged.agentName === "string" && merged.agentName.trim()
        ? merged.agentName.trim()
        : defaults.agentName,
    model:
      typeof merged.model === "string" ? merged.model.trim() : defaults.model,
    thinking:
      typeof merged.thinking === "string"
        ? merged.thinking.trim()
        : defaults.thinking,
    deliver:
      typeof merged.deliver === "boolean" ? merged.deliver : defaults.deliver,
    deliveryChannel:
      typeof merged.deliveryChannel === "string"
        ? merged.deliveryChannel.trim()
        : defaults.deliveryChannel,
    deliveryTarget:
      typeof merged.deliveryTarget === "string"
        ? merged.deliveryTarget.trim()
        : defaults.deliveryTarget,
    promptTemplate:
      typeof merged.promptTemplate === "string" && merged.promptTemplate.trim()
        ? merged.promptTemplate
        : defaults.promptTemplate,
    updatedAt: typeof merged.updatedAt === "string" ? merged.updatedAt : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function newestTranscription(
  transcriptions: Record<string, TranscriptionState>
): TranscriptionState | null {
  const states = Object.values(transcriptions);
  if (states.length === 0) return null;
  return states.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return rightTime - leftTime;
    }
    return right.model.localeCompare(left.model);
  })[0];
}

function normalizeRecording(recording: LocalRecording): LocalRecording {
  const transcriptions: Record<string, TranscriptionState> = {};

  if (isRecord(recording.transcriptions)) {
    for (const [model, transcription] of Object.entries(recording.transcriptions)) {
      if (isRecord(transcription) && typeof transcription.model === "string") {
        transcriptions[model] = transcription as TranscriptionState;
      }
    }
  }

  if (recording.transcription?.model) {
    transcriptions[recording.transcription.model] ??= recording.transcription;
  }

  const latest = recording.transcription ?? newestTranscription(transcriptions);

  return {
    ...recording,
    transcription: latest,
    transcriptions:
      Object.keys(transcriptions).length > 0 ? transcriptions : undefined
  };
}

async function ensureDataDir(): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
}

export async function readDb(): Promise<PlaudeDb> {
  try {
    const text = await readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(text) as PlaudeDb;
    return {
      connection: parsed.connection ?? null,
      recordings: Array.isArray(parsed.recordings)
        ? parsed.recordings.map((recording) => normalizeRecording(recording))
        : [],
      sttSettings: normalizeSttSettings(parsed.sttSettings),
      automationSettings: normalizeAutomationSettings(parsed.automationSettings),
      syncProgress: normalizeSyncProgressState(parsed.syncProgress),
      openClawSettings: normalizeOpenClawSettings(parsed.openClawSettings)
    };
  } catch {
    return structuredClone(EMPTY_DB);
  }
}

async function writeDb(db: PlaudeDb): Promise<void> {
  await ensureDataDir();
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await rename(tmpPath, DB_PATH);
}

export async function updateDb<T>(
  updater: (db: PlaudeDb) => T | Promise<T>
): Promise<T> {
  const run = writeLock.then(async () => {
    const db = await readDb();
    const result = await updater(db);
    await writeDb(db);
    return result;
  });
  writeLock = run.catch(() => undefined);
  return run;
}
