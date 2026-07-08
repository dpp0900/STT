import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "data", "db.json");
const AUDIO_ROOT = resolve(process.cwd(), "data", "audio");
const OUTPUT_ROOT = resolve(process.cwd(), "data", "stt", "diarization-benchmarks");
const REFERENCE_BENCHMARK_ROOT = resolve(process.cwd(), "data", "stt", "benchmarks");
const SONIOX_API_BASE_URL = "https://api.soniox.com";
const SONIOX_MODEL = "stt-async-v5";
const DEFAULT_QUERY = "2026-06-27 15:14:23";
const USD_KRW_REFERENCE = 1529;

const SONIOX_PRICING = {
  asyncUsdPerHour: 0.1,
  inputAudioUsdPerMillionTokens: 1.5,
  outputTextUsdPerMillionTokens: 3.5,
  inputTextUsdPerMillionTokens: 3.5,
  audioTokensPerHour: 30000,
  textTokensPerCharacter: 0.3
};

const CONTEXT = {
  general: [
    { key: "language", value: "Korean" },
    { key: "domain", value: "software development, speech transcription, Plaud audio sync" }
  ],
  terms: [
    "Plaud",
    "PLAUD",
    "Riffado",
    "Claude",
    "OpenRouter",
    "Deepgram",
    "Soniox",
    "MAI-Transcribe",
    "STT",
    "API",
    "쿠키",
    "리전",
    "전사",
    "화자 분리",
    "한국어"
  ]
};

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

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
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

  return {
    query: values.get("query") || positional[0] || DEFAULT_QUERY,
    pollSeconds: parsePositiveNumber(values.get("poll-seconds"), 2),
    timeoutMinutes: parsePositiveNumber(values.get("timeout-minutes"), 60),
    force: flags.has("force"),
    noCleanup: flags.has("no-cleanup"),
    noContext: flags.has("no-context")
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

async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
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

function contentTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
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

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

async function sonioxFetch(apiKey, endpoint, { method = "GET", body, headers = {} } = {}) {
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
    const message =
      bodyJson?.error_message ||
      bodyJson?.message ||
      bodyJson?.error ||
      bodyJson?.raw ||
      `${response.status} ${response.statusText}`;
    throw new Error(String(message));
  }

  return bodyJson;
}

async function uploadAudio(apiKey, audioPath) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentTypeForPath(audioPath) }), basename(audioPath));
  const body = await sonioxFetch(apiKey, "/v1/files", {
    method: "POST",
    body: form
  });
  if (!body?.id) throw new Error("Soniox upload response did not include file id.");
  return body;
}

