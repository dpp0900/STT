import { mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { MAX_STT_CHUNK_SECONDS, MIN_STT_CHUNK_SECONDS } from "@/lib/db";

const STT_DIR = resolve(process.cwd(), "data", "stt");
const CHUNK_FORMAT = "mp3" as const;

export interface AudioChunk {
  index: number;
  path: string;
  format: typeof CHUNK_FORMAT;
  startSeconds: number;
  endSeconds: number | null;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffprobe", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
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
      reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
    });
  });
}

async function getDurationSeconds(inputPath: string): Promise<number> {
  const output = await runFfprobe([
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
    throw new Error("Could not determine audio duration with ffprobe.");
  }
  return duration;
}

export async function chunkAudioFile({
  recordingId,
  inputPath,
  chunkSeconds,
  overlapSeconds
}: {
  recordingId: string;
  inputPath: string;
  chunkSeconds: number;
  overlapSeconds: number;
}): Promise<AudioChunk[]> {
  const safeRecordingId = recordingId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const chunkDir = join(STT_DIR, "chunks", safeRecordingId);
  await rm(chunkDir, { recursive: true, force: true });
  await mkdir(chunkDir, { recursive: true });

  const effectiveSegmentSeconds = Math.min(
    MAX_STT_CHUNK_SECONDS,
    Math.max(MIN_STT_CHUNK_SECONDS, chunkSeconds)
  );
  const effectiveOverlapSeconds = Math.min(
    Math.max(0, overlapSeconds),
    Math.max(0, effectiveSegmentSeconds - 1)
  );
  const stepSeconds = effectiveSegmentSeconds - effectiveOverlapSeconds;
  const durationSeconds = await getDurationSeconds(inputPath);
  const expectedChunks = Math.max(1, Math.ceil(durationSeconds / stepSeconds));

  for (let index = 0; index < expectedChunks; index += 1) {
    const startSeconds = Math.max(0, index * stepSeconds);
    if (startSeconds >= durationSeconds) break;
    const outPath = join(chunkDir, `chunk-${String(index).padStart(4, "0")}.${CHUNK_FORMAT}`);
    await runFfmpeg([
      "-hide_banner",
      "-y",
      "-ss",
      String(startSeconds),
      "-i",
      inputPath,
      "-t",
      String(effectiveSegmentSeconds),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "64k",
      outPath
    ]);
  }

  const files = (await readdir(chunkDir))
    .filter((file) => /^chunk-\d+\.mp3$/.test(file))
    .sort();

  return files.map((file, index) => {
    const startSeconds = Math.max(0, index * stepSeconds);
    return {
      index,
      path: join(chunkDir, file),
      format: CHUNK_FORMAT,
      startSeconds,
      endSeconds: Math.min(durationSeconds, startSeconds + effectiveSegmentSeconds)
    };
  });
}
