import type { TranscriptionPostprocessChunk, TranscriptionUsage } from "@/lib/db";
import { AppError, ErrorCode } from "@/lib/errors";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_POSTPROCESS_CHARS = 12_000;
const POSTPROCESS_CONCURRENCY = 4;
const RETRYABLE_CLEANUP_STATUS = new Set([500, 502, 503, 520, 524, 529]);
const DEEPSEEK_V4_FLASH_MODEL = "deepseek/deepseek-v4-flash";

interface OpenRouterProviderPreferences {
  order?: string[];
  allow_fallbacks?: boolean;
}

interface OpenRouterChatRequestBody {
  model: string;
  messages: {
    role: "system" | "user";
    content: string;
  }[];
  provider?: OpenRouterProviderPreferences;
  reasoning?: {
    effort: "none";
    exclude: true;
  };
  temperature: number;
  max_tokens: number;
  stream: boolean;
  stream_options?: {
    include_usage: true;
  };
}

interface OpenRouterChatResponse {
  choices?: {
    message?: {
      content?: unknown;
    };
  }[];
  usage?: OpenRouterUsage;
  error?: {
    message?: unknown;
  };
}

interface OpenRouterChatStreamChunk {
  choices?: {
    delta?: {
      content?: unknown;
    };
    finish_reason?: unknown;
  }[];
  usage?: OpenRouterUsage | null;
  error?: {
    message?: unknown;
    code?: unknown;
  };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
}

export interface PostprocessResult {
  text: string;
  model: string;
  chunks: TranscriptionPostprocessChunk[];
  usage?: TranscriptionUsage;
  warnings: string[];
}

export interface PostprocessProgress {
  completed: number;
  total: number;
  percent?: number;
  active?: number;
  generatedChars?: number;
  estimatedOutputTokens?: number;
  tokensPerSecond?: number;
  charsPerSecond?: number;
}

interface CleanupStreamProgress {
  generatedChars: number;
  estimatedOutputTokens: number;
  tokensPerSecond: number;
  charsPerSecond: number;
  chunkProgress: number;
}

class CleanupChatHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CleanupChatHttpError";
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUsage(usage: OpenRouterUsage | undefined): TranscriptionUsage | undefined {
  if (!usage) return undefined;
  const normalized: TranscriptionUsage = {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  if (typeof inputTokens === "number") normalized.input_tokens = inputTokens;
  if (typeof outputTokens === "number") normalized.output_tokens = outputTokens;
  if (typeof usage.total_tokens === "number") normalized.total_tokens = usage.total_tokens;
  if (typeof usage.cost === "number") normalized.cost = usage.cost;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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

function splitTranscript(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_POSTPROCESS_CHARS) return [normalized];

  const chunks: string[] = [];
  let current = "";

  for (const line of normalized.split(/\r?\n/)) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= MAX_POSTPROCESS_CHARS) {
      current = next;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());

    if (line.length <= MAX_POSTPROCESS_CHARS) {
      current = line;
      continue;
    }

    for (let index = 0; index < line.length; index += MAX_POSTPROCESS_CHARS) {
      chunks.push(line.slice(index, index + MAX_POSTPROCESS_CHARS).trim());
    }
    current = "";
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

interface SpeakerLine {
  start: string;
  end: string;
  channel: string;
  speaker: string;
  text: string;
}

function parseSpeakerLine(line: string): SpeakerLine | null {
  const match = line.match(
    /^\[(\d{2}:\d{2}:\d{2})-(\d{2}:\d{2}:\d{2})\]\s+((?:C\d{2}\s+)?)([^:]+):\s*(.*)$/
  );
  if (!match) return null;
  const [, start, end, channel, speaker, text] = match;
  return {
    start,
    end,
    channel,
    speaker: speaker.trim(),
    text: text.trim()
  };
}

function hasSpeechContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function sameSpeaker(left: SpeakerLine, right: SpeakerLine): boolean {
  return (
    left.channel.trim().toLowerCase() === right.channel.trim().toLowerCase() &&
    left.speaker.replace(/\s+/g, " ").toLowerCase() ===
      right.speaker.replace(/\s+/g, " ").toLowerCase()
  );
}

function formatSpeakerLine(line: SpeakerLine): string {
  return `[${line.start}-${line.end}] ${line.channel}${line.speaker}: ${line.text}`.trim();
}

function normalizeTranscriptLines(text: string): string {
  const lines: string[] = [];
  let pending: SpeakerLine | null = null;

  const flushPending = () => {
    if (!pending) return;
    lines.push(formatSpeakerLine(pending));
    pending = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushPending();
      if (lines.at(-1) !== "") lines.push("");
      continue;
    }

    const speakerLine = parseSpeakerLine(trimmed);
    if (!speakerLine) {
      if (!hasSpeechContent(trimmed)) continue;
      flushPending();
      lines.push(trimmed);
      continue;
    }

    if (!hasSpeechContent(speakerLine.text)) continue;

    if (pending && sameSpeaker(pending, speakerLine)) {
      pending.end = speakerLine.end;
      pending.text = `${pending.text} ${speakerLine.text}`.replace(/\s+/g, " ").trim();
      continue;
    }

    flushPending();
    pending = speakerLine;
  }

  flushPending();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanupChatUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return OPENROUTER_CHAT_URL;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  return withoutSlash.endsWith("/chat/completions")
    ? withoutSlash
    : `${withoutSlash}/chat/completions`;
}

