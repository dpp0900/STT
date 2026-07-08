import {
  readDb,
  updateDb,
  type LocalRecording,
  type TranscriptionState
} from "@/lib/db";
import { runTranscriptions } from "@/lib/stt/transcribe";
import { syncRecordings } from "@/lib/sync";

const AUTOMATION_TICK_MS = 60_000;
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let cyclePromise: Promise<void> | null = null;

function transcriptionForModel(
  recording: LocalRecording,
  model: string
): TranscriptionState | null {
  return (
    recording.transcriptions?.[model] ??
    (recording.transcription?.model === model ? recording.transcription : null)
  );
}

function isEligibleForAutoTranscribe(recording: LocalRecording, model: string): boolean {
  if (!recording.storagePath || !recording.downloadedAt) return false;
  const transcription = transcriptionForModel(recording, model);
  return !transcription || transcription.status === "idle";
}

function newestRecordingsFirst(left: LocalRecording, right: LocalRecording): number {
  const leftTime = Date.parse(left.startTime);
  const rightTime = Date.parse(right.startTime);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  return left.filename.localeCompare(right.filename);
}

function automationEnabled(
  settings: Awaited<ReturnType<typeof readDb>>["automationSettings"]
): boolean {
  return settings.autoSyncEnabled || settings.autoTranscribeEnabled;
}

function isDue(settings: Awaited<ReturnType<typeof readDb>>["automationSettings"]): boolean {
  if (!automationEnabled(settings)) return false;

  const startedAt = Date.parse(settings.lastRunStartedAt ?? "");
  const completedAt = Date.parse(settings.lastRunCompletedAt ?? "");
  const now = Date.now();

  if (
    settings.lastRunStatus === "running" &&
    Number.isFinite(startedAt) &&
    now - startedAt < STALE_RUNNING_MS
  ) {
    return false;
  }

  const lastFinishedAt = Number.isFinite(completedAt) ? completedAt : NaN;
  if (!Number.isFinite(lastFinishedAt)) return true;
  return now - lastFinishedAt >= settings.intervalMinutes * 60_000;
}

async function markAutomationRun(
  status: "running" | "completed" | "failed",
  message: string | null
): Promise<void> {
  const now = new Date().toISOString();
  await updateDb((db) => {
    db.automationSettings.lastRunStatus = status;
    db.automationSettings.lastRunMessage = message;
    if (status === "running") {
      db.automationSettings.lastRunStartedAt = now;
      db.automationSettings.lastRunCompletedAt = null;
    } else {
      db.automationSettings.lastRunCompletedAt = now;
    }
  });
}

async function runAutomationCycleOnce(reason: "timer" | "manual" | "startup"): Promise<void> {
  const initial = await readDb();
  const settings = initial.automationSettings;
  if (reason !== "manual" && !isDue(settings)) return;
  if (!automationEnabled(settings)) return;

  await markAutomationRun("running", "Automation is running.");

  try {
    const messages: string[] = [];

    if (settings.autoSyncEnabled) {
      if (!initial.connection) {
        messages.push("Auto sync skipped: Plaud is not connected.");
      } else {
        const result = await syncRecordings();
        messages.push(
          `Auto sync: ${result.newRecordings} new, ${result.updatedRecordings} updated, ${result.skippedRecordings} skipped.`
        );
        if (result.errors.length > 0) {
          messages.push(`${result.errors.length} sync error(s): ${result.errors[0]}`);
        }
      }
    }

    if (settings.autoTranscribeEnabled) {
      const current = await readDb();
      const model = current.sttSettings.model;
      const ids = current.recordings
        .filter((recording) => isEligibleForAutoTranscribe(recording, model))
        .sort(newestRecordingsFirst)
        .slice(0, settings.transcribeBatchSize)
        .map((recording) => recording.id);

      if (ids.length === 0) {
        messages.push("Auto transcription: no eligible local recordings.");
      } else {
        const results = await runTranscriptions(ids);
        const completed = results.filter((result) => result.status === "completed").length;
        const failed = results.length - completed;
        messages.push(
          `Auto transcription: ${completed} completed, ${failed} failed for ${model}.`
        );
        const firstError = results.find((result) => result.error)?.error;
        if (firstError) messages.push(firstError);
      }
    }

    await markAutomationRun("completed", messages.join(" "));
  } catch (error) {
    await markAutomationRun(
      "failed",
      error instanceof Error ? error.message : "Automation failed."
    );
  }
}

export async function runAutomationCycle(
  reason: "timer" | "manual" | "startup" = "manual"
): Promise<void> {
  if (cyclePromise) return cyclePromise;
  cyclePromise = runAutomationCycleOnce(reason).finally(() => {
    cyclePromise = null;
  });
  return cyclePromise;
}

export function ensureAutomationScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerTimer = setInterval(() => {
    void runAutomationCycle("timer");
  }, AUTOMATION_TICK_MS);
  schedulerTimer.unref?.();
  void runAutomationCycle("startup");
}