async function createTranscription(apiKey, config) {
  const body = await sonioxFetch(apiKey, "/v1/transcriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
  if (!body?.id) throw new Error("Soniox transcription response did not include transcription id.");
  return body;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForTranscription(apiKey, transcriptionId, { pollSeconds, timeoutMinutes }) {
  const startedAt = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let polls = 0;

  while (true) {
    const status = await sonioxFetch(apiKey, `/v1/transcriptions/${transcriptionId}`);
    polls += 1;
    if (status?.status === "completed") return { status, polls };
    if (status?.status === "error") {
      throw new Error(status.error_message || "Soniox transcription failed.");
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Soniox transcription after ${timeoutMinutes} minutes.`);
    }
    if (polls === 1 || polls % Math.max(1, Math.round(10 / pollSeconds)) === 0) {
      console.log(`[soniox] status=${status?.status || "unknown"} polls=${polls}`);
    }
    await sleep(pollSeconds * 1000);
  }
}

async function getTranscript(apiKey, transcriptionId) {
  return sonioxFetch(apiKey, `/v1/transcriptions/${transcriptionId}/transcript`);
}

async function deleteTranscription(apiKey, transcriptionId) {
  await sonioxFetch(apiKey, `/v1/transcriptions/${transcriptionId}`, { method: "DELETE" });
}

async function deleteFile(apiKey, fileId) {
  await sonioxFetch(apiKey, `/v1/files/${fileId}`, { method: "DELETE" });
}

function isOriginalTextToken(token) {
  if (!token || typeof token.text !== "string") return false;
  if (token.is_audio_event) return false;
  return token.translation_status !== "translation";
}

function millisecondsToSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function tokenGapSeconds(current, token) {
  const startSeconds = millisecondsToSeconds(token.start_ms);
  if (current?.endSeconds === null || current?.endSeconds === undefined || startSeconds === null) {
    return 0;
  }
  return startSeconds - current.endSeconds;
}

function normalizeSegments(segments) {
  return segments.map((segment, index) => ({
    index,
    chunkIndex: 0,
    speaker: segment.speaker,
    language: segment.language || null,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text.trim()
  }));
}

function sonioxTokensToSegments(tokens) {
  const segments = [];
  let current = null;

  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!isOriginalTextToken(token)) continue;
    const speaker = token.speaker || "unknown";
    const language = token.language || "unknown";
    const gap = tokenGapSeconds(current, token);

    if (!current || current.speaker !== speaker || current.language !== language || gap > 1.5) {
      current = {
        speaker,
        language,
        startSeconds: millisecondsToSeconds(token.start_ms),
        endSeconds: millisecondsToSeconds(token.end_ms),
        text: token.text
      };
      segments.push(current);
      continue;
    }

    current.endSeconds = millisecondsToSeconds(token.end_ms) ?? current.endSeconds;
    current.text += token.text;
  }

  return normalizeSegments(segments.filter((segment) => segment.text.trim()));
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
  return String(value).trim() || "Speaker ?";
}

function formatSpeakerTranscript(segments) {
  return segments
    .map((segment) => {
      const start = formatTime(segment.startSeconds);
      const end = formatTime(segment.endSeconds);
      const speaker = formatSpeakerLabel(segment.speaker);
      const language = segment.language ? ` [${segment.language}]` : "";
      return `[${start}-${end}] ${speaker}${language}: ${segment.text}`;
    })
    .join("\n");
}

function textStats(text) {
  const hangulChars = (text.match(/[가-힣]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z]{2,}/g) || []).length;
  const nonWhitespaceChars = text.replace(/\s/g, "").length;
  return {
    textLength: text.length,
    nonWhitespaceChars,
    hangulChars,
    latinWords,
    hangulRatio: nonWhitespaceChars ? Math.round((hangulChars / nonWhitespaceChars) * 1000) / 1000 : 0
  };
}

function estimateCost({ durationSeconds, outputTextLength, context }) {
  const durationHours = durationSeconds / 3600;
  const inputAudioTokens = durationHours * SONIOX_PRICING.audioTokensPerHour;
  const outputTextTokens = outputTextLength * SONIOX_PRICING.textTokensPerCharacter;
  const contextText = context ? JSON.stringify(context) : "";
  const inputTextTokens = contextText.length * SONIOX_PRICING.textTokensPerCharacter;
  const tokenEstimateUsd =
    (inputAudioTokens * SONIOX_PRICING.inputAudioUsdPerMillionTokens) / 1_000_000 +
    (outputTextTokens * SONIOX_PRICING.outputTextUsdPerMillionTokens) / 1_000_000 +
    (inputTextTokens * SONIOX_PRICING.inputTextUsdPerMillionTokens) / 1_000_000;
  const hourlyEstimateUsd = durationHours * SONIOX_PRICING.asyncUsdPerHour;

  return {
    pricingBasis:
      "Soniox async STT is advertised as about $0.10/hour; token estimate uses 30k audio tokens/hour and 0.3 text tokens/character.",
    durationHours: Math.round(durationHours * 10000) / 10000,
    inputAudioTokens: Math.round(inputAudioTokens),
    outputTextTokens: Math.round(outputTextTokens),
    inputTextTokens: Math.round(inputTextTokens),
    tokenEstimateUsd: Math.round(tokenEstimateUsd * 10000) / 10000,
    hourlyEstimateUsd: Math.round(hourlyEstimateUsd * 10000) / 10000,
    hourlyEstimateKrw: Math.round(hourlyEstimateUsd * USD_KRW_REFERENCE),
    usdKrwReference: USD_KRW_REFERENCE
  };
}

async function loadMaiReference(recording) {
  const referencePath = join(
    REFERENCE_BENCHMARK_ROOT,
    `${safeName(recording.filename)}-${recording.id.slice(0, 8)}`,
    "microsoft_mai-transcribe-1.5.txt"
  );
  try {
    const text = await readFile(referencePath, "utf8");
    return { path: referencePath, text };
  } catch {
    return null;
  }
}

function compareToReference(text, reference) {
  if (!reference?.text) return null;
  const referenceStats = textStats(reference.text);
  return {
    referenceProvider: "microsoft/mai-transcribe-1.5",
    referencePath: reference.path,
    referenceTextLength: reference.text.length,
    textLengthCoverage:
      reference.text.length > 0 ? Math.round((text.length / reference.text.length) * 1000) / 1000 : null,
    referenceHangulRatio: referenceStats.hangulRatio
  };
}

function slimResult(result) {
  return {
    providerId: result.providerId,
    status: result.status,
    elapsedMs: result.elapsedMs,
    elapsedSeconds: result.elapsedSeconds,
    textLength: result.textLength,
    hangulRatio: result.hangulRatio,
    tokens: result.tokens,
    speakerTurnCount: result.speakerTurnCount,
    speakerCount: result.speakerCount,
    speakerLabels: result.speakerLabels,
    costEstimate: result.costEstimate,
    referenceComparison: result.referenceComparison,
    error: result.error || null,
    transcriptPath: result.transcriptPath || null,
    plainTranscriptPath: result.plainTranscriptPath || null,
    jsonPath: result.jsonPath || null,
    rawTranscriptPath: result.rawTranscriptPath || null
  };
}

async function upsertSharedSummary({ outputDir, recording, audioPath, durationSeconds, options, result }) {
  const summaryPath = join(outputDir, "summary.json");
  const previous = await readJsonIfExists(summaryPath);
  const summary =
    previous && typeof previous === "object" && Array.isArray(previous.results)
      ? previous
      : {
          recording: {
            id: recording.id,
            filename: recording.filename,
            serialNumber: recording.serialNumber,
            durationSeconds,
            storagePath: recording.storagePath,
            audioPath
          },
          options: {},
          startedAt: new Date().toISOString(),
          note:
            "This benchmark is intentionally isolated from the service DB and UI. Soniox runs on the full file, so speaker labels do not require cross-chunk stitching.",
          results: []
        };

  summary.recording = {
    ...(summary.recording || {}),
    id: recording.id,
    filename: recording.filename,
    serialNumber: recording.serialNumber,
    durationSeconds,
    storagePath: recording.storagePath,
    audioPath
  };
  summary.options = {
    ...(summary.options || {}),
    soniox: {
      query: options.query,
      pollSeconds: options.pollSeconds,
      timeoutMinutes: options.timeoutMinutes,
      noCleanup: options.noCleanup,
      noContext: options.noContext
    }
  };
  summary.results = summary.results.filter((item) => item.providerId !== result.providerId);
  summary.results.push(slimResult(result));
  summary.completedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  return summaryPath;
}

async function runSonioxBenchmark({ apiKey, recording, audioPath, durationSeconds, outputDir, options }) {
  const startedAt = Date.now();
  const providerId = `soniox/${SONIOX_MODEL}`;
  const providerName = safeName(providerId);
  const rawDir = join(outputDir, "raw", providerName);
  await mkdir(rawDir, { recursive: true });

  let fileId = null;
  let transcriptionId = null;
  let transcript = null;
  let finalStatus = null;
  let finalError = null;

  const context = options.noContext ? null : CONTEXT;
  const config = {
    model: SONIOX_MODEL,
    language_hints: ["ko"],
    language_hints_strict: true,
    enable_language_identification: true,
    enable_speaker_diarization: true,
    client_reference_id: `plaude-stt:${recording.id}:${Date.now()}`,
    ...(context ? { context } : {})
  };

  try {
    console.log("[soniox] uploading audio");
    const upload = await uploadAudio(apiKey, audioPath);
    fileId = upload.id;
    await writeFile(join(rawDir, "upload.json"), JSON.stringify(upload, null, 2), "utf8");

    console.log("[soniox] creating transcription");
    const created = await createTranscription(apiKey, { ...config, file_id: fileId });
    transcriptionId = created.id;
    await writeFile(join(rawDir, "created.json"), JSON.stringify(created, null, 2), "utf8");

    console.log("[soniox] waiting for transcription");
    const completed = await waitForTranscription(apiKey, transcriptionId, options);
    finalStatus = completed.status;
    await writeFile(join(rawDir, "status-completed.json"), JSON.stringify(completed, null, 2), "utf8");

    console.log("[soniox] downloading transcript");
    transcript = await getTranscript(apiKey, transcriptionId);
    await writeFile(join(rawDir, "transcript.json"), JSON.stringify(transcript, null, 2), "utf8");
  } catch (error) {
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    if (!options.noCleanup) {
      if (transcriptionId) {
        try {
          await deleteTranscription(apiKey, transcriptionId);
        } catch (error) {
          console.error(`[soniox] cleanup transcription failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (fileId) {
        try {
          await deleteFile(apiKey, fileId);
        } catch (error) {
          console.error(`[soniox] cleanup file failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }

  const segments = sonioxTokensToSegments(transcript?.tokens);
  const text = typeof transcript?.text === "string" ? transcript.text.trim() : segments.map((s) => s.text).join("\n");
  const stats = textStats(text);
  const speakerLabels = [
    ...new Set(segments.map((segment) => segment.speaker).filter((speaker) => speaker && speaker !== "unknown"))
  ];
  const reference = await loadMaiReference(recording);
  const result = {
    providerId,
    status: finalError ? "failed" : "completed",
    elapsedMs: Date.now() - startedAt,
    elapsedSeconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    model: SONIOX_MODEL,
    sonioxStatus: finalStatus,
    fileId: options.noCleanup ? fileId : null,
    transcriptionId: options.noCleanup ? transcriptionId : null,
    cleanup: !options.noCleanup,
    config: { ...config, file_id: fileId ? "[uploaded-file-id]" : null },
    durationSeconds,
    ...stats,
    tokens: Array.isArray(transcript?.tokens) ? transcript.tokens.length : 0,
    speakerTurnCount: segments.length,
    speakerCount: speakerLabels.length,
    speakerLabels,
    costEstimate: estimateCost({ durationSeconds, outputTextLength: text.length, context }),
    referenceComparison: compareToReference(text, reference),
    error: finalError,
    segments
  };

  const transcriptPath = join(outputDir, `${providerName}.speaker-transcript.txt`);
  const plainTranscriptPath = join(outputDir, `${providerName}.txt`);
  const jsonPath = join(outputDir, `${providerName}.json`);
  result.transcriptPath = transcriptPath;
  result.plainTranscriptPath = plainTranscriptPath;
  result.jsonPath = jsonPath;
  result.rawTranscriptPath = join(rawDir, "transcript.json");
  await writeFile(transcriptPath, formatSpeakerTranscript(segments), "utf8");
  await writeFile(plainTranscriptPath, `${text}\n`, "utf8");
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");

  return result;
}

async function main() {
  await loadDotEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const apiKey = envValue("SONIOX_API_KEY", "SONIOX_KEY", "soniox", "soniox_api_key");
  if (!apiKey) {
    throw new Error("SONIOX_API_KEY is not set. Accepted aliases: SONIOX_API_KEY, SONIOX_KEY, soniox, soniox_api_key.");
  }

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
  await mkdir(outputDir, { recursive: true });

  const providerName = safeName(`soniox/${SONIOX_MODEL}`);
  if (options.force) {
    await rm(join(outputDir, "raw", providerName), { recursive: true, force: true });
    await rm(join(outputDir, `${providerName}.json`), { force: true });
    await rm(join(outputDir, `${providerName}.txt`), { force: true });
    await rm(join(outputDir, `${providerName}.speaker-transcript.txt`), { force: true });
  }

  const durationSeconds = await getDurationSeconds(audioPath);
  console.log(
    `[soniox] benchmarking ${recording.filename} (${Math.round((durationSeconds / 60) * 10) / 10} min)`
  );

  const result = await runSonioxBenchmark({
    apiKey,
    recording,
    audioPath,
    durationSeconds,
    outputDir,
    options
  });
  const summaryPath = await upsertSharedSummary({
    outputDir,
    recording,
    audioPath,
    durationSeconds,
    options,
    result
  });

  console.log(`[soniox] ${result.status} ${result.textLength} chars ${result.speakerTurnCount} turns`);
  console.log(`[soniox] estimated cost $${result.costEstimate.hourlyEstimateUsd} (${result.costEstimate.hourlyEstimateKrw} KRW @ ${USD_KRW_REFERENCE})`);
  console.log(`[soniox] wrote ${result.jsonPath}`);
  console.log(`[soniox] updated ${summaryPath}`);

  if (result.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