function cleanupApiLabel(baseUrl: string | undefined): string {
  return baseUrl?.trim() ? "Cleanup API" : "OpenRouter";
}

async function parseCleanupError(response: Response, label: string): Promise<string> {
  const text = await response.text().catch(() => "");
  const fallback = `${label} returned HTTP ${response.status} ${response.statusText || "error"}.`;
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as OpenRouterChatResponse;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    if (/^\s*</.test(text)) return fallback;
  }
  return text.slice(0, 500);
}

function systemPrompt(): string {
  return [
    "You are a Korean transcript post-editor.",
    "Rewrite the transcript for readability while preserving the original meaning.",
    "Do not summarize, omit, invent, translate, or add new facts.",
    "Preserve speaker labels, timestamps, turn order, and paragraph boundaries whenever present.",
    "Remove artifact-only turns such as a speaker line whose content is only '.', '...', punctuation, or whitespace.",
    "Merge consecutive turns from the same speaker into one line when no other speaker appears between them; use the first start timestamp and the last end timestamp.",
    "Fix Korean spacing, punctuation, sentence breaks, filler noise, and obvious STT recognition errors only when context strongly supports the correction.",
    "If a phrase is uncertain, keep it close to the source rather than guessing.",
    "Return only the cleaned transcript text."
  ].join(" ");
}

function providerPreferencesForModel(model: string): OpenRouterProviderPreferences | undefined {
  if (model !== DEEPSEEK_V4_FLASH_MODEL) return undefined;
  return {
    order: ["deepinfra/fp4", "deepinfra"],
    allow_fallbacks: true
  };
}

function estimateOutputTokens(text: string): number {
  const meaningfulChars = text.replace(/\s+/g, "").length;
  if (meaningfulChars === 0) return 0;
  return Math.max(1, Math.round(meaningfulChars / 2.4));
}

function estimateChunkProgress(input: string, output: string): number {
  const expectedChars = Math.max(200, Math.round(input.trim().length * 0.82));
  if (!output.trim()) return 0;
  return Math.min(0.98, output.length / expectedChars);
}

async function parseOpenRouterStream(
  response: Response,
  label: string,
  onEvent: (event: OpenRouterChatStreamChunk) => Promise<void>
): Promise<void> {
  if (!response.body) {
    throw new AppError(
      ErrorCode.PlaudUpstreamError,
      `${label} returned an empty streaming response.`,
      502
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processEvent = async (rawEvent: string) => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") return;

    let parsed: OpenRouterChatStreamChunk;
    try {
      parsed = JSON.parse(payload) as OpenRouterChatStreamChunk;
    } catch {
      throw new AppError(
        ErrorCode.PlaudUpstreamError,
        `${label} returned an invalid streaming event: ${payload.slice(0, 180)}`,
        502
      );
    }

    await onEvent(parsed);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const normalized = buffer.replace(/\r\n/g, "\n");
      const boundary = normalized.indexOf("\n\n");
      if (boundary === -1) break;
      const event = normalized.slice(0, boundary);
      buffer = normalized.slice(boundary + 2);
      await processEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) await processEvent(buffer);
}

async function requestCleanupOnce({
  apiKey,
  baseUrl,
  model,
  transcript,
  chunkIndex,
  totalChunks,
  onStreamProgress
}: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  transcript: string;
  chunkIndex: number;
  totalChunks: number;
  onStreamProgress?: (progress: CleanupStreamProgress) => Promise<void> | void;
}): Promise<{ text: string; usage?: TranscriptionUsage }> {
  const label = cleanupApiLabel(baseUrl);
  const isOpenRouter = !baseUrl?.trim();
  const body: OpenRouterChatRequestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content: [
          `Transcript chunk ${chunkIndex + 1} of ${totalChunks}.`,
          "Clean this chunk only. Keep existing timestamp/speaker prefixes exactly when they appear.",
          "",
          transcript
        ].join("\n")
      }
    ],
    temperature: 0,
    max_tokens: 16_000,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (isOpenRouter) {
    body.reasoning = { effort: "none", exclude: true };
    const provider = providerPreferencesForModel(model);
    if (provider) body.provider = provider;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (isOpenRouter) {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "Plaude STT";
  }

  const response = await fetch(cleanupChatUrl(baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new CleanupChatHttpError(response.status, await parseCleanupError(response, label));
  }

  let content = "";
  let usage: TranscriptionUsage | undefined;
  const startedAt = Date.now();
  let lastProgressAt = 0;

  const emitProgress = async (force = false) => {
    if (!onStreamProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 650) return;
    lastProgressAt = now;
    const elapsedSeconds = Math.max(0.1, (now - startedAt) / 1000);
    const estimatedOutputTokens = estimateOutputTokens(content);
    await onStreamProgress({
      generatedChars: content.length,
      estimatedOutputTokens,
      tokensPerSecond: estimatedOutputTokens / elapsedSeconds,
      charsPerSecond: content.length / elapsedSeconds,
      chunkProgress: estimateChunkProgress(transcript, content)
    });
  };

  await parseOpenRouterStream(response, label, async (event) => {
    if (event.error) {
      const message =
        typeof event.error.message === "string"
          ? event.error.message
          : `${label} streaming request failed.`;
      throw new AppError(ErrorCode.PlaudUpstreamError, message, 502);
    }

    usage = mergeUsage(usage, normalizeUsage(event.usage ?? undefined));
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      content += delta;
      await emitProgress();
    }
  });

  await emitProgress(true);

  if (!content.trim()) {
    throw new AppError(
      ErrorCode.PlaudUpstreamError,
      `${label} returned an empty transcript cleanup result.`,
      502
    );
  }

  return {
    text: normalizeTranscriptLines(content),
    usage
  };
}

