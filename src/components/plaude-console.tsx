"use client";

import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  CheckCircle2,
  Cookie,
  Copy,
  CreditCard,
  Download,
  FileText,
  HardDrive,
  KeyRound,
  Link2,
  LogOut,
  Loader2,
  PlugZap,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Waves,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type PlaudRegion = "global" | "euc1" | "apse1" | "apne1" | "unknown";

interface ConnectorPayload {
  accessToken: string;
  apiBase: string;
  region: PlaudRegion;
  capturedAt: number;
}

interface ConnectorBridge {
  version: number;
  connect(): Promise<ConnectorPayload>;
}

declare global {
  interface Window {
    __riffadoConnector?: ConnectorBridge;
  }
}

interface ConnectionState {
  connected: boolean;
  connection?: {
    authMode?: "web-token" | "oauth";
    apiBase: string;
    workspaceId: string | null;
    plaudEmail: string | null;
    accessTokenExpiresAt?: string | null;
    tokenType?: string | null;
    oauthTokenFile?: string | null;
    connectedAt: string;
    updatedAt: string;
    lastSync: string | null;
    devices: { sn: string; name: string; model: string }[];
  };
  localRecordings?: number;
  downloadedRecordings?: number;
}

interface RecordingRow {
  id: string;
  filename: string;
  duration: number;
  startTime: string;
  filesize: number;
  serialNumber: string;
  versionMs: number;
  downloaded: boolean;
  downloadedAt: string | null;
  audioUrl: string | null;
  transcription: TranscriptionState | null;
  transcriptions?: Record<string, TranscriptionState> | null;
}

interface RecordingsState {
  connected: boolean;
  total: number;
  recordings: RecordingRow[];
  localOnly: RecordingRow[];
}

