import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TranscriptionUsage } from "@/lib/db";

const SONIOX_API_BASE_URL = "https://api.soniox.com";
const SONIOX_MODEL_PREFIX = "soniox/";
const SONIOX_ASYNC_USD_PER_HOUR = 0.1;

export interface SonioxTranscriptionResult {
  text: string;
  model: string;
  usage?: TranscriptionUsage;
  warning?: string;
}

interface SonioxToken {
  text?: unknown;
  speaker?: unknown;
  language?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  translation_status?: unknown;
  is_audio_event?: unknown;
}

interface SonioxTranscriptResponse {
  text?: unknown;
  tokens?: SonioxToken[];
}

interface SonioxStatusResponse {
  status?: unknown;
  error_message?: unknown;
}

interface SonioxApiResponse {
  id?: unknown;
  status?: unknown;
  error_message?: unknown;
  message?: unknown;
  error?: unknown;
  raw?: unknown;
}

class SonioxHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SonioxHttpError";
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sonioxModelName(model: string): string {
  return model.startsWith(SONIOX_MODEL_PREFIX) ? model.slice(SONIOX_MODEL_PREFIX.length) : model;
}

function reportedModel(model: string): string {
  return model.startsWith(SONIOX_MODEL_PREFIX) ? model : `${SONIOX_MODEL_PREFIX}${model}`;
}