async function requestCleanup(
  options: Parameters<typeof requestCleanupOnce>[0]
): Promise<{ text: string; usage?: TranscriptionUsage }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestCleanupOnce(options);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof CleanupChatHttpError) ||
        !RETRYABLE_CLEANUP_STATUS.has(error.status) ||
        attempt === 2
      ) {
        break;
      }
      await delay(700 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export async function postprocessTranscriptWithOpenRouter({
  apiKey,
  baseUrl,
  model,
  transcript,
  onProgress
}: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  transcript: string;
  onProgress?: (progress: PostprocessProgress) => Promise<void> | void;
}): Promise<PostprocessResult> {
  const parts = splitTranscript(transcript);
  if (parts.length === 0) {
    return {
      text: "",
      model,
      chunks: [],
      warnings: ["Transcript cleanup skipped because the STT result was empty."]
    };
  }

  const chunks: TranscriptionPostprocessChunk[] = [];
  const chunkProgresses = new Array<number>(parts.length).fill(0);
  let completedCount = 0;
  const overallPercent = () =>
    Math.min(99, Math.round((chunkProgresses.reduce((sum, value) => sum + value, 0) / parts.length) * 100));

  await onProgress?.({ completed: 0, total: parts.length, percent: 0 });
  const completedChunks = await mapWithConcurrency(
    parts,
    POSTPROCESS_CONCURRENCY,
    async (part, index) => {
      const now = new Date().toISOString();
      const result = await requestCleanup({
        apiKey,
        baseUrl,
        model,
        transcript: part,
        chunkIndex: index,
        totalChunks: parts.length,
        onStreamProgress: async (streamProgress) => {
          chunkProgresses[index] = Math.max(
            chunkProgresses[index] ?? 0,
            streamProgress.chunkProgress
          );
          await onProgress?.({
            completed: completedCount,
            total: parts.length,
            percent: overallPercent(),
            active: index + 1,
            generatedChars: streamProgress.generatedChars,
            estimatedOutputTokens: streamProgress.estimatedOutputTokens,
            tokensPerSecond: streamProgress.tokensPerSecond,
            charsPerSecond: streamProgress.charsPerSecond
          });
        }
      });
      const chunk = {
        index,
        status: "completed" as const,
        model,
        text: result.text,
        usage: result.usage,
        createdAt: now,
        updatedAt: new Date().toISOString()
      };
      chunkProgresses[index] = 1;
      completedCount += 1;
      await onProgress?.({
        completed: completedCount,
        total: parts.length,
        percent: completedCount === parts.length ? 100 : overallPercent()
      });
      return chunk;
    }
  );

  let usage: TranscriptionUsage | undefined;
  for (const chunk of completedChunks) {
    usage = mergeUsage(usage, chunk.usage);
    chunks.push(chunk);
  }

  chunks.sort((left, right) => left.index - right.index);

  return {
    text: normalizeTranscriptLines(chunks.map((chunk) => chunk.text.trim()).filter(Boolean).join("\n")),
    model,
    chunks,
    usage,
    warnings:
      parts.length > 1
        ? [
            `Transcript cleanup was split into ${parts.length} chunks and processed with concurrency ${Math.min(
              POSTPROCESS_CONCURRENCY,
              parts.length
            )}.`
          ]
        : []
  };
}