interface TranscriptionState {
  status: "idle" | "running" | "completed" | "failed";
  model: string;
  language: string;
  text: string;
  chunks: {
    index: number;
    status: "completed" | "failed";
    text: string;
    startSeconds?: number;
    endSeconds?: number | null;
    model?: string;
    warning?: string;
    error?: string;
  }[];
  progress?: TranscriptionProgress;
  warnings: string[];
  postprocess?: TranscriptionPostprocessState;
  openClaw?: OpenClawDeliveryState | null;
  error?: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface OpenClawDeliveryState {
  status: "pending" | "sent" | "failed" | "skipped";
  webhookUrl: string | null;
  idempotencyKey: string | null;
  transcriptHash: string | null;
  error?: string;
  sentAt: string | null;
  updatedAt: string;
}

interface TranscriptionPostprocessState {
  status: "idle" | "running" | "completed" | "failed";
  model: string;
  text: string;
  chunks: {
    index: number;
    status: "completed" | "failed";
    text: string;
    warning?: string;
    error?: string;
  }[];
  progress?: TranscriptionProgress;
  warnings: string[];
  error?: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface SttPreset {
  id: string;
  label: string;
  description: string;
}

interface SttSettings {
  hasApiKey: boolean;
  hasDeepgramApiKey: boolean;
  hasSonioxApiKey: boolean;
  model: string;
  fallbackModel: string;
  postprocessEnabled: boolean;
  postprocessModel: string;
  language: string;
  chunkSeconds: number;
  overlapSeconds: number;
  temperature: number;
  concurrency: number;
  presets: SttPreset[];
  postprocessPresets: SttPreset[];
}

interface AutomationSettings {
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

interface SyncProgressState {
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

interface OpenClawSettings {
  enabled: boolean;
  webhookUrl: string;
  hasWebhookToken: boolean;
  envWebhookUrl: boolean;
  envWebhookToken: boolean;
  agentName: string;
  model: string;
  thinking: string;
  deliver: boolean;
  promptTemplate: string;
  updatedAt: string | null;
}

interface UsageWindow {
  startTime: string;
  endTime: string;
  requests: number;
  costUsd: number;
  inputAudioDurationMs: number;
  truncated?: boolean;
}

interface ProviderUsageState {
  generatedAt: string;
  providers: {
    openRouter: {
      hasApiKey: boolean;
      account?: {
        totalCredits: number;
        totalUsage: number;
        remaining: number;
      } | null;
      key?: {
        label: string | null;
        limit: number | null;
        limitRemaining: number | null;
        usage: number | null;
        usageDaily: number | null;
        usageWeekly: number | null;
        usageMonthly: number | null;
        byokUsage: number | null;
        byokUsageDaily: number | null;
        byokUsageWeekly: number | null;
        byokUsageMonthly: number | null;
        isFreeTier: boolean | null;
      } | null;
      accountError?: string | null;
      keyError?: string | null;
      error?: string;
    };
    soniox: {
      hasApiKey: boolean;
      balanceAvailable: boolean;
      last31Days?: UsageWindow;
      monthToDate?: UsageWindow;
      error?: string;
    };
  };
}

interface TranscriptionRunResult {
  recordingId: string;
  status: TranscriptionState["status"];
  text: string;
  chunks: number;
  warnings: string[];
  error?: string;
}

interface TranscriptionProgress {
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatAudioHours(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0h";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  return `${hours.toFixed(hours >= 10 ? 1 : 2)}h`;
}

function automationStatusLabel(status: AutomationSettings["lastRunStatus"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

function nextAutomationRunLabel(settings: AutomationSettings): string {
  if (!settings.autoSyncEnabled && !settings.autoTranscribeEnabled) return "Disabled";
  const completedAt = Date.parse(settings.lastRunCompletedAt ?? "");
  if (!Number.isFinite(completedAt)) return "On next scheduler tick";
  return formatDate(new Date(completedAt + settings.intervalMinutes * 60_000).toISOString());
}

function formatRelativeExpiry(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const expiresAt = new Date(value).getTime();
  if (!Number.isFinite(expiresAt)) return "Unknown";
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "Expired";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 90) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

function isAuthRequired(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "code" in payload.error &&
      payload.error.code === "AUTH_REQUIRED"
  );
}

function redirectToLoginIfNeeded(response: Response, payload: unknown): void {
  if (response.status === 401 && isAuthRequired(payload)) {
    window.location.replace("/");
  }
}

function transcriptionStatusLabel(status: TranscriptionState["status"]): string {
  switch (status) {
    case "completed":
      return "Transcribed";
    case "running":
      return "Transcribing";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Queued";
  }
}

function postprocessStatusLabel(status: TranscriptionPostprocessState["status"]): string {
  switch (status) {
    case "completed":
      return "Cleaned";
    case "running":
      return "Cleaning";
    case "failed":
      return "Cleanup failed";
    case "idle":
    default:
      return "Cleanup queued";
  }
}

function openClawStatusLabel(status: OpenClawDeliveryState["status"]): string {
  switch (status) {
    case "sent":
      return "OpenClaw sent";
    case "pending":
      return "OpenClaw sending";
    case "failed":
      return "OpenClaw failed";
    case "skipped":
    default:
      return "OpenClaw skipped";
  }
}

type SttProvider = "deepgram" | "openrouter" | "soniox";

function providerForModel(model: string | null | undefined): SttProvider {
  if (model?.startsWith("deepgram/")) return "deepgram";
  if (model?.startsWith("soniox/")) return "soniox";
  return "openrouter";
}

function providerLabel(provider: SttProvider): string {
  if (provider === "deepgram") return "Deepgram";
  if (provider === "soniox") return "Soniox";
  return "OpenRouter";
}

function transcriptionPillClass(status: TranscriptionState["status"]): string {
  if (status === "completed") return "pill ok";
  if (status === "running") return "pill working";
  if (status === "failed") return "pill error";
  return "pill";
}

function compareRecordingTime(left: RecordingRow, right: RecordingRow): number {
  const leftTime = Date.parse(left.startTime);
  const rightTime = Date.parse(right.startTime);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  return left.filename.localeCompare(right.filename);
}

function latestTranscriptionFirst(left: TranscriptionState, right: TranscriptionState): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  return left.model.localeCompare(right.model);
}

function transcriptionVariants(recording: RecordingRow): TranscriptionState[] {
  const byModel = new Map<string, TranscriptionState>();
  for (const transcription of Object.values(recording.transcriptions ?? {})) {
    if (transcription?.model) byModel.set(transcription.model, transcription);
  }
  if (recording.transcription?.model) {
    byModel.set(recording.transcription.model, recording.transcription);
  }
  return [...byModel.values()].sort(latestTranscriptionFirst);
}

function transcriptToggleKey(recordingId: string, model: string): string {
  return `${recordingId}::${model}`;
}

function cleanupBusyKey(recordingId: string, model: string): string {
  return `cleanup:${recordingId}:${model}`;
}

function openClawBusyKey(recordingId: string, model: string): string {
  return `openclaw:${recordingId}:${model}`;
}

function transcriptionText(transcription: TranscriptionState): string {
  if (transcription.postprocess?.status === "completed" && transcription.postprocess.text) {
    return transcription.postprocess.text;
  }
  return transcription.text || transcription.error || "No transcript text yet.";
}

function rawTranscriptionText(transcription: TranscriptionState): string {
  return transcription.text || transcription.error || "No transcript text yet.";
}

function activeProgress(
  transcription: TranscriptionState | null | undefined
): TranscriptionProgress | null {
  if (!transcription) return null;
  if (transcription.postprocess?.status === "running") {
    return transcription.postprocess.progress ?? null;
  }
  if (transcription.status === "running") {
    return transcription.progress ?? null;
  }
  return null;
}

function progressStageLabel(stage: TranscriptionProgress["stage"]): string {
  return stage === "cleanup" ? "LLM cleanup" : "STT";
}

function formatRate(value: number | undefined, unit: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}/s`;
}

function progressDetailParts(progress: TranscriptionProgress): string[] {
  const parts: string[] = [];
  if (progress.active && progress.total > 1) {
    parts.push(`chunk ${progress.active}/${progress.total}`);
  }
  if (typeof progress.generatedChars === "number" && progress.generatedChars > 0) {
    parts.push(`${progress.generatedChars.toLocaleString()} chars`);
  }
  if (
    typeof progress.estimatedOutputTokens === "number" &&
    progress.estimatedOutputTokens > 0
  ) {
    parts.push(`~${progress.estimatedOutputTokens.toLocaleString()} tok`);
  }
  const tokenRate = formatRate(progress.tokensPerSecond, "tok");
  if (tokenRate) parts.push(tokenRate);
  return parts;
}

function syncPercent(progress: SyncProgressState): number {
  if (progress.status === "completed" || progress.stage === "completed") return 100;
  if (progress.total > 0) {
    return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
  }
  return progress.status === "running" ? 5 : 0;
}

function syncStageLabel(progress: SyncProgressState): string {
  if (progress.status === "failed") return "Download failed";
  if (progress.stage === "listing") return "Reading Plaud list";
  if (progress.stage === "downloading") return "Downloading audio";
  if (progress.stage === "completed") return "Download complete";
  return "Download";
}

function syncDetailParts(progress: SyncProgressState): string[] {
  const parts = [
    `${progress.newRecordings + progress.updatedRecordings} saved`,
    `${progress.skippedRecordings} skipped`
  ];
  if (progress.failedRecordings > 0) parts.push(`${progress.failedRecordings} failed`);
  if (progress.scope === "selected" && progress.requested !== null) {
    parts.push(`${progress.requested} selected`);
  }
  return parts;
}

function optimisticSyncProgress(ids: string[] | undefined, totalFallback: number): SyncProgressState {
  const selected = ids?.length ? ids.length : null;
  const now = new Date().toISOString();
  return {
    status: "running",
    stage: "listing",
    scope: selected ? "selected" : "all",
    requested: selected,
    total: selected ?? Math.max(0, totalFallback),
    completed: 0,
    newRecordings: 0,
    updatedRecordings: 0,
    skippedRecordings: 0,
    failedRecordings: 0,
    currentRecordingId: ids?.length === 1 ? ids[0] : null,
    currentFilename: selected ? "Finding selected recordings" : "Finding recordings",
    errors: [],
    startedAt: now,
    completedAt: null,
    updatedAt: now
  };
}

function MetricTile({
  label,
  value,
  detail
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div className="status-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function RecordingBadges({
  downloaded,
  transcription,
  progress,
  syncProgress,
  variantCount
}: {
  downloaded: boolean;
  transcription?: TranscriptionState;
  progress?: TranscriptionProgress | null;
  syncProgress?: SyncProgressState | null;
  variantCount: number;
}) {
  const syncing = syncProgress?.status === "running";
  return (
    <div className="row-status">
      <span className={downloaded ? "pill ok" : "pill"}>{downloaded ? "Local" : "Cloud"}</span>
      {syncing && <span className="pill working">Downloading</span>}
      {transcription && (
        <span className={transcriptionPillClass(transcription.status)}>
          {transcriptionStatusLabel(transcription.status)}
        </span>
      )}
      {progress && <span className="pill working">{progressStageLabel(progress.stage)}</span>}
      {variantCount > 1 && <span className="pill count">{variantCount} models</span>}
    </div>
  );
}

function SyncDownloadPanel({ progress }: { progress: SyncProgressState }) {
  const percent = syncPercent(progress);
  const detailParts = syncDetailParts(progress);
  return (
    <div className={`sync-progress-panel ${progress.status}`}>
      <div className="sync-progress-icon">
        {progress.status === "failed" ? <AlertCircle size={18} /> : <Download size={18} />}
      </div>
      <div className="sync-progress-main">
        <div className="sync-progress-row">
          <div>
            <span>{syncStageLabel(progress)}</span>
            <strong>{progress.currentFilename || "Preparing download"}</strong>
          </div>
          <em>
            {progress.completed}/{progress.total || progress.requested || 0}
          </em>
        </div>
        <div
          className="progress-track sync-track"
          role="progressbar"
          aria-label="Plaud download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="sync-progress-details">{detailParts.join(" · ")}</div>
        {progress.errors.length > 0 && (
          <div className="sync-progress-error">{progress.errors[0]}</div>
        )}
      </div>
    </div>
  );
}

function ProgressMeter({
  progress,
  compact = false
}: {
  progress: TranscriptionProgress;
  compact?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, progress.percent));
  const detailParts = progressDetailParts(progress);
  return (
    <div className={`progress-meter ${compact ? "compact" : ""}`}>
      <div className="progress-meter-row">
        <span>
          {progressStageLabel(progress.stage)} {progress.completed}/{progress.total}
        </span>
        <strong>{percent}%</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${progressStageLabel(progress.stage)} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {detailParts.length > 0 && (
        <div className="progress-meter-details">{detailParts.join(" · ")}</div>
      )}
    </div>
  );
}

function UsageMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function UsageOverviewCard({
  usage,
  loading,
  onRefresh
}: {
  usage: ProviderUsageState | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const openRouter = usage?.providers.openRouter;
  const soniox = usage?.providers.soniox;
  const openRouterRemaining =
    openRouter?.account?.remaining ?? openRouter?.key?.limitRemaining ?? null;
  const openRouterUsage = openRouter?.account?.totalUsage ?? openRouter?.key?.usage ?? null;
  const sonioxMonth = soniox?.monthToDate;
  const sonioxRecent = soniox?.last31Days;

  return (
    <section className="settings-card usage-settings">
      <div className="section-heading compact">
        <div className="section-title">
          <CreditCard size={18} />
          <span>Credit & usage</span>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          <span>Refresh</span>
        </button>
      </div>

      <div className="usage-provider">
        <div className="usage-provider-heading">
          <strong>OpenRouter</strong>
          <span className={`key-status ${openRouter?.hasApiKey ? "ready" : ""}`}>
            {openRouter?.hasApiKey ? "key ready" : "key missing"}
          </span>
        </div>
        <div className="usage-metrics">
          <UsageMetric
            label={openRouter?.account ? "Account remaining" : "Key remaining"}
            value={formatUsd(openRouterRemaining)}
            detail={
              openRouter?.key?.limit === null
                ? "unlimited key limit"
                : openRouter?.key?.limit
                  ? `${formatUsd(openRouter.key.limit)} key limit`
                  : undefined
            }
          />
          <UsageMetric
            label="Total used"
            value={formatUsd(openRouterUsage)}
            detail={
              openRouter?.key?.usageMonthly !== null &&
              openRouter?.key?.usageMonthly !== undefined
                ? `${formatUsd(openRouter.key.usageMonthly)} this month`
                : undefined
            }
          />
        </div>
        {openRouter?.accountError && (
          <p className="usage-note">Account credits: {openRouter.accountError}</p>
        )}
        {openRouter?.keyError && <p className="usage-note">Key usage: {openRouter.keyError}</p>}
        {openRouter?.error && <p className="usage-note error">{openRouter.error}</p>}
      </div>

      <div className="usage-provider">
        <div className="usage-provider-heading">
          <strong>Soniox</strong>
          <span className={`key-status ${soniox?.hasApiKey ? "ready" : ""}`}>
            {soniox?.hasApiKey ? "key ready" : "key missing"}
          </span>
        </div>
        <div className="usage-metrics">
          <UsageMetric
            label="This month"
            value={formatUsd(sonioxMonth?.costUsd)}
            detail={`${(sonioxMonth?.requests ?? 0).toLocaleString()} requests`}
          />
          <UsageMetric
            label="Last 31 days"
            value={formatUsd(sonioxRecent?.costUsd)}
            detail={formatAudioHours(sonioxRecent?.inputAudioDurationMs)}
          />
        </div>
        <p className="usage-note">
          Soniox balance is console-only; the app shows API usage logs and cost.
        </p>
        {sonioxMonth?.truncated && (
          <p className="usage-note">Usage log pagination reached the local safety cap.</p>
        )}
        {soniox?.error && <p className="usage-note error">{soniox.error}</p>}
      </div>

      {usage?.generatedAt && (
        <p className="usage-updated">Updated {formatDate(usage.generatedAt)}</p>
      )}
    </section>
  );
}

function AutomationSettingsCard({
  settings,
  onChange,
  onSave,
  onRunNow,
  saving,
  running,
  disabled
}: {
  settings: AutomationSettings;
  onChange: (settings: AutomationSettings) => void;
  onSave: () => void;
  onRunNow: () => void;
  saving: boolean;
  running: boolean;
  disabled: boolean;
}) {
  const automationOn = settings.autoSyncEnabled || settings.autoTranscribeEnabled;
  return (
    <section className="settings-card automation-settings">
      <div className="section-heading compact">
        <div className="section-title">
          <RefreshCw size={18} />
          <span>Automation</span>
        </div>
        <span className={`key-status ${automationOn ? "ready" : ""}`}>
          {automationOn ? "enabled" : "off"}
        </span>
      </div>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.autoSyncEnabled}
          onChange={(event) =>
            onChange({ ...settings, autoSyncEnabled: event.target.checked })
          }
        />
        <span>
          <strong>Auto sync</strong>
          <small>Periodically pull new Plaud recordings and download audio.</small>
        </span>
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.autoTranscribeEnabled}
          onChange={(event) =>
            onChange({ ...settings, autoTranscribeEnabled: event.target.checked })
          }
        />
        <span>
          <strong>Auto transcribe</strong>
          <small>Transcribe local recordings that do not have a result for the selected STT model.</small>
        </span>
      </label>

      <div className="settings-grid">
        <label>
          <span>Every minutes</span>
          <input
            type="number"
            min={5}
            max={1440}
            value={settings.intervalMinutes}
            onChange={(event) =>
              onChange({ ...settings, intervalMinutes: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>Transcribe batch</span>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.transcribeBatchSize}
            onChange={(event) =>
              onChange({ ...settings, transcribeBatchSize: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <div className="automation-status">
        <div>
          <span>Status</span>
          <strong>{automationStatusLabel(settings.lastRunStatus)}</strong>
        </div>
        <div>
          <span>Next run</span>
          <strong>{nextAutomationRunLabel(settings)}</strong>
        </div>
        {settings.lastRunMessage && <p>{settings.lastRunMessage}</p>}
      </div>

      <div className="settings-button-row">
        <button
          className="secondary-button"
          type="button"
          onClick={onRunNow}
          disabled={disabled || running || !automationOn}
        >
          {running ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          <span>Run now</span>
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={onSave}
          disabled={disabled || saving}
        >
          {saving ? <Loader2 className="spin" size={17} /> : <Settings size={17} />}
          <span>Save automation</span>
        </button>
      </div>
    </section>
  );
}

function OpenClawSettingsCard({
  settings,
  webhookTokenInput,
  onWebhookTokenInputChange,
  onChange,
  onSave,
  saving,
  disabled
}: {
  settings: OpenClawSettings;
  webhookTokenInput: string;
  onWebhookTokenInputChange: (value: string) => void;
  onChange: (settings: OpenClawSettings) => void;
  onSave: () => void;
  saving: boolean;
  disabled: boolean;
}) {
  return (
    <section className="settings-card openclaw-settings">
      <div className="section-heading compact">
        <div className="section-title">
          <PlugZap size={18} />
          <span>OpenClaw</span>
        </div>
        <span className={`key-status ${settings.enabled ? "ready" : ""}`}>
          {settings.enabled ? "enabled" : "off"}
        </span>
      </div>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) =>
            onChange({ ...settings, enabled: event.target.checked })
          }
        />
        <span>
          <strong>Auto-send completed transcripts</strong>
          <small>Send the final cleaned transcript to OpenClaw through its hook agent endpoint.</small>
        </span>
      </label>

      <input
        value={settings.webhookUrl}
        onChange={(event) =>
          onChange({ ...settings, webhookUrl: event.target.value })
        }
        placeholder="http://127.0.0.1:18789/hooks/agent"
        aria-label="OpenClaw webhook URL"
        disabled={settings.envWebhookUrl}
        spellCheck={false}
      />
      <input
        value={webhookTokenInput}
        onChange={(event) => onWebhookTokenInputChange(event.target.value)}
        type="password"
        placeholder={
          settings.hasWebhookToken ? "OpenClaw hook token saved" : "OpenClaw hook token"
        }
        aria-label="OpenClaw hook token"
        disabled={settings.envWebhookToken}
        spellCheck={false}
      />
      <input
        value={settings.agentName}
        onChange={(event) =>
          onChange({ ...settings, agentName: event.target.value })
        }
        placeholder="Plaud transcript"
        aria-label="OpenClaw run name"
      />
      <div className="settings-grid">
        <label>
          <span>Model</span>
          <input
            value={settings.model}
            onChange={(event) =>
              onChange({ ...settings, model: event.target.value })
            }
            placeholder="OpenClaw default"
            aria-label="OpenClaw model"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Thinking</span>
          <select
            value={settings.thinking}
            onChange={(event) =>
              onChange({ ...settings, thinking: event.target.value })
            }
            aria-label="OpenClaw thinking"
          >
            <option value="">Default</option>
            <option value="off">Off</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">XHigh</option>
          </select>
        </label>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.deliver}
          onChange={(event) =>
            onChange({ ...settings, deliver: event.target.checked })
          }
        />
        <span>
          <strong>Let OpenClaw deliver the final reply</strong>
          <small>Leave off if OpenClaw should only create an internal agent run.</small>
        </span>
      </label>
      <textarea
        value={settings.promptTemplate}
        onChange={(event) =>
          onChange({ ...settings, promptTemplate: event.target.value })
        }
        aria-label="OpenClaw prompt template"
        spellCheck={false}
      />
      <p className="preset-description">
        Placeholders: {"{{filename}}"}, {"{{startTime}}"}, {"{{duration}}"}, {"{{model}}"}, {"{{cleanupModel}}"}, {"{{transcript}}"}.
      </p>
      <button
        className="secondary-button full-width"
        type="button"
        onClick={onSave}
        disabled={disabled || saving}
      >
        {saving ? <Loader2 className="spin" size={17} /> : <Settings size={17} />}
        <span>Save OpenClaw</span>
      </button>
    </section>
  );
}

interface SpeakerTurn {
  index: number;
  start: string;
  end: string;
  speaker: string;
  text: string;
}

function parseSpeakerTurns(text: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\[(\d{2}:\d{2}:\d{2})-(\d{2}:\d{2}:\d{2})\]\s+(?:C\d{2}\s+)?(.+?):\s*(.+)$/
    );
    if (!match) continue;
    const [, start, end, rawSpeaker, speech] = match;
    const speaker = normalizeSpeakerLabel(rawSpeaker.replace(/\s+\[[a-z-]+\]$/i, "").trim());
    turns.push({
      index: turns.length,
      start,
      end,
      speaker: speaker || "Speaker ?",
      text: speech.trim()
    });
  }
  return turns;
}

function normalizeSpeakerLabel(value: string): string {
  if (!value) return "Speaker ?";
  if (/^speaker\b/i.test(value)) return value;
  if (/^\d+$/.test(value) || /^[A-Z]$/.test(value)) return `Speaker ${value}`;
  return value;
}

function speakerTone(speaker: string): number {
  let total = 0;
  for (const char of speaker) total += char.charCodeAt(0);
  return total % 5;
}

function transcriptPreviewText(text: string, speakerTurns: SpeakerTurn[]): string {
  if (speakerTurns.length >= 3) {
    return speakerTurns
      .slice(0, 3)
      .map((turn) => `${turn.speaker}: ${turn.text}`)
      .join(" ");
  }
  return text.slice(0, 260);
}

function TranscriptContent({
  text,
  speakerTurns
}: {
  text: string;
  speakerTurns: SpeakerTurn[];
}) {
  if (speakerTurns.length >= 3) {
    return (
      <div className="speaker-turn-list">
        {speakerTurns.map((turn) => (
          <div className={`speaker-turn tone-${speakerTone(turn.speaker)}`} key={turn.index}>
            <div className="speaker-stamp">
              <strong>{turn.speaker}</strong>
              <span>
                {turn.start} - {turn.end}
              </span>
            </div>
            <p>{turn.text}</p>
          </div>
        ))}
      </div>
    );
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <div className="transcript-plain">
      {(paragraphs.length ? paragraphs : [text]).map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
      ))}
    </div>
  );
}

function modelLabelFor(model: string, presets: SttPreset[] | undefined): string {
  return presets?.find((preset) => preset.id === model)?.label ?? model;
}

function TranscriptStack({
  recordingId,
  variants,
  sttSettings,
  expandedTranscripts,
  rawTranscriptViews,
  toggleTranscript,
  setTranscriptView,
  copyTranscript,
  cleanupTranscript,
  retryOpenClaw,
  busy
}: {
  recordingId: string;
  variants: TranscriptionState[];
  sttSettings: SttSettings | null;
  expandedTranscripts: Set<string>;
  rawTranscriptViews: Set<string>;
  toggleTranscript: (id: string) => void;
  setTranscriptView: (id: string, view: "cleaned" | "raw") => void;
  copyTranscript: (text: string) => Promise<void>;
  cleanupTranscript: (recordingId: string, model: string) => void;
  retryOpenClaw: (recordingId: string, model: string) => void;
  busy: string | null;
}) {
  return (
    <div className="transcript-stack">
      <div className="transcript-stack-title">
        <FileText size={15} />
        <span>Transcripts</span>
        <strong>{variants.length}</strong>
      </div>
      {variants.map((transcript, index) => {
        const toggleKey = transcriptToggleKey(recordingId, transcript.model);
        const transcriptDefaultsOpen =
          index === 0 && (transcript.status === "completed" || transcript.status === "failed");
        const transcriptOpen = transcriptDefaultsOpen
          ? !expandedTranscripts.has(toggleKey)
          : expandedTranscripts.has(toggleKey);
        const provider = providerForModel(transcript.model);
        const postprocess = transcript.postprocess;
        const cleaned = postprocess?.status === "completed" && Boolean(postprocess.text);
        const showingRaw = cleaned && rawTranscriptViews.has(toggleKey);
        const rawText = rawTranscriptionText(transcript);
        const text = cleaned && !showingRaw ? postprocess?.text ?? rawText : rawText;
        const speakerTurns = parseSpeakerTurns(text);
        const copyText = text;
        const cleanupBusy = busy === cleanupBusyKey(recordingId, transcript.model);
        const openClawBusy = busy === openClawBusyKey(recordingId, transcript.model);
        const progressState = activeProgress(transcript);

        return (
          <div className={`transcript-box ${transcriptOpen ? "open" : ""}`} key={toggleKey}>
            <div className="transcript-header">
              <div className="transcript-model">
                <div className="transcript-model-line">
                  <strong>{modelLabelFor(transcript.model, sttSettings?.presets)}</strong>
                  <span className={`provider-chip ${provider}`}>{providerLabel(provider)}</span>
                  {postprocess && (
                    <span className={`provider-chip cleanup ${postprocess.status}`}>
                      {postprocessStatusLabel(postprocess.status)}
                    </span>
                  )}
                  {transcript.openClaw && (
                    <span className={`provider-chip openclaw ${transcript.openClaw.status}`}>
                      {openClawStatusLabel(transcript.openClaw.status)}
                    </span>
                  )}
                </div>
                <span>{transcriptionStatusLabel(transcript.status)}</span>
              </div>
              <div className="transcript-actions">
                {cleaned && (
                  <div className="transcript-view-toggle" aria-label="Transcript view" role="group">
                    <button
                      type="button"
                      className={!showingRaw ? "active" : ""}
                      onClick={() => setTranscriptView(toggleKey, "cleaned")}
                    >
                      Cleaned
                    </button>
                    <button
                      type="button"
                      className={showingRaw ? "active" : ""}
                      onClick={() => setTranscriptView(toggleKey, "raw")}
                    >
                      Raw
                    </button>
                  </div>
                )}
                {copyText && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void copyTranscript(copyText)}
                  >
                    <Copy size={15} />
                    <span>Copy</span>
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => cleanupTranscript(recordingId, transcript.model)}
                  disabled={busy !== null || !sttSettings?.hasApiKey || transcript.status !== "completed"}
                >
                  {cleanupBusy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                  <span>{postprocess?.status === "completed" ? "Clean again" : "Clean"}</span>
                </button>
                {transcript.openClaw?.status === "failed" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => retryOpenClaw(recordingId, transcript.model)}
                    disabled={busy !== null || transcript.status !== "completed"}
                  >
                    {openClawBusy ? <Loader2 className="spin" size={15} /> : <PlugZap size={15} />}
                    <span>Retry OpenClaw</span>
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => toggleTranscript(toggleKey)}
                >
                  <FileText size={15} />
                  <span>{transcriptOpen ? "Hide" : "Show"}</span>
                </button>
              </div>
            </div>
            {progressState && <ProgressMeter progress={progressState} />}
            <div className="transcript-meta">
              <span>{transcript.model}</span>
              <span>{provider === "soniox" ? "full file" : `${transcript.chunks.length} chunks`}</span>
              {postprocess && <span>cleanup: {postprocess.model}</span>}
              {transcript.openClaw?.sentAt && (
                <span>openclaw: {formatDate(transcript.openClaw.sentAt)}</span>
              )}
              {cleaned && <span>{showingRaw ? "raw view" : "cleaned view"}</span>}
              {speakerTurns.length >= 3 && <span>{speakerTurns.length.toLocaleString()} turns</span>}
              <span>{text.length.toLocaleString()} chars</span>
              <span>{formatDate(transcript.updatedAt)}</span>
            </div>
            {transcript.warnings.length > 0 && (
              <div className="transcript-warning">{transcript.warnings.join(" ")}</div>
            )}
            {postprocess?.warnings.length ? (
              <div className="transcript-warning">{postprocess.warnings.join(" ")}</div>
            ) : null}
            {postprocess?.error && (
              <div className="transcript-warning">{postprocess.error}</div>
            )}
            {transcript.openClaw?.status === "failed" && transcript.openClaw.error && (
              <div className="transcript-warning">{transcript.openClaw.error}</div>
            )}
            {transcriptOpen ? (
              <TranscriptContent text={text} speakerTurns={speakerTurns} />
            ) : (
              <p className="transcript-preview">{transcriptPreviewText(text, speakerTurns)}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PlaudeConsole({ sessionUser }: { sessionUser: string }) {
  const [connection, setConnection] = useState<ConnectionState>({ connected: false });
  const [recordings, setRecordings] = useState<RecordingsState>({
    connected: false,
    total: 0,
    recordings: [],
    localOnly: []
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [manualSecret, setManualSecret] = useState("");
  const [manualApiBase, setManualApiBase] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [deepgramApiKeyInput, setDeepgramApiKeyInput] = useState("");
  const [sonioxApiKeyInput, setSonioxApiKeyInput] = useState("");
  const [openClawWebhookTokenInput, setOpenClawWebhookTokenInput] = useState("");
  const [sttSettings, setSttSettings] = useState<SttSettings | null>(null);
  const [automationSettings, setAutomationSettings] = useState<AutomationSettings | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null);
  const [openClawSettings, setOpenClawSettings] = useState<OpenClawSettings | null>(null);
  const [providerUsage, setProviderUsage] = useState<ProviderUsageState | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [openClawSaving, setOpenClawSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailRecordingId, setDetailRecordingId] = useState<string | null>(null);
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());
  const [rawTranscriptViews, setRawTranscriptViews] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const loadConnection = useCallback(async () => {
    const response = await fetch("/api/plaud/connection", { cache: "no-store" });
    const payload = (await response.json()) as ConnectionState;
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load Plaud connection"));
    setConnection(payload);
  }, []);

  const loadRecordings = useCallback(async () => {
    const response = await fetch("/api/plaud/recordings?limit=200", { cache: "no-store" });
    const payload = await response.json();
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load recordings"));
    setRecordings(payload as RecordingsState);
  }, []);

  const loadSttSettings = useCallback(async () => {
    const response = await fetch("/api/settings/stt", { cache: "no-store" });
    const payload = await response.json();
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load STT settings"));
    setSttSettings(payload.settings as SttSettings);
  }, []);

  const loadAutomationSettings = useCallback(async () => {
    const response = await fetch("/api/settings/automation", { cache: "no-store" });
    const payload = await response.json();
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load automation settings"));
    setAutomationSettings(payload.settings as AutomationSettings);
  }, []);

  const loadSyncProgress = useCallback(async () => {
    const response = await fetch("/api/plaud/sync", { cache: "no-store" });
    const payload = await response.json();
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load sync progress"));
    setSyncProgress(payload.syncProgress as SyncProgressState);
  }, []);

  const loadOpenClawSettings = useCallback(async () => {
    const response = await fetch("/api/settings/openclaw", { cache: "no-store" });
    const payload = await response.json();
    redirectToLoginIfNeeded(response, payload);
    if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load OpenClaw settings"));
    setOpenClawSettings(payload.settings as OpenClawSettings);
  }, []);

  const loadProviderUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const response = await fetch("/api/settings/usage", { cache: "no-store" });
      const payload = await response.json();
      redirectToLoginIfNeeded(response, payload);
      if (!response.ok) throw new Error(apiErrorMessage(payload, "Failed to load usage"));
      setProviderUsage(payload as ProviderUsageState);
    } catch (error) {
      setProviderUsage(null);
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to load usage"
      });
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setBusy("refresh");
    setNotice(null);
    try {
      await loadConnection();
      await loadSttSettings();
      await loadAutomationSettings();
      await loadSyncProgress();
      await loadOpenClawSettings();
      await loadRecordings();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Refresh failed"
      });
    } finally {
      setBusy(null);
    }
  }, [
    loadAutomationSettings,
    loadConnection,
    loadOpenClawSettings,
    loadRecordings,
    loadSyncProgress,
    loadSttSettings
  ]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as {
        type?: unknown;
        status?: unknown;
        message?: unknown;
      };
      if (payload?.type !== "plaud-oauth") return;

      setBusy((current) => (current === "oauth-web" ? null : current));
      if (payload.status === "success") {
        setSettingsOpen(false);
        setNotice({ type: "ok", text: "Plaud connected with web OAuth." });
        void refreshAll();
      } else {
        setNotice({
          type: "error",
          text:
            typeof payload.message === "string"
              ? payload.message
              : "Plaud OAuth connection failed"
        });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refreshAll]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    void loadProviderUsage();
    void loadAutomationSettings();
    void loadOpenClawSettings();
  }, [loadAutomationSettings, loadOpenClawSettings, loadProviderUsage, settingsOpen]);

  const allRows = useMemo(
    () => [...recordings.recordings, ...recordings.localOnly].sort(compareRecordingTime),
    [recordings]
  );
  const detailRecording = useMemo(
    () => (detailRecordingId ? allRows.find((row) => row.id === detailRecordingId) ?? null : null),
    [allRows, detailRecordingId]
  );
  const detailVariants = detailRecording ? transcriptionVariants(detailRecording) : [];
  const detailCleanupTarget = detailVariants.find(
    (item) => item.status === "completed" && item.text.trim()
  );
  const detailProgress = detailVariants.reduce<TranscriptionProgress | null>(
    (found, item) => found ?? activeProgress(item),
    null
  );
  const hasRunningWork = allRows.some((row) =>
    transcriptionVariants(row).some(
      (item) => item.status === "running" || item.postprocess?.status === "running"
    )
  );
  const hasRunningCleanup = allRows.some((row) =>
    transcriptionVariants(row).some((item) => item.postprocess?.status === "running")
  );
  const operationInFlight =
    busy === "transcribe" ||
    busy === "cleanup" ||
    Boolean(busy?.startsWith("transcribe:") || busy?.startsWith("cleanup:"));
  const syncOperationInFlight = busy === "sync" || Boolean(busy?.startsWith("sync:"));
  const visibleSyncProgress =
    syncProgress && (syncProgress.status === "running" || syncOperationInFlight)
      ? syncProgress
      : null;
  const progressPollMs =
    hasRunningCleanup || busy === "cleanup" || Boolean(busy?.startsWith("cleanup:")) ? 750 : 1500;

  useEffect(() => {
    if (detailRecordingId && !allRows.some((row) => row.id === detailRecordingId)) {
      setDetailRecordingId(null);
    }
  }, [allRows, detailRecordingId]);

  useEffect(() => {
    if (!hasRunningWork && !operationInFlight) return;

    let cancelled = false;
    const refreshProgress = async () => {
      try {
        await loadRecordings();
      } catch {
        // Keep progress polling quiet; the primary action still reports failures.
      }
    };
    void refreshProgress();
    const id = window.setInterval(() => {
      if (!cancelled) void refreshProgress();
    }, progressPollMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [hasRunningWork, loadRecordings, operationInFlight, progressPollMs]);

  useEffect(() => {
    if (!syncOperationInFlight && syncProgress?.status !== "running") return;

    let cancelled = false;
    const refreshSyncProgress = async () => {
      try {
        await loadSyncProgress();
      } catch {
        // The sync action itself surfaces failures; progress polling stays quiet.
      }
    };
    void refreshSyncProgress();
    const id = window.setInterval(() => {
      if (!cancelled) void refreshSyncProgress();
    }, 800);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [loadSyncProgress, syncOperationInFlight, syncProgress?.status]);

  useEffect(() => {
    if (!automationSettings?.autoSyncEnabled && !automationSettings?.autoTranscribeEnabled) return;

    let cancelled = false;
    const refreshAutomationState = async () => {
      try {
        await loadAutomationSettings();
        await loadRecordings();
      } catch {
        // Keep background UI polling quiet; explicit actions surface their own errors.
      }
    };
    const id = window.setInterval(() => {
      if (!cancelled) void refreshAutomationState();
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    automationSettings?.autoSyncEnabled,
    automationSettings?.autoTranscribeEnabled,
    loadAutomationSettings,
    loadRecordings
  ]);

  const selectedCount = selected.size;
  const downloadedCount = allRows.filter((row) => row.downloaded).length;
  const localAudioBytes = allRows.reduce(
    (sum, row) => sum + (row.downloaded ? row.filesize : 0),
    0
  );
  const completedTranscriptionResults = allRows.reduce(
    (sum, row) =>
      sum + transcriptionVariants(row).filter((item) => item.status === "completed").length,
    0
  );
  const transcribedCount = allRows.filter((row) =>
    transcriptionVariants(row).some((item) => item.status === "completed")
  ).length;
  const selectedDownloadedCount = [...selected].filter((id) =>
    allRows.find((row) => row.id === id)?.downloaded
  ).length;
  const selectedCleanupCount = [...selected].filter((id) => {
    const row = allRows.find((item) => item.id === id);
    return row
      ? transcriptionVariants(row).some((item) => item.status === "completed" && item.text.trim())
      : false;
  }).length;
  const authModeLabel =
    connection.connection?.authMode === "oauth" ? "Official OAuth" : "Web token";
  const deviceLabel =
    connection.connection?.authMode === "oauth"
      ? "Developer API"
      : connection.connection?.devices?.map((device) => device.name || device.sn).join(", ") ||
        "No device";
  const selectedPreset = sttSettings?.presets.find((preset) => preset.id === sttSettings.model);
  const selectedPostprocessPreset = sttSettings?.postprocessPresets.find(
    (preset) => preset.id === sttSettings.postprocessModel
  );
  const selectedProvider = providerForModel(sttSettings?.model);
  const overviewTiles = [
    {
      label: "Recordings",
      value: allRows.length.toLocaleString(),
      detail: `${recordings.total.toLocaleString()} remote`
    },
    {
      label: "Local audio",
      value: downloadedCount.toLocaleString(),
      detail: formatBytes(localAudioBytes)
    },
    {
      label: "Transcript results",
      value: completedTranscriptionResults.toLocaleString(),
      detail: `${transcribedCount.toLocaleString()} recordings`
    }
  ];
  const sttKeyReady =
    selectedProvider === "deepgram"
      ? Boolean(sttSettings?.hasDeepgramApiKey)
      : selectedProvider === "soniox"
        ? Boolean(sttSettings?.hasSonioxApiKey)
        : Boolean(sttSettings?.hasApiKey);
  const postprocessKeyReady =
    !sttSettings?.postprocessEnabled || Boolean(sttSettings?.hasApiKey);
  const transcriptionPipelineReady = sttKeyReady && postprocessKeyReady;

  const connectPlaud = async () => {
    const bridge = window.__riffadoConnector;
    if (!bridge) {
      setNotice({
        type: "error",
        text: "Connector not detected. Load the extension folder, then reload this page."
      });
      return;
    }

    setBusy("connect");
    setNotice(null);
    try {
      const payload = await bridge.connect();
      const response = await fetch("/api/plaud/auth/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: payload.accessToken,
          apiBase: payload.apiBase,
          source: "connector"
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Plaud connection failed"));
      setNotice({ type: "ok", text: "Plaud connected." });
      await refreshAll();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Plaud connection failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const connectManual = async () => {
    if (!manualSecret.trim()) {
      setNotice({
        type: "error",
        text: "Paste a Plaud cookie, localStorage value, Bearer header, or raw token."
      });
      return;
    }

    setBusy("manual-connect");
    setNotice(null);
    try {
      const response = await fetch("/api/plaud/auth/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cookieValue: manualSecret,
          apiBase: manualApiBase || undefined,
          source: "manual-paste"
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Plaud connection failed"));
      setManualSecret("");
      setSettingsOpen(false);
      setNotice({ type: "ok", text: "Plaud connected from pasted value." });
      await refreshAll();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Plaud connection failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const connectOAuthWeb = () => {
    setBusy("oauth-web");
    setNotice(null);
    const popup = window.open(
      "/api/plaud/auth/oauth/start",
      "plaud-oauth",
      "popup,width=560,height=760"
    );

    if (!popup) {
      window.location.assign("/api/plaud/auth/oauth/start");
      return;
    }
    popup.focus();

    const id = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(id);
      setBusy((current) => (current === "oauth-web" ? null : current));
    }, 500);
  };

  const sync = async (ids?: string[]) => {
    setBusy(ids?.length === 1 ? `sync:${ids[0]}` : "sync");
    setSyncProgress(optimisticSyncProgress(ids, recordings.total || allRows.length));
    setNotice(null);
    try {
      const response = await fetch("/api/plaud/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids ? { fileIds: ids } : {})
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Sync failed"));
      if (body.syncProgress) setSyncProgress(body.syncProgress as SyncProgressState);
      setNotice({
        type: body.errors?.length ? "error" : "ok",
        text: `Synced ${body.newRecordings + body.updatedRecordings} recording(s), skipped ${body.skippedRecordings}.`
      });
      setSelected(new Set());
      await refreshAll();
    } catch (error) {
      void loadSyncProgress();
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Sync failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setNotice(null);
    try {
      await fetch("/api/plaud/connection", { method: "DELETE" });
      setConnection({ connected: false });
      setRecordings({ connected: false, total: 0, recordings: [], localOnly: [] });
      setSelected(new Set());
      setDetailRecordingId(null);
      setNotice({ type: "ok", text: "Plaud disconnected. Local audio files remain on disk." });
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy("logout");
    setNotice(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/");
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const syncSelected = () => {
    if (selected.size > 0) void sync([...selected]);
  };

  const saveSttSettings = async () => {
    if (!sttSettings) return;
    setBusy("save-stt");
    setNotice(null);
    try {
      const response = await fetch("/api/settings/stt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKeyInput.trim() || undefined,
          deepgramApiKey: deepgramApiKeyInput.trim() || undefined,
          sonioxApiKey: sonioxApiKeyInput.trim() || undefined,
          model: sttSettings.model,
          fallbackModel: sttSettings.fallbackModel,
          postprocessEnabled: sttSettings.postprocessEnabled,
          postprocessModel: sttSettings.postprocessModel,
          language: sttSettings.language,
          chunkSeconds: sttSettings.chunkSeconds,
          overlapSeconds: sttSettings.overlapSeconds,
          temperature: sttSettings.temperature,
          concurrency: sttSettings.concurrency
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Failed to save STT settings"));
      setSttSettings(body.settings as SttSettings);
      setApiKeyInput("");
      setDeepgramApiKeyInput("");
      setSonioxApiKeyInput("");
      setProviderUsage(null);
      setSettingsOpen(false);
      setNotice({ type: "ok", text: "STT settings saved." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save STT settings"
      });
    } finally {
      setBusy(null);
    }
  };

  const saveAutomationSettings = async () => {
    if (!automationSettings) return;
    setAutomationSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/automation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoSyncEnabled: automationSettings.autoSyncEnabled,
          autoTranscribeEnabled: automationSettings.autoTranscribeEnabled,
          intervalMinutes: automationSettings.intervalMinutes,
          transcribeBatchSize: automationSettings.transcribeBatchSize
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Failed to save automation settings"));
      setAutomationSettings(body.settings as AutomationSettings);
      setNotice({ type: "ok", text: "Automation settings saved." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save automation settings"
      });
    } finally {
      setAutomationSaving(false);
    }
  };

  const saveOpenClawSettings = async () => {
    if (!openClawSettings) return;
    setOpenClawSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/openclaw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: openClawSettings.enabled,
          webhookUrl: openClawSettings.webhookUrl,
          webhookToken: openClawWebhookTokenInput.trim() || undefined,
          agentName: openClawSettings.agentName,
          model: openClawSettings.model,
          thinking: openClawSettings.thinking,
          deliver: openClawSettings.deliver,
          promptTemplate: openClawSettings.promptTemplate
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Failed to save OpenClaw settings"));
      setOpenClawSettings(body.settings as OpenClawSettings);
      setOpenClawWebhookTokenInput("");
      setNotice({ type: "ok", text: "OpenClaw settings saved." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save OpenClaw settings"
      });
    } finally {
      setOpenClawSaving(false);
    }
  };

  const runAutomationNow = async () => {
    setAutomationRunning(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/automation", {
        method: "POST"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Automation run failed"));
      setAutomationSettings(body.settings as AutomationSettings);
      await loadRecordings();
      setNotice({ type: "ok", text: body.settings?.lastRunMessage || "Automation run completed." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Automation run failed"
      });
      await loadAutomationSettings().catch(() => undefined);
    } finally {
      setAutomationRunning(false);
    }
  };

  const transcribe = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(ids.length === 1 ? `transcribe:${ids[0]}` : "transcribe");
    setNotice(null);
    try {
      const endpoint =
        ids.length === 1
          ? `/api/transcriptions/${encodeURIComponent(ids[0])}/run`
          : "/api/transcriptions/run";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ids.length === 1 ? "{}" : JSON.stringify({ recordingIds: ids })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Transcription failed"));
      const results = (
        Array.isArray(body.results) ? body.results : body.result ? [body.result] : []
      ) as TranscriptionRunResult[];
      const failed = results.filter((result) => result.status === "failed");
      if (failed.length > 0) {
        setNotice({
          type: "error",
          text: `${failed.length} transcription(s) failed: ${
            failed[0]?.error || "OpenRouter request failed"
          }`
        });
      } else {
        setNotice({ type: "ok", text: `Transcribed ${ids.length} recording(s).` });
      }
      setSelected(new Set());
      await refreshAll();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Transcription failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const transcribeSelected = () => {
    const ids = [...selected].filter((id) => allRows.find((row) => row.id === id)?.downloaded);
    if (ids.length === 0) {
      setNotice({
        type: "error",
        text: "Select at least one downloaded recording to transcribe."
      });
      return;
    }
    void transcribe(ids);
  };

  const cleanupTranscript = async (recordingId: string, model?: string) => {
    if (!sttSettings?.hasApiKey) {
      setNotice({
        type: "error",
        text: "Set an OpenRouter API key before cleaning transcripts."
      });
      return;
    }

    setBusy(model ? cleanupBusyKey(recordingId, model) : `cleanup:${recordingId}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/transcriptions/${encodeURIComponent(recordingId)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: model ? JSON.stringify({ model }) : "{}"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Transcript cleanup failed"));
      setNotice({ type: "ok", text: "Transcript cleaned." });
      await refreshAll();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Transcript cleanup failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const retryOpenClaw = async (recordingId: string, model: string) => {
    setBusy(openClawBusyKey(recordingId, model));
    setNotice(null);
    try {
      const response = await fetch(`/api/transcriptions/${encodeURIComponent(recordingId)}/openclaw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "OpenClaw retry failed"));
      const updated =
        (body.transcriptions?.[model] as TranscriptionState | undefined) ??
        (body.transcription as TranscriptionState | undefined);
      const delivery = updated?.openClaw;
      setNotice({
        type: delivery?.status === "sent" ? "ok" : "error",
        text:
          delivery?.status === "sent"
            ? "OpenClaw sent."
            : delivery?.error || "OpenClaw retry finished without a sent status."
      });
      await loadRecordings();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "OpenClaw retry failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const cleanupSelected = async () => {
    if (!sttSettings?.hasApiKey) {
      setNotice({
        type: "error",
        text: "Set an OpenRouter API key before cleaning transcripts."
      });
      return;
    }

    const ids = [...selected].filter((id) => {
      const row = allRows.find((item) => item.id === id);
      return row
        ? transcriptionVariants(row).some((item) => item.status === "completed" && item.text.trim())
        : false;
    });

    if (ids.length === 0) {
      setNotice({
        type: "error",
        text: "Select at least one recording with a completed transcript."
      });
      return;
    }

    setBusy("cleanup");
    setNotice(null);
    try {
      const response = await fetch("/api/transcriptions/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingIds: ids })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Transcript cleanup failed"));
      setSelected(new Set());
      setNotice({ type: "ok", text: `Cleaned ${ids.length} transcript(s).` });
      await refreshAll();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Transcript cleanup failed"
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleTranscript = (id: string) => {
    setExpandedTranscripts((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setTranscriptView = (id: string, view: "cleaned" | "raw") => {
    setRawTranscriptViews((current) => {
      const next = new Set(current);
      if (view === "raw") next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const copyTranscript = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setNotice({ type: "ok", text: "Transcript copied." });
  };

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Waves size={25} strokeWidth={2.2} />
          </div>
          <div>
            <p className="eyebrow">Plaude STT</p>
            <h1>Plaud STT console</h1>
          </div>
        </div>
        <div className="top-actions">
          <span className="session-chip">{sessionUser}</span>
          <button className="icon-button" type="button" onClick={refreshAll} disabled={busy !== null}>
            {busy === "refresh" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>Refresh</span>
          </button>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
            <span>Settings</span>
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={connectPlaud}
            disabled={busy !== null}
          >
            {busy === "connect" ? <Loader2 className="spin" size={18} /> : <PlugZap size={18} />}
            <span>{connection.connected ? "Reconnect" : "Connect Plaud"}</span>
          </button>
          <button className="icon-button" type="button" onClick={logout} disabled={busy !== null}>
            {busy === "logout" ? <Loader2 className="spin" size={18} /> : <LogOut size={18} />}
            <span>Log out</span>
          </button>
        </div>
      </section>

      <section className="status-deck" aria-label="Plaud status summary">
        <div className="signal-card">
          <div className="signal-copy">
            <span className={`status-dot ${connection.connected ? "on" : ""}`} />
            <div>
              <p className="panel-label">Live Dock</p>
              <strong>{connection.connected ? "Plaud linked" : "Waiting for Plaud"}</strong>
              <small className="signal-meta">
                Last sync {formatDate(connection.connection?.lastSync)} · {deviceLabel}
              </small>
            </div>
          </div>
          <div className="signal-bars" aria-hidden="true">
            {Array.from({ length: 28 }, (_, index) => (
              <span key={index} style={{ height: `${22 + ((index * 19) % 58)}%` }} />
            ))}
          </div>
        </div>
        {overviewTiles.map((tile) => (
          <MetricTile key={tile.label} label={tile.label} value={tile.value} detail={tile.detail} />
        ))}
      </section>

      {notice && (
        <div className={`notice ${notice.type}`}>
          {notice.type === "ok" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{notice.text}</span>
        </div>
      )}

      {settingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
            <header className="modal-header">
              <div>
                <p className="panel-label">Settings</p>
                <h2>Connection and STT</h2>
              </div>
              <button
                className="icon-button square"
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </header>

            <div className="settings-modal-body">
              <section className="settings-card manual-connect">
                <div className="section-heading compact">
                  <div className="section-title">
                    <Cookie size={18} />
                    <span>Plaud cookie / token</span>
                  </div>
                </div>
                <p className="section-copy">Paste a Plaud web session value when the connector is unavailable.</p>
                <textarea
                  value={manualSecret}
                  onChange={(event) => setManualSecret(event.target.value)}
                  placeholder='Paste pld_tokenstr, "bearer eyJ...", Authorization header, cookie header, or raw JWT'
                  spellCheck={false}
                />
                <select
                  value={manualApiBase}
                  onChange={(event) => setManualApiBase(event.target.value)}
                  aria-label="Plaud API region"
                >
                  <option value="">Auto region</option>
                  <option value="https://api.plaud.ai">Global</option>
                  <option value="https://api-euc1.plaud.ai">EU</option>
                  <option value="https://api-apse1.plaud.ai">APAC</option>
                  <option value="https://api-apne1.plaud.ai">AP Northeast</option>
                </select>
                <button
                  className="secondary-button full-width"
                  type="button"
                  onClick={connectManual}
                  disabled={busy !== null}
                >
                  {busy === "manual-connect" ? <Loader2 className="spin" size={17} /> : <Cookie size={17} />}
                  <span>Connect pasted value</span>
                </button>
              </section>

              <section className="settings-card oauth-connect">
                <div className="section-heading compact">
                  <div className="section-title">
                    <Link2 size={18} />
                    <span>Plaud web OAuth</span>
                  </div>
                </div>
                <p className="section-copy">
                  Sign in through Plaud in a browser. The app stores the refresh token encrypted and renews access server-side.
                </p>
                <button
                  className="secondary-button full-width"
                  type="button"
                  onClick={connectOAuthWeb}
                  disabled={busy !== null}
                >
                  {busy === "oauth-web" ? <Loader2 className="spin" size={17} /> : <Link2 size={17} />}
                  <span>Connect in browser</span>
                </button>
              </section>

              <UsageOverviewCard
                usage={providerUsage}
                loading={usageLoading}
                onRefresh={() => void loadProviderUsage()}
              />

              {automationSettings && (
                <AutomationSettingsCard
                  settings={automationSettings}
                  onChange={setAutomationSettings}
                  onSave={() => void saveAutomationSettings()}
                  onRunNow={() => void runAutomationNow()}
                  saving={automationSaving}
                  running={automationRunning}
                  disabled={busy !== null}
                />
              )}

              {openClawSettings && (
                <OpenClawSettingsCard
                  settings={openClawSettings}
                  webhookTokenInput={openClawWebhookTokenInput}
                  onWebhookTokenInputChange={setOpenClawWebhookTokenInput}
                  onChange={setOpenClawSettings}
                  onSave={() => void saveOpenClawSettings()}
                  saving={openClawSaving}
                  disabled={busy !== null}
                />
              )}

              {sttSettings && (
                <section className="settings-card stt-settings">
                  <div className="section-heading compact">
                    <div className="section-title">
                      <KeyRound size={18} />
                      <span>STT providers</span>
                    </div>
                    <div className="key-stack">
                      <span className={`key-status ${sttSettings.hasApiKey ? "ready" : ""}`}>
                        OpenRouter {sttSettings.hasApiKey ? "saved" : "empty"}
                      </span>
                      <span className={`key-status ${sttSettings.hasDeepgramApiKey ? "ready" : ""}`}>
                        Deepgram {sttSettings.hasDeepgramApiKey ? "saved" : "empty"}
                      </span>
                      <span className={`key-status ${sttSettings.hasSonioxApiKey ? "ready" : ""}`}>
                        Soniox {sttSettings.hasSonioxApiKey ? "saved" : "empty"}
                      </span>
                    </div>
                  </div>
                  <input
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    type="password"
                    placeholder={sttSettings.hasApiKey ? "API key saved" : "OpenRouter API key"}
                    aria-label="OpenRouter API key"
                    spellCheck={false}
                  />
                  <input
                    value={deepgramApiKeyInput}
                    onChange={(event) => setDeepgramApiKeyInput(event.target.value)}
                    type="password"
                    placeholder={sttSettings.hasDeepgramApiKey ? "Deepgram key saved" : "Deepgram API key"}
                    aria-label="Deepgram API key"
                    spellCheck={false}
                  />
                  <input
                    value={sonioxApiKeyInput}
                    onChange={(event) => setSonioxApiKeyInput(event.target.value)}
                    type="password"
                    placeholder={sttSettings.hasSonioxApiKey ? "Soniox key saved" : "Soniox API key"}
                    aria-label="Soniox API key"
                    spellCheck={false}
                  />
                  <select
                    value={sttSettings.model}
                    onChange={(event) =>
                      setSttSettings({ ...sttSettings, model: event.target.value })
                    }
                    aria-label="STT model"
                  >
                    {sttSettings.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  {selectedPreset?.description && (
                    <p className="preset-description">{selectedPreset.description}</p>
                  )}
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={sttSettings.postprocessEnabled}
                      onChange={(event) =>
                        setSttSettings({
                          ...sttSettings,
                          postprocessEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>LLM cleanup</strong>
                      <small>Clean STT text after transcription with OpenRouter.</small>
                    </span>
                  </label>
                  <select
                    value={sttSettings.postprocessModel}
                    onChange={(event) =>
                      setSttSettings({ ...sttSettings, postprocessModel: event.target.value })
                    }
                    aria-label="Transcript cleanup model"
                    disabled={!sttSettings.postprocessEnabled}
                  >
                    {sttSettings.postprocessPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  {sttSettings.postprocessEnabled && selectedPostprocessPreset?.description && (
                    <p className="preset-description">{selectedPostprocessPreset.description}</p>
                  )}
                  <div className="settings-grid">
                    <label>
                      <span>Chunk seconds</span>
                      <input
                        type="number"
                        min={60}
                        max={300}
                        value={sttSettings.chunkSeconds}
                        onChange={(event) =>
                          setSttSettings({
                            ...sttSettings,
                            chunkSeconds: Number(event.target.value)
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Overlap</span>
                      <input
                        type="number"
                        min={0}
                        max={30}
                        value={sttSettings.overlapSeconds}
                        onChange={(event) =>
                          setSttSettings({
                            ...sttSettings,
                            overlapSeconds: Number(event.target.value)
                          })
                        }
                      />
                    </label>
                  </div>
                  <button
                    className="secondary-button full-width"
                    type="button"
                    onClick={saveSttSettings}
                    disabled={busy !== null}
                  >
                    {busy === "save-stt" ? <Loader2 className="spin" size={17} /> : <KeyRound size={17} />}
                    <span>Save STT settings</span>
                  </button>
                </section>
              )}
            </div>
          </section>
        </div>
      )}

      <section className="console-grid">
        <aside className="side-panel">
          <section className="panel-section">
            <div className="section-heading">
              <div>
                <p className="panel-label">Connection</p>
                <h2>{connection.connected ? "Connected" : "Connect Plaud"}</h2>
              </div>
              <span className={`connection-badge ${connection.connected ? "on" : ""}`}>
                {connection.connected ? "Online" : "Offline"}
              </span>
            </div>
            <p className="muted">
              {connection.connection?.plaudEmail ||
                connection.connection?.apiBase ||
                "Paste a Plaud cookie/token or use the browser connector."}
            </p>
            <div className="connection-details">
              <div>
                <span>Mode</span>
                <strong>{connection.connected ? authModeLabel : "Not connected"}</strong>
              </div>
              <div>
                <span>Device</span>
                <strong>{deviceLabel}</strong>
              </div>
              <div>
                <span>API</span>
                <strong>{connection.connection?.apiBase || "Auto region"}</strong>
              </div>
              <div>
                <span>Token</span>
                <strong>{formatRelativeExpiry(connection.connection?.accessTokenExpiresAt)}</strong>
              </div>
            </div>
            {sttSettings && (
              <div className="pipeline-strip">
                <div>
                  <span>STT: </span>
                  <strong>{selectedPreset?.label ?? sttSettings.model}</strong>
                </div>
                <div>
                  <span>Cleanup: </span>
                  <strong>
                    {sttSettings.postprocessEnabled
                      ? selectedPostprocessPreset?.label ?? sttSettings.postprocessModel
                      : "Off"}
                  </strong>
                </div>
              </div>
            )}
            {connection.connected && (
              <button className="danger-button" type="button" onClick={disconnect} disabled={busy !== null}>
                <Trash2 size={16} />
                <span>Disconnect</span>
              </button>
            )}
          </section>

        </aside>

        <section className={`work-panel ${detailRecording ? "detail-mode" : ""}`}>
          {detailRecording ? (
            <>
              <div className="work-header detail-header">
                <button
                  className="secondary-button back-button"
                  type="button"
                  onClick={() => setDetailRecordingId(null)}
                >
                  <ArrowLeft size={17} />
                  <span>Back</span>
                </button>
                <div className="work-heading">
                  <p className="panel-label">Recording detail</p>
                  <div className="work-titleline">
                    <h2>{detailRecording.filename}</h2>
                    <RecordingBadges
                      downloaded={detailRecording.downloaded}
                      transcription={detailVariants[0]}
                      progress={detailProgress}
                      syncProgress={
                        syncProgress?.currentRecordingId === detailRecording.id ? syncProgress : null
                      }
                      variantCount={detailVariants.length}
                    />
                  </div>
                  <p className="work-subtitle">Review audio and every transcript variant for this recording.</p>
                </div>
                <div className="work-actions detail-actions">
                  {detailRecording.audioUrl && (
                    <a
                      className="secondary-button"
                      href={`${detailRecording.audioUrl}?download=1`}
                      aria-label={`Download ${detailRecording.filename}`}
                    >
                      <Download size={17} />
                      <span>Download</span>
                    </a>
                  )}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void sync([detailRecording.id])}
                    disabled={busy !== null || !connection.connected}
                  >
                    {busy === `sync:${detailRecording.id}` ? (
                      <Loader2 className="spin" size={17} />
                    ) : detailRecording.downloaded ? (
                      <RefreshCw size={17} />
                    ) : (
                      <Download size={17} />
                    )}
                    <span>Sync</span>
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      detailCleanupTarget
                        ? void cleanupTranscript(detailRecording.id, detailCleanupTarget.model)
                        : undefined
                    }
                    disabled={!detailCleanupTarget || !sttSettings?.hasApiKey || busy !== null}
                  >
                    {detailCleanupTarget &&
                    busy === cleanupBusyKey(detailRecording.id, detailCleanupTarget.model) ? (
                      <Loader2 className="spin" size={17} />
                    ) : (
                      <Sparkles size={17} />
                    )}
                    <span>Clean</span>
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void transcribe([detailRecording.id])}
                    disabled={busy !== null || !detailRecording.downloaded || !transcriptionPipelineReady}
                  >
                    {busy === `transcribe:${detailRecording.id}` ? (
                      <Loader2 className="spin" size={18} />
                    ) : (
                      <FileText size={18} />
                    )}
                    <span>Transcribe</span>
                  </button>
                </div>
              </div>

              {visibleSyncProgress && <SyncDownloadPanel progress={visibleSyncProgress} />}

              <div className="detail-body">
                <section className="detail-summary">
                  <div className="detail-meta-grid">
                    <div>
                      <span>Recorded</span>
                      <strong>{formatDate(detailRecording.startTime)}</strong>
                    </div>
                    <div>
                      <span>Duration</span>
                      <strong>{formatDuration(detailRecording.duration)}</strong>
                    </div>
                    <div>
                      <span>Size</span>
                      <strong>{formatBytes(detailRecording.filesize)}</strong>
                    </div>
                    <div>
                      <span>Serial</span>
                      <strong>{detailRecording.serialNumber}</strong>
                    </div>
                  </div>
                  {detailRecording.audioUrl ? (
                    <audio
                      className="player detail-player"
                      src={detailRecording.audioUrl}
                      controls
                      preload="none"
                    />
                  ) : (
                    <div className="audio-placeholder">Sync this recording to play local audio.</div>
                  )}
                  {detailProgress && <ProgressMeter progress={detailProgress} />}
                </section>

                {detailVariants.length > 0 ? (
                  <TranscriptStack
                    recordingId={detailRecording.id}
                    variants={detailVariants}
                    sttSettings={sttSettings}
                    expandedTranscripts={expandedTranscripts}
                    rawTranscriptViews={rawTranscriptViews}
                    toggleTranscript={toggleTranscript}
                    setTranscriptView={setTranscriptView}
                    copyTranscript={copyTranscript}
                    cleanupTranscript={(recordingId, model) => void cleanupTranscript(recordingId, model)}
                    retryOpenClaw={(recordingId, model) => void retryOpenClaw(recordingId, model)}
                    busy={busy}
                  />
                ) : (
                  <div className="empty-state compact">
                    <FileText size={22} />
                    <p>No transcription result for this recording yet.</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="work-header">
                <div className="work-heading">
                  <p className="panel-label">Recordings</p>
                  <div className="work-titleline">
                    <h2>{allRows.length ? `${allRows.length} visible` : "No recordings loaded"}</h2>
                    {selectedCount > 0 && (
                      <span className="selection-badge">{selectedCount} selected</span>
                    )}
                  </div>
                  <p className="work-subtitle">
                    Newest first by recording time. {downloadedCount} local,{" "}
                    {completedTranscriptionResults} transcript results
                  </p>
                </div>
                <div className="work-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={syncSelected}
                    disabled={!connection.connected || selectedCount === 0 || busy !== null}
                  >
                    <Download size={17} />
                    <span>Sync selected</span>
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={transcribeSelected}
                    disabled={!transcriptionPipelineReady || selectedCount === 0 || busy !== null}
                  >
                    <FileText size={17} />
                    <span>
                      Transcribe {selectedDownloadedCount ? `(${selectedDownloadedCount})` : "selected"}
                    </span>
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void cleanupSelected()}
                    disabled={!sttSettings?.hasApiKey || selectedCleanupCount === 0 || busy !== null}
                  >
                    {busy === "cleanup" ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
                    <span>Clean {selectedCleanupCount ? `(${selectedCleanupCount})` : "selected"}</span>
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void sync()}
                    disabled={!connection.connected || busy !== null}
                  >
                    {busy === "sync" ? <Loader2 className="spin" size={18} /> : <HardDrive size={18} />}
                    <span>Sync all</span>
                  </button>
                </div>
              </div>

              {visibleSyncProgress && <SyncDownloadPanel progress={visibleSyncProgress} />}

              <div className="recording-list">
                {allRows.length === 0 ? (
                  <div className="empty-state">
                    <Link2 size={22} />
                    <p>
                      {connection.connected
                        ? "Refresh or sync to pull recordings."
                        : "Connect Plaud to load recordings."}
                    </p>
                  </div>
                ) : (
                  allRows.map((recording) => {
                    const variants = transcriptionVariants(recording);
                    const latestTranscript = variants[0];
                    const progressState = activeProgress(latestTranscript);
                    const rowSyncProgress =
                      syncProgress?.currentRecordingId === recording.id ? syncProgress : null;

                    return (
                      <article
                        className="recording-row is-clickable"
                        key={recording.id}
                        onClick={() => setDetailRecordingId(recording.id)}
                      >
                        <label
                          className="select-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(recording.id)}
                            onChange={() => toggleSelected(recording.id)}
                          />
                        </label>
                        <div className="recording-main">
                          <div className="recording-titleline">
                            <h3>{recording.filename}</h3>
                            <RecordingBadges
                              downloaded={recording.downloaded}
                              transcription={latestTranscript}
                              progress={progressState}
                              syncProgress={rowSyncProgress}
                              variantCount={variants.length}
                            />
                          </div>
                          <div className="recording-meta">
                            <span>{formatDate(recording.startTime)}</span>
                            <span>{formatDuration(recording.duration)}</span>
                            <span>{formatBytes(recording.filesize)}</span>
                            <span>{recording.serialNumber}</span>
                          </div>
                          {latestTranscript && (
                            <div className="recording-summary">
                              <FileText size={14} />
                              <span>
                                {modelLabelFor(latestTranscript.model, sttSettings?.presets)} ·{" "}
                                {transcriptionText(latestTranscript).length.toLocaleString()} chars
                              </span>
                            </div>
                          )}
                          {progressState && <ProgressMeter progress={progressState} compact />}
                        </div>
                        <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                          {recording.audioUrl && (
                            <a
                              className="icon-link"
                              href={`${recording.audioUrl}?download=1`}
                              aria-label={`Download ${recording.filename}`}
                            >
                              <Download size={18} />
                            </a>
                          )}
                          <button
                            className="icon-button square"
                            type="button"
                            onClick={() => void sync([recording.id])}
                            disabled={busy !== null || !connection.connected}
                            aria-label={`Sync ${recording.filename}`}
                          >
                            {busy === `sync:${recording.id}` ? (
                              <Loader2 className="spin" size={18} />
                            ) : recording.downloaded ? (
                              <RefreshCw size={18} />
                            ) : (
                              <Download size={18} />
                            )}
                          </button>
                          <button
                            className="icon-button square"
                            type="button"
                            onClick={() => void transcribe([recording.id])}
                            disabled={busy !== null || !recording.downloaded || !transcriptionPipelineReady}
                            aria-label={`Transcribe ${recording.filename}`}
                          >
                            {busy === `transcribe:${recording.id}` ? (
                              <Loader2 className="spin" size={18} />
                            ) : (
                              <FileText size={18} />
                            )}
                          </button>
                          <button
                            className="icon-button square open-detail-button"
                            type="button"
                            onClick={() => setDetailRecordingId(recording.id)}
                            aria-label={`Open details for ${recording.filename}`}
                          >
                            <ChevronRight size={18} />
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
