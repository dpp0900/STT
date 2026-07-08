import { readFile } from "node:fs/promises";
import type { TranscriptionUsage } from "@/lib/db";
import { AppError, ErrorCode } from "@/lib/errors";

const OPENROUTER_TRANSCRIPTIONS_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
const RETRYABLE_OPENROUTER_STATUS = new Set([500, 502, 503, 520, 524, 529]);

export interface OpenRouterTranscriptionResult {
  text: string;
  model: string;
  usage?: TranscriptionUsage;
  warning?: string;
}

interface OpenRouterResponse {
  text?: unknown;
  model?: unknown;
  usage?: TranscriptionUsage;
  error?: {
    message?: unknown;
    code?: unknown;
  };
}

class OpenRouterHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterHttpError";
    this.status = status;
  }
}

function isLanguageCompatibilityError(error: unknown): boolean {
  return error instanceof OpenRouterHttpError && error.status === 400;
}

function isAutoCompatibilityError(error: unknown): boolean {
  return (
    error instanceof OpenRouterHttpError &&
    (error.status === 400 || error.status === 404 || error.status === 422)
  );
}

function isRetryableOpenRouterError(error: unknown): boolean {
  return error instanceof OpenRouterHttpError && RETRYABLE_OPENROUTER_STATUS.has(error.status);
}

function shouldFallbackFromAuto(error: unknown): boolean {
  return isAutoCompatibilityError(error) || isRetryableOpenRouterError(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseOpenRouterError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const fallback = `OpenRouter returned HTTP ${response.status} ${response.statusText || "error"}.`;
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as OpenRouterResponse;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    if (/^\s*</.test(text)) return fallback;
  }
  return text.slice(0, 500);
}

async function requestTranscriptionOnce({
  apiKey,
  audioPath,
  audioFormat,
  model,
  language,
  temperature,
  includeLanguage
}: {
  apiKey: string;
  audioPath: string;
  audioFormat: string;
  model: string;
  language: string;
  temperature: number;
  includeLanguage: boolean;
}): Promise<OpenRouterTranscriptionResult> {
  const audio = await readFile(audioPath);
  const response = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Plaude STT"
    },
    body: JSON.stringify({
      input_audio: {
        data: audio.toString("base64"),
        format: audioFormat
      },
      model,
      ...(includeLanguage ? { language } : {}),
      temperature
    })
  });

  if (!response.ok) {
    throw new OpenRouterHttpError(
      response.status,
      await parseOpenRouterError(response)
    );
  }

  const body = (await response.json()) as OpenRouterResponse;
  if (typeof body.text !== "string") {
    throw new AppError(
      ErrorCode.PlaudUpstreamError,
      "OpenRouter returned a transcription without text.",
      502
    );
  }

  return {
    text: body.text,
    model: typeof body.model === "string" ? body.model : model,
    usage: body.usage
  };
}

async function requestTranscription(
  options: Parameters<typeof requestTranscriptionOnce>[0]
): Promise<OpenRouterTranscriptionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestTranscriptionOnce(options);
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenRouterError(error) || attempt === 2) break;
      await delay(600 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function transcribeChunkWithOpenRouter({
  apiKey,
  audioPath,
  audioFormat,
  model,
  fallbackModel,
  language,
  temperature
}: {
  apiKey: string;
  audioPath: string;
  audioFormat: string;
  model: string;
  fallbackModel: string;
  language: string;
  temperature: number;
}): Promise<OpenRouterTranscriptionResult> {
  const warnings: string[] = [];

  const runWithLanguageFallback = async (
    selectedModel: string
  ): Promise<OpenRouterTranscriptionResult> => {
    try {
      return await requestTranscription({
        apiKey,
        audioPath,
        audioFormat,
        model: selectedModel,
        language,
        temperature,
        includeLanguage: true
      });
    } catch (error) {
      if (!isLanguageCompatibilityError(error)) throw error;
      warnings.push(
        `${selectedModel} rejected language=${language}; retried without language.`
      );
      return requestTranscription({
        apiKey,
        audioPath,
        audioFormat,
        model: selectedModel,
        language,
        temperature,
        includeLanguage: false
      });
    }
  };

  try {
    const result = await runWithLanguageFallback(model);
    return {
      ...result,
      warning: warnings.join(" ") || undefined
    };
  } catch (error) {
    if (model !== "openrouter/auto" || !shouldFallbackFromAuto(error)) {
      throw error;
    }

    warnings.push(
      `openrouter/auto was not accepted by the transcription endpoint; retried with ${fallbackModel}.`
    );
    const result = await runWithLanguageFallback(fallbackModel);
    return {
      ...result,
      warning: warnings.join(" ")
    };
  }
}
