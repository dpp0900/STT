import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError, ErrorCode } from "@/lib/errors";

const AUDIO_DIR = resolve(process.cwd(), "data", "audio");

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "recording"
  );
}

export function storageKeyForRecording(id: string, filename: string): string {
  return `${sanitizeFilename(filename)}-${id}.mp3`;
}

function resolveAudioPath(storagePath: string): string {
  if (
    storagePath.includes("..") ||
    storagePath.includes("\0") ||
    storagePath.startsWith("/") ||
    storagePath.includes("\\")
  ) {
    throw new AppError(ErrorCode.StorageError, "Invalid storage path", 400);
  }
  const path = resolve(join(AUDIO_DIR, storagePath));
  if (!path.startsWith(AUDIO_DIR)) {
    throw new AppError(ErrorCode.StorageError, "Invalid storage path", 400);
  }
  return path;
}

export function getAudioFilePath(storagePath: string): string {
  return resolveAudioPath(storagePath);
}

export async function saveAudioFile(
  storagePath: string,
  audio: Buffer
): Promise<void> {
  await mkdir(AUDIO_DIR, { recursive: true });
  await writeFile(resolveAudioPath(storagePath), audio);
}

export async function readAudioFile(storagePath: string): Promise<Buffer> {
  return readFile(resolveAudioPath(storagePath));
}

export async function statAudioFile(storagePath: string): Promise<{
  size: number;
  mtimeMs: number;
}> {
  const result = await stat(resolveAudioPath(storagePath));
  return { size: result.size, mtimeMs: result.mtimeMs };
}

export async function audioFileExists(storagePath: string | null): Promise<boolean> {
  if (!storagePath) return false;
  try {
    await access(resolveAudioPath(storagePath));
    return true;
  } catch {
    return false;
  }
}
