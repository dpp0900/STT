import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const APP_URL = process.env.PLAUDE_APP_URL || "http://localhost:3000";
const DB_PATH = resolve(process.cwd(), "data", "db.json");
const OUTPUT_ROOT = resolve(process.cwd(), "data", "stt", "benchmarks");
const OPENROUTER_TRANSCRIPTION_MODELS_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription";
const DEFAULT_QUERY = "2026-06-27 15:14:23";

const DEEPGRAM_PRESETS = [
  {
    id: "deepgram/nova-3",
    label: "Deepgram: Nova-3",
    description: "Deepgram prerecorded STT model."
  }
];

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const query = argv.find((arg) => !arg.startsWith("--")) || DEFAULT_QUERY;
  return {
    query,
    openrouterStt: flags.has("--openrouter-stt"),
    includeDeepgram: flags.has("--include-deepgram"),
    force: flags.has("--force")
  };
}

async function readDb() {
  return JSON.parse(await readFile(DB_PATH, "utf8"));
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

async function saveSettings(settings) {
  return requestJson("/api/settings/stt", {
    method: "PUT",
    body: JSON.stringify(settings)
  });
}

async function getSettings() {
  const body = await requestJson("/api/settings/stt");
  return body.settings;
}

async function getOpenRouterTranscriptionPresets() {
  const response = await fetch(OPENROUTER_TRANSCRIPTION_MODELS_URL);
  if (!response.ok) {
    throw new Error(
      `OpenRouter models request failed: ${response.status} ${response.statusText}`
    );
  }
  const body = await response.json();
  const models = Array.isArray(body?.data) ? body.data : [];
  return models
    .filter((model) => typeof model?.id === "string")
    .map((model) => ({
      id: model.id,
      label: typeof model.name === "string" ? model.name : model.id,
      description: "OpenRouter transcription model."
    }));
}

function dedupePresets(presets) {
  const seen = new Set();
  return presets.filter((preset) => {
    if (!preset?.id || seen.has(preset.id)) return false;
    seen.add(preset.id);
    return true;
  });
}

async function benchmarkPresets(originalSettings, options) {
  const basePresets = options.openrouterStt
    ? [
        ...(await getOpenRouterTranscriptionPresets()),
        originalSettings.presets.find((preset) => preset.id === "openrouter/auto")
      ]
    : originalSettings.presets;

  return dedupePresets([
    ...basePresets.filter(Boolean),
    ...(options.includeDeepgram ? DEEPGRAM_PRESETS : [])
  ]);
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

function publicTranscript(recording, model) {
  const transcription =
    recording.transcriptions?.[model] ||
    (recording.transcription?.model === model ? recording.transcription : null) ||
    {};
  return {
    status: transcription.status || "idle",
    model: transcription.model || null,
    text: transcription.text || "",
    chunks: Array.isArray(transcription.chunks) ? transcription.chunks.length : 0,
    warnings: transcription.warnings || [],
    error: transcription.error || null,
    updatedAt: transcription.updatedAt || null
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const initialDb = await readDb();
  const recording = findRecording(initialDb, options.query);
  if (!recording) {
    throw new Error(`Recording not found for query: ${options.query}`);
  }
  if (!recording.storagePath) {
    throw new Error(`Recording is not downloaded: ${recording.filename}`);
  }

  const originalSettings = await getSettings();
  const presets = await benchmarkPresets(originalSettings, options);
  const outputDir = join(
    OUTPUT_ROOT,
    `${safeName(recording.filename)}-${recording.id.slice(0, 8)}`
  );
  await mkdir(outputDir, { recursive: true });
  const summaryPath = join(outputDir, "summary.json");
  const previousSummary = await readJsonIfExists(summaryPath);
  const previousResults = new Map(
    (Array.isArray(previousSummary?.results) ? previousSummary.results : []).map((result) => [
      result.presetId,
      result
    ])
  );

  const summary = {
    recording: {
      id: recording.id,
      filename: recording.filename,
      serialNumber: recording.serialNumber,
      duration: recording.duration,
      storagePath: recording.storagePath
    },
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    options,
    results: []
  };

  try {
    for (const preset of presets) {
      const started = Date.now();
      const filename = `${safeName(preset.id)}.txt`;
      const textPath = join(outputDir, filename);
      const previousResult = previousResults.get(preset.id);
      const previousTextPath =
        typeof previousResult?.textPath === "string" ? previousResult.textPath : textPath;
      const canReuseArtifact =
        !options.force &&
        previousResult &&
        (previousResult.status === "completed" ||
          (previousResult.status === "failed" &&
            !/api key before transcribing/i.test(previousResult.error || ""))) &&
        (await fileExists(previousTextPath));

      if (canReuseArtifact) {
        const reused = {
          ...previousResult,
          reused: true,
          reusedArtifact: true,
          elapsedMs: 0,
          textPath: previousTextPath
        };
        summary.results.push(reused);
        console.log(
          `[benchmark] ${preset.id} reused ${previousResult.status} ${previousResult.textLength || 0} chars`
        );
        await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
        continue;
      }

      console.log(`[benchmark] ${preset.id} start`);

      try {
        const currentDb = await readDb();
        const currentRecording = currentDb.recordings.find((item) => item.id === recording.id);
        const current = currentRecording ? publicTranscript(currentRecording, preset.id) : null;
        const canReuse =
          current?.status === "completed" &&
          current.model === preset.id &&
          current.text.trim().length > 0;

        if (!canReuse) {
          await saveSettings({
            model: preset.id,
            fallbackModel: originalSettings.fallbackModel,
            language: originalSettings.language,
            chunkSeconds: originalSettings.chunkSeconds,
            overlapSeconds: originalSettings.overlapSeconds,
            temperature: originalSettings.temperature,
            concurrency: originalSettings.concurrency
          });
          await requestJson(`/api/transcriptions/${encodeURIComponent(recording.id)}/run`, {
            method: "POST",
            body: "{}"
          });
        }

        const refreshedDb = await readDb();
        const refreshedRecording = refreshedDb.recordings.find((item) => item.id === recording.id);
        if (!refreshedRecording) throw new Error("Recording disappeared after transcription.");
        const transcript = publicTranscript(refreshedRecording, preset.id);
        await writeFile(textPath, transcript.text || transcript.error || "", "utf8");

        summary.results.push({
          presetId: preset.id,
          label: preset.label,
          status: transcript.status,
          reportedModel: transcript.model,
          chunks: transcript.chunks,
          textLength: transcript.text.length,
          warnings: transcript.warnings,
          error: transcript.error,
          reused: canReuse,
          elapsedMs: Date.now() - started,
          textPath
        });
        console.log(
          `[benchmark] ${preset.id} ${transcript.status} ${transcript.text.length} chars`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeFile(textPath, message, "utf8").catch(() => undefined);
        summary.results.push({
          presetId: preset.id,
          label: preset.label,
          status: "failed",
          reportedModel: preset.id,
          chunks: 0,
          textLength: 0,
          warnings: [],
          error: message,
          reused: false,
          elapsedMs: Date.now() - started,
          textPath
        });
        console.error(`[benchmark] ${preset.id} failed:`, error);
      }

      await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    }
  } finally {
    await saveSettings({
      model: originalSettings.model,
      fallbackModel: originalSettings.fallbackModel,
      language: originalSettings.language,
      chunkSeconds: originalSettings.chunkSeconds,
      overlapSeconds: originalSettings.overlapSeconds,
      temperature: originalSettings.temperature,
      concurrency: originalSettings.concurrency
    }).catch((error) => {
      console.error("[benchmark] failed to restore settings:", error);
    });
  }

  summary.completedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`[benchmark] wrote ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