function contentTypeForAudioPath(audioPath: string): string {
  switch (extname(audioPath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

async function parseJsonResponse(response: Response): Promise<SonioxApiResponse | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as SonioxApiResponse;
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

function sonioxErrorMessage(body: SonioxApiResponse | null, response: Response): string {
  if (typeof body?.error_message === "string") return body.error_message;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.raw === "string") return body.raw;
  return `Soniox returned HTTP ${response.status} ${response.statusText || "error"}.`;
}

async function sonioxFetch<T>(
  apiKey: string,
  endpoint: string,
  { method = "GET", body, headers = {} }: { method?: string; body?: BodyInit; headers?: HeadersInit } = {}
): Promise<T | null> {
  const response = await fetch(`${SONIOX_API_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...headers
    },
    body
  });
  const bodyJson = await parseJsonResponse(response);
  if (!response.ok) {
    throw new SonioxHttpError(response.status, sonioxErrorMessage(bodyJson, response));
  }
  return bodyJson as T | null;
}

async function uploadAudio(apiKey: string, audioPath: string): Promise<string> {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: contentTypeForAudioPath(audioPath) }),
    basename(audioPath)
  );
  const body = await sonioxFetch<SonioxApiResponse>(apiKey, "/v1/files", {
    method: "POST",
    body: form
  });
  if (typeof body?.id !== "string") {
    throw new Error("Soniox upload response did not include file id.");
  }
  return body.id;
}

async function createTranscription({
  apiKey,
  fileId,
  model,
  language
}: {
  apiKey: string;
  fileId: string;
  model: string;
  language: string;
}): Promise<string> {
  const body = await sonioxFetch<SonioxApiResponse>(apiKey, "/v1/transcriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: sonioxModelName(model),
      file_id: fileId,
      language_hints: language ? [language] : undefined,
      language_hints_strict: Boolean(language),
      enable_language_identification: true,
      enable_speaker_diarization: true
    })
  });
  if (typeof body?.id !== "string") {
    throw new Error("Soniox transcription response did not include transcription id.");
  }
  return body.id;
}

async function waitForTranscription(apiKey: string, transcriptionId: string): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 120 * 60 * 1000;

  while (true) {
    const status = await sonioxFetch<SonioxStatusResponse>(
      apiKey,
      `/v1/transcriptions/${transcriptionId}`
    );
    if (status?.status === "completed") return;
    if (status?.status === "error") {
      throw new Error(
        typeof status.error_message === "string" ? status.error_message : "Soniox transcription failed."
      );
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Soniox transcription.");
    }
    await delay(2000);
  }
}

async function getTranscript(
  apiKey: string,
  transcriptionId: string
): Promise<SonioxTranscriptResponse> {
  const transcript = await sonioxFetch<SonioxTranscriptResponse>(
    apiKey,
    `/v1/transcriptions/${transcriptionId}/transcript`
  );
  return transcript ?? {};
}

async function deleteTranscription(apiKey: string, transcriptionId: string): Promise<void> {
  await sonioxFetch(apiKey, `/v1/transcriptions/${transcriptionId}`, { method: "DELETE" });
}

async function deleteFile(apiKey: string, fileId: string): Promise<void> {
  await sonioxFetch(apiKey, `/v1/files/${fileId}`, { method: "DELETE" });
}

function secondsFromMilliseconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function isOriginalSpeechToken(token: SonioxToken): boolean {
  if (typeof token.text !== "string" || !token.text) return false;
  if (token.is_audio_event) return false;
  return token.translation_status !== "translation";
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const rounded = Math.max(0, Math.floor(seconds));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function speakerLabel(speaker: unknown): string {
  if (speaker === null || speaker === undefined || speaker === "") return "Speaker ?";
  return `Speaker ${String(speaker)}`;
}

function languageLabel(language: unknown): string {
  return typeof language === "string" && language ? ` [${language}]` : "";
}

function formatSpeakerTranscript(tokens: SonioxToken[] | undefined): string {
  const segments: {
    speaker: unknown;
    language: unknown;
    startSeconds: number | null;
    endSeconds: number | null;
    text: string;
  }[] = [];
  let current: (typeof segments)[number] | null = null;

  for (const token of tokens ?? []) {
    if (!isOriginalSpeechToken(token)) continue;
    const startSeconds = secondsFromMilliseconds(token.start_ms);
    const endSeconds = secondsFromMilliseconds(token.end_ms);
    const gap =
      current?.endSeconds !== null && current?.endSeconds !== undefined && startSeconds !== null
        ? startSeconds - current.endSeconds
        : 0;

    if (
      !current ||
      current.speaker !== token.speaker ||
      current.language !== token.language ||
      gap > 1.5
    ) {
      current = {
        speaker: token.speaker,
        language: token.language,
        startSeconds,
        endSeconds,
        text: token.text as string
      };
      segments.push(current);
      continue;
    }

    current.endSeconds = endSeconds ?? current.endSeconds;
    current.text += token.text as string;
  }

  return segments
    .filter((segment) => segment.text.trim())
    .map(
      (segment) =>
        `[${formatTime(segment.startSeconds)}-${formatTime(segment.endSeconds)}] ${speakerLabel(
          segment.speaker
        )}${languageLabel(segment.language)}: ${segment.text.trim()}`
    )
    .join("\n");
}

function plainTranscript(transcript: SonioxTranscriptResponse): string {
  if (typeof transcript.text === "string" && transcript.text.trim()) {
    return transcript.text.trim();
  }
  return (transcript.tokens ?? [])
    .filter(isOriginalSpeechToken)
    .map((token) => token.text as string)
    .join("")
    .trim();
}

function estimatedCost(durationSeconds: number | undefined): number | undefined {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
  return Math.round((durationSeconds / 3600) * SONIOX_ASYNC_USD_PER_HOUR * 10000) / 10000;
}

export async function transcribeFileWithSoniox({
  apiKey,
  audioPath,
  model,
  language,
  durationSeconds
}: {
  apiKey: string;
  audioPath: string;
  model: string;
  language: string;
  durationSeconds?: number;
}): Promise<SonioxTranscriptionResult> {
  let fileId: string | null = null;
  let transcriptionId: string | null = null;
  let transcript: SonioxTranscriptResponse = {};
  const cleanupWarnings: string[] = [];

  try {
    fileId = await uploadAudio(apiKey, audioPath);
    transcriptionId = await createTranscription({
      apiKey,
      fileId,
      model,
      language
    });
    await waitForTranscription(apiKey, transcriptionId);
    transcript = await getTranscript(apiKey, transcriptionId);
  } finally {
    if (transcriptionId) {
      try {
        await deleteTranscription(apiKey, transcriptionId);
      } catch {
        cleanupWarnings.push("Soniox transcription cleanup failed.");
      }
    }
    if (fileId) {
      try {
        await deleteFile(apiKey, fileId);
      } catch {
        cleanupWarnings.push("Soniox uploaded file cleanup failed.");
      }
    }
  }

  const speakerTranscript = formatSpeakerTranscript(transcript.tokens);
  const fallbackText = plainTranscript(transcript);

  return {
    text: speakerTranscript || fallbackText,
    model: reportedModel(sonioxModelName(model)),
    usage: {
      ...(durationSeconds ? { seconds: durationSeconds } : {}),
      ...(durationSeconds ? { cost: estimatedCost(durationSeconds) } : {})
    },
    warning: cleanupWarnings.join(" ") || undefined
  };
}
