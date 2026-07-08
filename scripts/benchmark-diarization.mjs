import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "data", "db.json");
const SECRET_FILE = resolve(process.cwd(), "data", "app-secret");
const AUDIO_ROOT = resolve(process.cwd(), "data", "audio");
const OUTPUT_ROOT = resolve(process.cwd(), "data", "stt", "diarization-benchmarks");
const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_QUERY = "2026-06-27 15:14:23";
const DEFAULT_CHUNK_SECONDS = 300;
const DEFAULT_OVERLAP_SECONDS = 0;
const CHUNK_FORMAT = "mp3";

async function loadDotEnvFile() {
  let text = "";
  try {
    text = await readFile(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, ...rest] = arg.slice(2).split("=");
    if (rest.length === 0) {
      flags.add(key);
    } else {
      values.set(key, rest.join("="));
    }
  }

  const providers = (values.get("providers") || values.get("provider") || "deepgram,openai")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    query: values.get("query") || positional[0] || DEFAULT_QUERY,
    providers,
    force: flags.has("force"),
    chunkSeconds: parsePositiveInt(values.get("chunk-seconds"), DEFAULT_CHUNK_SECONDS),
    overlapSeconds: Math.max(
      0,
      parsePositiveInt(values.get("overlap-seconds"), DEFAULT_OVERLAP_SECONDS)
    ),
    maxChunks:
      values.has("max-chunks") ? parsePositiveInt(values.get("max-chunks"), null) : null
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runProcess(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function getDurationSeconds(inputPath) {
  const output = await runProcess("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath
  ]);
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration: ${inputPath}`);
  }
  return duration;
}

async function chunkAudio({ inputPath, outputDir, chunkSeconds, overlapSeconds, maxChunks }) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const durationSeconds = await getDurationSeconds(inputPath);
  const stepSeconds = Math.max(1, chunkSeconds - overlapSeconds);
  const expectedChunks = Math.max(1, Math.ceil(durationSeconds / stepSeconds));
  const chunkCount = maxChunks ? Math.min(maxChunks, expectedChunks) : expectedChunks;
  const chunks = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const startSeconds = Math.max(0, index * stepSeconds);
    if (startSeconds >= durationSeconds) break;
    const endSeconds = Math.min(durationSeconds, startSeconds + chunkSeconds);
    const path = join(outputDir, `chunk-${String(index).padStart(4, "0")}.${CHUNK_FORMAT}`);
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-y",
      "-ss",
      String(startSeconds),
      "-i",
      inputPath,
      "-t",
      String(chunkSeconds),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "64k",
      path
    ]);
    chunks.push({
      index,
      path,
      format: CHUNK_FORMAT,
      startSeconds,
      endSeconds
    });
  }

  return { durationSeconds, chunks };
}

function decryptStoredSecret(ciphertext, rawSecret) {
  const [version, ivB64, tagB64, encryptedB64] = String(ciphertext || "").split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Unsupported encrypted secret format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    rawSecret,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function loadStoredDeepgramApiKey(db) {
  const fromEnv = envValue("DEEPGRAM_API_KEY", "DEEPGRAM_KEY", "deepgram", "deepgram_api_key");
  if (fromEnv) return fromEnv;
  const encrypted = db.sttSettings?.encryptedDeepgramApiKey;
  if (!encrypted) return null;
  const rawSecret = Buffer.from((await readFile(SECRET_FILE, "utf8")).trim(), "base64");
  return decryptStoredSecret(encrypted, rawSecret);
}

function findRecording(db, query) {
  return db.recordings.find(
    (recording) =>
      recording.id === query ||
      recording.filename === query ||
      recording.serialNumber === query ||
      recording.storagePath?.includes(query)
  );
}

function contentTypeForFormat(format) {
  switch (format) {
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

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 1000) };
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deepgramWords(body, offsetSeconds, chunkIndex) {
  const words = body?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words)) return [];
  return words
    .map((word, index) => {
      const start = toNumber(word.start);
      const end = toNumber(word.end);
      return {
        chunkIndex,
        index,
        speaker: Number.isInteger(word.speaker) ? word.speaker : null,
        speakerConfidence: toNumber(word.speaker_confidence),
        word: typeof word.word === "string" ? word.word : "",
        punctuatedWord:
          typeof word.punctuated_word === "string" ? word.punctuated_word : null,
        startSeconds: start === null ? null : offsetSeconds + start,
        endSeconds: end === null ? null : offsetSeconds + end,
        confidence: toNumber(word.confidence)
      };
    })
    .filter((word) => word.word);
}

function deepgramUtterances(body, offsetSeconds, chunkIndex) {
  const utterances = body?.results?.utterances;
  if (!Array.isArray(utterances)) return [];
  return utterances
    .map((utterance, index) => {
      const start = toNumber(utterance.start);
      const end = toNumber(utterance.end);
      return {
        chunkIndex,
        index,
        speaker: Number.isInteger(utterance.speaker) ? utterance.speaker : null,
        startSeconds: start === null ? null : offsetSeconds + start,
        endSeconds: end === null ? null : offsetSeconds + end,
        text: typeof utterance.transcript === "string" ? utterance.transcript.trim() : ""
      };
    })
    .filter((utterance) => utterance.text);
}

function appendWordText(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (/^[.,!?;:%)]/.test(right)) return `${left}${right}`;
  return `${left} ${right}`;
}

function groupWordsIntoSegments(words) {
  const segments = [];
  let current = null;

  for (const word of words) {
    const speaker = word.speaker ?? "unknown";
    const displayWord = word.punctuatedWord || word.word;
    const gap =
      current?.endSeconds !== null &&
      word.startSeconds !== null &&
      current?.endSeconds !== undefined
        ? word.startSeconds - current.endSeconds
        : 0;

    if (
      !current ||
      current.speaker !== speaker ||
      current.chunkIndex !== word.chunkIndex ||
      gap > 1.25
    ) {
      current = {
        chunkIndex: word.chunkIndex,
        speaker,
        startSeconds: word.startSeconds,
        endSeconds: word.endSeconds,
        text: displayWord
      };
      segments.push(current);
      continue;
    }

    current.endSeconds = word.endSeconds;
    current.text = appendWordText(current.text, displayWord);
  }

  return segments.filter((segment) => segment.text.trim());
}

function normalizeSegments(segments) {
  return segments.map((segment, index) => ({
    index,
    chunkIndex: segment.chunkIndex,
    speaker: segment.speaker,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text.trim()
  }));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const rounded = Math.max(0, Math.floor(seconds));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatSpeakerLabel(value) {
  if (value === null || value === undefined || value === "unknown") return "Speaker ?";
  if (typeof value === "number" && Number.isFinite(value)) return `Speaker ${value + 1}`;

  const raw = String(value).trim();
  const numeric = raw.match(/^\d+$/);
  if (numeric) return `Speaker ${Number(raw) + 1}`;

  const named = raw.match(/^speaker[_\s-]?(\d+)$/i);
  if (named) return `Speaker ${Number(named[1]) + 1}`;

  return raw;
}

function formatSpeakerTranscript(segments) {
  return segments
    .map((segment) => {
      const start = formatTime(segment.startSeconds);
      const end = formatTime(segment.endSeconds);
      const speaker = formatSpeakerLabel(segment.speaker);
      return `[${start}-${end}] C${String(segment.chunkIndex + 1).padStart(2, "0")} ${speaker}: ${segment.text}`;
    })
    .join("\n");
}

function providerSummary({ providerId, status, chunks, segments, words, elapsedMs, error }) {
  const speakerLabels = [
    ...new Set(
      segments
        .map((segment) => segment.speaker)
        .filter((speaker) => speaker !== null && speaker !== undefined)
    )
  ];
  const text = segments.map((segment) => segment.text).join("\n");

  return {
    providerId,
    status,
    elapsedMs,
    elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    chunks: {
      total: chunks.length,
      completed: chunks.filter((chunk) => chunk.status === "completed").length,
      failed: chunks.filter((chunk) => chunk.status === "failed").length
    },
    textLength: text.length,
    words: words.length,
    speakerTurnCount: segments.length,
    speakerCountWithinChunks: speakerLabels.length,
    speakerLabels,
    error: error || null
  };
}

async function runDeepgramDiarization({ apiKey, chunks, outputDir }) {
  const startedAt = Date.now();
  const providerId = "deepgram/nova-3+diarize_model=latest";
  const rawDir = join(outputDir, "raw", safeName(providerId));
  await mkdir(rawDir, { recursive: true });

  const chunkResults = [];
  const allWords = [];
  let allSegments = [];
  let finalError = null;

  for (const chunk of chunks) {
    const chunkStartedAt = Date.now();
    try {
      const url = new URL(DEEPGRAM_LISTEN_URL);
      url.searchParams.set("model", "nova-3");
      url.searchParams.set("language", "ko");
      url.searchParams.set("punctuate", "true");
      url.searchParams.set("smart_format", "true");
      url.searchParams.set("utterances", "true");
      url.searchParams.set("diarize_model", "latest");

      const audio = await readFile(chunk.path);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": contentTypeForFormat(chunk.format)
        },
        body: audio
      });
      const body = await parseJsonResponse(response);
      await writeFile(
        join(rawDir, `chunk-${String(chunk.index).padStart(4, "0")}.json`),
        JSON.stringify(body, null, 2),
        "utf8"
      );

      if (!response.ok) {
        const message =
          body?.err_msg ||
          body?.message ||
          body?.error ||
          `${response.status} ${response.statusText}`;
        throw new Error(String(message));
      }

      const words = deepgramWords(body, chunk.startSeconds, chunk.index);
      const utterances = deepgramUtterances(body, chunk.startSeconds, chunk.index);
      const segments = utterances.length ? normalizeSegments(utterances) : groupWordsIntoSegments(words);
      allWords.push(...words);
      allSegments.push(...segments);
      chunkResults.push({
        index: chunk.index,
        status: "completed",
        elapsedMs: Date.now() - chunkStartedAt,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        words: words.length,
        speakerTurns: segments.length,
        speakerLabels: [...new Set(segments.map((segment) => segment.speaker))]
      });
      console.log(
        `[diarize] deepgram chunk ${chunk.index + 1}/${chunks.length} ok ${words.length} words ${segments.length} turns`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finalError ||= message;
      chunkResults.push({
        index: chunk.index,
        status: "failed",
        elapsedMs: Date.now() - chunkStartedAt,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        error: message
      });
      console.error(`[diarize] deepgram chunk ${chunk.index + 1}/${chunks.length} failed: ${message}`);
    }
  }

  allSegments = normalizeSegments(allSegments);
  const status = chunkResults.some((chunk) => chunk.status === "failed") ? "failed" : "completed";
  const summary = providerSummary({
    providerId,
    status,
    chunks: chunkResults,
    segments: allSegments,
    words: allWords,
    elapsedMs: Date.now() - startedAt,
    error: finalError
  });

  return {
    ...summary,
    chunks: chunkResults,
    segments: allSegments,
    words: allWords
  };
}

function openAiSegments(body, offsetSeconds, chunkIndex) {
  const rawSegments = Array.isArray(body?.segments) ? body.segments : [];
  return normalizeSegments(
    rawSegments
      .map((segment, index) => {
        const start = toNumber(segment.start);
        const end = toNumber(segment.end);
        return {
          chunkIndex,
          index,
          speaker:
            segment.speaker === null || segment.speaker === undefined
              ? "unknown"
              : String(segment.speaker),
          startSeconds: start === null ? null : offsetSeconds + start,
          endSeconds: end === null ? null : offsetSeconds + end,
          text:
            typeof segment.text === "string"
              ? segment.text
              : typeof segment.transcript === "string"
                ? segment.transcript
                : ""
        };
      })
      .filter((segment) => segment.text.trim())
  );
}

async function requestOpenAiDiarizationOnce({ apiKey, chunk, includeLanguage }) {
  const audio = await readFile(chunk.path);
  const form = new FormData();
  form.set("file", new Blob([audio], { type: contentTypeForFormat(chunk.format) }), `chunk-${chunk.index}.${chunk.format}`);
  form.set("model", "gpt-4o-transcribe-diarize");
  form.set("response_format", "diarized_json");
  form.set("chunking_strategy", "auto");
  if (includeLanguage) form.set("language", "ko");

  const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
    throw new Error(String(message));
  }
  return body;
}

async function requestOpenAiDiarization(options) {
  try {
    return await requestOpenAiDiarizationOnce({ ...options, includeLanguage: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/language|unsupported|unknown parameter/i.test(message)) throw error;
    return requestOpenAiDiarizationOnce({ ...options, includeLanguage: false });
  }
}

async function runOpenAiDiarization({ apiKey, chunks, outputDir }) {
  const startedAt = Date.now();
  const providerId = "openai/gpt-4o-transcribe-diarize";
  const rawDir = join(outputDir, "raw", safeName(providerId));
  await mkdir(rawDir, { recursive: true });

  const chunkResults = [];
  let allSegments = [];
  let finalError = null;

  for (const chunk of chunks) {
    const chunkStartedAt = Date.now();
    try {
      const body = await requestOpenAiDiarization({ apiKey, chunk });
      await writeFile(
        join(rawDir, `chunk-${String(chunk.index).padStart(4, "0")}.json`),
        JSON.stringify(body, null, 2),
        "utf8"
      );
      const segments = openAiSegments(body, chunk.startSeconds, chunk.index);
      allSegments.push(...segments);
      chunkResults.push({
        index: chunk.index,
        status: "completed",
        elapsedMs: Date.now() - chunkStartedAt,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        speakerTurns: segments.length,
        speakerLabels: [...new Set(segments.map((segment) => segment.speaker))]
      });
      console.log(
        `[diarize] openai chunk ${chunk.index + 1}/${chunks.length} ok ${segments.length} turns`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finalError ||= message;
      chunkResults.push({
        index: chunk.index,
        status: "failed",
        elapsedMs: Date.now() - chunkStartedAt,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        error: message
      });
      console.error(`[diarize] openai chunk ${chunk.index + 1}/${chunks.length} failed: ${message}`);
    }
  }

  allSegments = normalizeSegments(allSegments);
  const status = chunkResults.some((chunk) => chunk.status === "failed") ? "failed" : "completed";
  const summary = providerSummary({
    providerId,
    status,
    chunks: chunkResults,
    segments: allSegments,
    words: [],
    elapsedMs: Date.now() - startedAt,
    error: finalError
  });

  return {
    ...summary,
    chunks: chunkResults,
    segments: allSegments,
    words: []
  };
}

function slimProviderResult(result) {
  return {
    providerId: result.providerId,
    status: result.status,
    elapsedMs: result.elapsedMs,
    elapsedSeconds: result.elapsedSeconds,
    chunks: Array.isArray(result.chunks)
      ? {
          total: result.chunks.length,
          completed: result.chunks.filter((chunk) => chunk.status === "completed").length,
          failed: result.chunks.filter((chunk) => chunk.status === "failed").length
        }
      : result.chunks,
    textLength: result.textLength,
    words: result.words?.length ?? result.words ?? 0,
    speakerTurnCount: result.speakerTurnCount,
    speakerCountWithinChunks: result.speakerCountWithinChunks,
    speakerLabels: result.speakerLabels,
    error: result.error || null,
    transcriptPath: result.transcriptPath || null,
    jsonPath: result.jsonPath || null
  };
}

async function saveProviderArtifacts(outputDir, result) {
  const providerName = safeName(result.providerId);
  const transcriptPath = join(outputDir, `${providerName}.speaker-transcript.txt`);
  const jsonPath = join(outputDir, `${providerName}.json`);
  await writeFile(transcriptPath, formatSpeakerTranscript(result.segments || []), "utf8");
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  result.transcriptPath = transcriptPath;
  result.jsonPath = jsonPath;
}

async function main() {
  await loadDotEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const db = await readJson(DB_PATH);
  const recording = findRecording(db, options.query);
  if (!recording) {
    throw new Error(`Recording not found for query: ${options.query}`);
  }
  if (!recording.storagePath) {
    throw new Error(`Recording is not downloaded: ${recording.filename}`);
  }

  const audioPath = join(AUDIO_ROOT, recording.storagePath);
  if (!(await fileExists(audioPath))) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const outputDir = join(
    OUTPUT_ROOT,
    `${safeName(recording.filename)}-${recording.id.slice(0, 8)}`
  );
  if (options.force) {
    await rm(outputDir, { recursive: true, force: true });
  }
  await mkdir(outputDir, { recursive: true });

  const chunkDir = join(outputDir, "chunks");
  console.log(`[diarize] chunking ${recording.filename}`);
  const chunked = await chunkAudio({
    inputPath: audioPath,
    outputDir: chunkDir,
    chunkSeconds: options.chunkSeconds,
    overlapSeconds: options.overlapSeconds,
    maxChunks: options.maxChunks
  });

  const summary = {
    recording: {
      id: recording.id,
      filename: recording.filename,
      serialNumber: recording.serialNumber,
      durationSeconds: chunked.durationSeconds,
      storagePath: recording.storagePath,
      audioPath
    },
    options,
    startedAt: new Date().toISOString(),
    note:
      "This benchmark is intentionally isolated from the service DB and UI. Speaker labels are reliable within each chunk; cross-chunk speaker identity requires a separate stitching step.",
    results: []
  };

  const summaryPath = join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  for (const provider of options.providers) {
    if (provider === "deepgram") {
      const apiKey = await loadStoredDeepgramApiKey(db);
      if (!apiKey) {
        summary.results.push({
          providerId: "deepgram/nova-3+diarize_model=latest",
          status: "skipped",
          error: "DEEPGRAM_API_KEY is not set and no saved Deepgram key exists."
        });
        continue;
      }
      const result = await runDeepgramDiarization({
        apiKey,
        chunks: chunked.chunks,
        outputDir
      });
      await saveProviderArtifacts(outputDir, result);
      summary.results.push(slimProviderResult(result));
      await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
      continue;
    }

    if (provider === "openai") {
      const apiKey = envValue("OPENAI_API_KEY", "OPENAI_KEY", "openai", "openai_api_key");
      if (!apiKey) {
        summary.results.push({
          providerId: "openai/gpt-4o-transcribe-diarize",
          status: "skipped",
          error: "OPENAI_API_KEY is not set."
        });
        await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
        continue;
      }
      const result = await runOpenAiDiarization({
        apiKey,
        chunks: chunked.chunks,
        outputDir
      });
      await saveProviderArtifacts(outputDir, result);
      summary.results.push(slimProviderResult(result));
      await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
      continue;
    }

    summary.results.push({
      providerId: provider,
      status: "skipped",
      error: `Unknown diarization provider: ${provider}`
    });
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  }

  summary.completedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`[diarize] wrote ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
