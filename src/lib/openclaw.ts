import { createHash } from "node:crypto";
import { decryptSecret } from "@/lib/crypto-store";
import {
  DEFAULT_OPENCLAW_PROMPT_TEMPLATE,
  readDb,
  updateDb,
  type LocalRecording,
  type OpenClawDeliveryState,
  type OpenClawSettings,
  type SttSettings,
  type TranscriptionState
} from "@/lib/db";

const OPENCLAW_REQUEST_TIMEOUT_MS = 30_000;

interface EffectiveOpenClawSettings {
  enabled: boolean;
  webhookUrl: string;
  webhookToken: string | null;
  agentName: string;
  model: string;
  thinking: string;
  deliver: boolean;
  deliveryChannel: string;
  deliveryTarget: string;
  promptTemplate: string;
}

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function envBoolean(name: string): boolean | null {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function normalizeWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/hooks/agent";
  }
  return url.toString();
}

async function effectiveSettings(
  settings: OpenClawSettings
): Promise<EffectiveOpenClawSettings> {
  const envEnabled = envBoolean("OPENCLAW_ENABLED");
  const enabled = envEnabled ?? settings.enabled;
  const envToken = envValue("OPENCLAW_HOOK_TOKEN", "OPENCLAW_WEBHOOK_TOKEN");
  const webhookToken = envToken
    ? envToken
    : settings.encryptedWebhookToken
      ? await decryptSecret(settings.encryptedWebhookToken)
      : null;
  const webhookUrl =
    envValue("OPENCLAW_WEBHOOK_URL", "OPENCLAW_HOOK_URL") || settings.webhookUrl;

  return {
    enabled,
    webhookUrl: enabled ? normalizeWebhookUrl(webhookUrl) : webhookUrl,
    webhookToken,
    agentName:
      envValue("OPENCLAW_AGENT_NAME") || settings.agentName || "Plaud transcript",
    model: envValue("OPENCLAW_MODEL") || settings.model,
    thinking: envValue("OPENCLAW_THINKING") || settings.thinking,
    deliver: envBoolean("OPENCLAW_DELIVER") ?? settings.deliver,
    deliveryChannel:
      envValue("OPENCLAW_DELIVERY_CHANNEL", "OPENCLAW_CHANNEL") ||
      settings.deliveryChannel,
    deliveryTarget:
      envValue("OPENCLAW_DELIVERY_TARGET", "OPENCLAW_TO") ||
      settings.deliveryTarget,
    promptTemplate: settings.promptTemplate || DEFAULT_OPENCLAW_PROMPT_TEMPLATE
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "unknown";
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${seconds}s`;
}

function replaceTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) =>
    values[key] ?? ""
  );
}

function finalTranscriptText(
  transcription: TranscriptionState,
  sttSettings: SttSettings
): { text: string; cleanupModel: string } | null {
  if (transcription.status !== "completed") return null;

  if (
    transcription.postprocess?.status === "completed" &&
    transcription.postprocess.text.trim()
  ) {
    return {
      text: transcription.postprocess.text.trim(),
      cleanupModel: transcription.postprocess.model
    };
  }

  if (sttSettings.postprocessEnabled) return null;
  const raw = transcription.text.trim();
  return raw ? { text: raw, cleanupModel: "none" } : null;
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

async function setDeliveryState(
  recordingId: string,
  model: string,
  delivery: OpenClawDeliveryState
): Promise<void> {
  await updateDb((db) => {
    const recording = db.recordings.find((item) => item.id === recordingId);
    if (!recording) return;
    const state = transcriptionForModel(recording, model);
    if (!state) return;
    state.openClaw = delivery;
    state.updatedAt = delivery.updatedAt;
    recording.transcriptions = {
      ...(recording.transcriptions ?? {}),
      [model]: state
    };
    recording.transcription = state;
    recording.updatedAt = delivery.updatedAt;
  });
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return `OpenClaw returned HTTP ${response.status} ${response.statusText || "error"}.`;
  }
  return text.slice(0, 500);
}

function openClawErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "OpenClaw send failed.";
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : null;
    const message =
      "message" in cause && typeof cause.message === "string" ? cause.message : null;
    if (code || message) {
      return `OpenClaw request failed${code ? ` (${code})` : ""}: ${message ?? error.message}`;
    }
  }
  return `OpenClaw request failed: ${error.message}`;
}

export function publicOpenClawSettings(settings: OpenClawSettings): Omit<
  OpenClawSettings,
  "encryptedWebhookToken"
> & {
  hasWebhookToken: boolean;
  envWebhookUrl: boolean;
  envWebhookToken: boolean;
} {
  const {
    encryptedWebhookToken: _encryptedWebhookToken,
    ...publicSettings
  } = settings;
  const envWebhookUrl = envValue("OPENCLAW_WEBHOOK_URL", "OPENCLAW_HOOK_URL");
  const envEnabled = envBoolean("OPENCLAW_ENABLED");
  return {
    ...publicSettings,
    enabled: envEnabled ?? publicSettings.enabled,
    webhookUrl: envWebhookUrl || publicSettings.webhookUrl,
    hasWebhookToken: Boolean(
      settings.encryptedWebhookToken ||
        envValue("OPENCLAW_HOOK_TOKEN", "OPENCLAW_WEBHOOK_TOKEN")
    ),
    envWebhookUrl: Boolean(envWebhookUrl),
    envWebhookToken: Boolean(
      envValue("OPENCLAW_HOOK_TOKEN", "OPENCLAW_WEBHOOK_TOKEN")
    )
  };
}

export async function notifyOpenClawForCompletedTranscription(
  recordingId: string,
  model: string
): Promise<void> {
  const db = await readDb();
  const recording = db.recordings.find((item) => item.id === recordingId);
  const transcription = recording ? transcriptionForModel(recording, model) : null;
  if (!recording || !transcription) return;

  let settings: EffectiveOpenClawSettings;
  try {
    settings = await effectiveSettings(db.openClawSettings);
  } catch (error) {
    await setDeliveryState(recordingId, model, {
      status: "failed",
      webhookUrl: null,
      idempotencyKey: null,
      transcriptHash: null,
      error:
        error instanceof Error
          ? error.message
          : "Invalid OpenClaw settings.",
      sentAt: null,
      updatedAt: new Date().toISOString()
    });
    return;
  }
  if (!settings.enabled) return;

  const ready = finalTranscriptText(transcription, db.sttSettings);
  if (!ready) return;

  const transcriptHash = sha256(ready.text);
  const idempotencyKey = `plaud:${recording.id}:${model}:${transcriptHash.slice(0, 16)}`;
  if (
    transcription.openClaw?.status === "sent" &&
    transcription.openClaw.idempotencyKey === idempotencyKey
  ) {
    return;
  }

  const now = new Date().toISOString();
  const baseDelivery = {
    webhookUrl: settings.webhookUrl,
    idempotencyKey,
    transcriptHash,
    sentAt: null
  };

  if (!settings.webhookToken) {
    await setDeliveryState(recordingId, model, {
      ...baseDelivery,
      status: "failed",
      error: "Set an OpenClaw hook token before auto-send.",
      updatedAt: now
    });
    return;
  }

  await setDeliveryState(recordingId, model, {
    ...baseDelivery,
    status: "pending",
    updatedAt: now
  });

  const message = replaceTemplate(settings.promptTemplate, {
    filename: recording.filename,
    recordingId: recording.id,
    serialNumber: recording.serialNumber,
    startTime: recording.startTime,
    duration: formatDuration(recording.duration),
    model,
    cleanupModel: ready.cleanupModel,
    transcript: ready.text
  });

  const payload: Record<string, unknown> = {
    message,
    name: settings.agentName,
    idempotencyKey,
    deliver: settings.deliver
  };
  if (settings.model) payload.model = settings.model;
  if (settings.thinking) payload.thinking = settings.thinking;
  if (settings.deliver && settings.deliveryChannel) payload.channel = settings.deliveryChannel;
  if (settings.deliver && settings.deliveryTarget) payload.to = settings.deliveryTarget;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENCLAW_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(settings.webhookUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.webhookToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    await setDeliveryState(recordingId, model, {
      ...baseDelivery,
      status: "sent",
      sentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    await setDeliveryState(recordingId, model, {
      ...baseDelivery,
      status: "failed",
      error: openClawErrorMessage(error),
      updatedAt: new Date().toISOString()
    });
  } finally {
    clearTimeout(timeout);
  }
}
