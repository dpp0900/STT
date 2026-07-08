import {
  markTranscriptCleanupRunning,
  recoverInterruptedCleanupJobs,
  resolveTranscriptCleanupTarget,
  runTranscriptCleanupForRecording
} from "@/lib/stt/transcribe";

export interface CleanupJobStartResult {
  recordingId: string;
  model: string;
  status: "started" | "running" | "failed";
  started: boolean;
  error?: string;
}

interface CleanupJob {
  recordingId: string;
  model: string;
  startedAt: string;
  promise: Promise<void>;
}

type CleanupJobGlobal = typeof globalThis & {
  __plaudeCleanupJobs?: Map<string, CleanupJob>;
  __plaudeCleanupRecoveryPromise?: Promise<void>;
};

function jobStore(): Map<string, CleanupJob> {
  const globalState = globalThis as CleanupJobGlobal;
  globalState.__plaudeCleanupJobs ??= new Map<string, CleanupJob>();
  return globalState.__plaudeCleanupJobs;
}

function jobKey(recordingId: string, model: string): string {
  return `${recordingId}::${model}`;
}

export function ensureCleanupJobRuntime(): Promise<void> {
  const globalState = globalThis as CleanupJobGlobal;
  globalState.__plaudeCleanupRecoveryPromise ??= recoverInterruptedCleanupJobs()
    .then(() => undefined)
    .catch((error) => {
      console.error("Failed to recover interrupted cleanup jobs.", error);
    });
  return globalState.__plaudeCleanupRecoveryPromise;
}

export async function startTranscriptCleanupJob(
  recordingId: string,
  model?: string
): Promise<CleanupJobStartResult> {
  await ensureCleanupJobRuntime();
  const target = await resolveTranscriptCleanupTarget(recordingId, model);
  const key = jobKey(target.recordingId, target.model);
  const jobs = jobStore();
  const existing = jobs.get(key);
  if (existing) {
    return {
      recordingId: target.recordingId,
      model: target.model,
      status: "running",
      started: false
    };
  }

  const job: CleanupJob = {
    recordingId: target.recordingId,
    model: target.model,
    startedAt: new Date().toISOString(),
    promise: Promise.resolve()
  };
  jobs.set(key, job);

  try {
    await markTranscriptCleanupRunning(target.recordingId, target.model);
  } catch (error) {
    jobs.delete(key);
    throw error;
  }

  job.promise = runTranscriptCleanupForRecording(target.recordingId, target.model)
    .then(() => undefined)
    .catch((error) => {
      console.error(
        `Transcript cleanup job failed for ${target.recordingId} ${target.model}.`,
        error
      );
    })
    .finally(() => {
      jobs.delete(key);
    });

  return {
    recordingId: target.recordingId,
    model: target.model,
    status: "started",
    started: true
  };
}

export async function startTranscriptCleanupJobs(
  recordingIds: string[]
): Promise<CleanupJobStartResult[]> {
  const results: CleanupJobStartResult[] = [];
  for (const recordingId of recordingIds) {
    try {
      results.push(await startTranscriptCleanupJob(recordingId));
    } catch (error) {
      results.push({
        recordingId,
        model: "",
        status: "failed",
        started: false,
        error: error instanceof Error ? error.message : "Transcript cleanup could not start."
      });
    }
  }
  return results;
}
