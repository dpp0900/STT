import { readFile } from "node:fs/promises";
import type { TranscriptionUsage } from "@/lib/db";
import { AppError, ErrorCode } from "@/lib/errors";

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const RETRYABLE_DEEPGRAM_STATUS = new Set([429, 500, 502, 503, 504]);

export interface DeepgramTranscriptionResult {
  text: string;
  model: string;
  usage?: TranscriptionUsage;
  warning?: string;
}

interface DeepgramAlternative {
  transcript?: unknown;
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}

interface DeepgramResponse {
  metadata?: {
    duration?: unknown;
    model_info?: Record<string, { name?: unknown } | undefined>;
    models?: unknown;
  };
  results?: {
    channels?: DeepgramChannel[];
  };
  err_msg?: unknown;
  message?: unknown;
  error?: unknown;
}

class DeepgramHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DeepgramHttpError";
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepgramModelName(model: string): string {
  return model.startsWith("deepgram/") ? model.slice("deepgram/".length) : model;
}

function contentTypeForAudioFormat(audioFormat: string): string {
  switch (audioFormat.toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

function reportedModel(model: string, body: DeepgramResponse): string {
  const modelInfo = body.metadata?.model_info;
  if (modelInfo) {
    const first = Object.values(modelInfo).find(Boolean);
    if (typeof first?.name === "string" && first.name.trim()) {
      return `deepgram/${first.name.trim()}`;
    }
  }
  return model.startsWith("deepgram/") ? model : `deepgram/${model}`;
}

async function parseDeepgramError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const fallback = `Deepgram returned HTTP ${response.status} ${response.statusText || "error"}.`;
  if (!text) return fallback;

  try {
    const parsed = JSON.parse(text) as DeepgramResponse;
    if (typeof parsed.err_msg === "string") return parsed.err_msg;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    if (/^\s*</.test(text)) return fallback;
  }

  return text.slice(0, 500);
}

function extractTranscript(body: DeepgramResponse): string | null {
  const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === "string" ? transcript : null;
}

async function requestDeepgramOnce({
  apiKey,
  audioPath,
  audioFormat,
  model,
  language
}: {
  apiKey: string;
  audioPath: string;
  audioFormat: string;
  model: string;
  language: string;
}): Promise<DeepgramTranscriptionResult> {
  const deepgramModel = deepgramModelName(model);
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set("model", deepgramModel);
  url.searchParams.set("language", language);
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");

  const audio = await readFile(audioPath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": contentTypeForAudioFormat(audioFormat)
    },
    body: new Blob([audio])
  });

  if (!response.ok) {
    throw new DeepgramHttpError(
      response.status,
      await parseDeepgramError(response)
    );
  }

  const body = (await response.json()) as DeepgramResponse;
  const text = extractTranscript(body);
  if (text === null) {
    throw new AppError(
      ErrorCode.PlaudUpstreamError,
      "Deepgram returned a transcription without text.",
      502
    );
  }

  const seconds =
    typeof body.metadata?.duration === "number" ? body.metadata.duration : undefined;

  return {
    text,
    model: reportedModel(model, body),
    usage: seconds === undefined ? undefined : { seconds }
  };
}

export async function transcribeChunkWithDeepgram(
  options: Parameters<typeof requestDeepgramOnce>[0]
): Promise<DeepgramTranscriptionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestDeepgramOnce(options);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof DeepgramHttpError) ||
        !RETRYABLE_DEEPGRAM_STATUS.has(error.status) ||
        attempt === 2
      ) {
        break;
      }
      await delay(700 * 2 ** attempt);
    }
  }
  throw lastError;
}
