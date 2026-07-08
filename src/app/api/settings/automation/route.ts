import { NextResponse } from "next/server";
import { ensureAutomationScheduler, runAutomationCycle } from "@/lib/automation";
import { requireAuth } from "@/lib/auth";
import {
  defaultAutomationSettings,
  MAX_AUTOMATION_INTERVAL_MINUTES,
  MAX_AUTOMATION_TRANSCRIBE_BATCH_SIZE,
  MIN_AUTOMATION_INTERVAL_MINUTES,
  MIN_AUTOMATION_TRANSCRIBE_BATCH_SIZE,
  readDb,
  updateDb
} from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";

function numberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new AppError(
      ErrorCode.InvalidInput,
      `Expected number between ${min} and ${max}.`,
      400
    );
  }
  return Math.round(parsed);
}

export async function GET() {
  try {
    await requireAuth();
    ensureAutomationScheduler();
    const db = await readDb();
    return NextResponse.json({
      success: true,
      settings: db.automationSettings
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}

export async function PUT(request: Request) {
  try {
    await requireAuth();
    const body = (await request.json().catch(() => null)) as {
      autoSyncEnabled?: unknown;
      autoTranscribeEnabled?: unknown;
      intervalMinutes?: unknown;
      transcribeBatchSize?: unknown;
    } | null;

    if (!body) {
      throw new AppError(ErrorCode.InvalidInput, "Invalid JSON body.", 400);
    }

    const updated = await updateDb((db) => {
      const defaults = defaultAutomationSettings();
      const current = {
        ...defaults,
        ...db.automationSettings
      };

      db.automationSettings = {
        ...current,
        autoSyncEnabled:
          typeof body.autoSyncEnabled === "boolean"
            ? body.autoSyncEnabled
            : current.autoSyncEnabled,
        autoTranscribeEnabled:
          typeof body.autoTranscribeEnabled === "boolean"
            ? body.autoTranscribeEnabled
            : current.autoTranscribeEnabled,
        intervalMinutes: numberInRange(
          body.intervalMinutes,
          current.intervalMinutes,
          MIN_AUTOMATION_INTERVAL_MINUTES,
          MAX_AUTOMATION_INTERVAL_MINUTES
        ),
        transcribeBatchSize: numberInRange(
          body.transcribeBatchSize,
          current.transcribeBatchSize,
          MIN_AUTOMATION_TRANSCRIBE_BATCH_SIZE,
          MAX_AUTOMATION_TRANSCRIBE_BATCH_SIZE
        ),
        updatedAt: new Date().toISOString()
      };

      return db.automationSettings;
    });

    ensureAutomationScheduler();
    return NextResponse.json({
      success: true,
      settings: updated
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}

export async function POST() {
  try {
    await requireAuth();
    ensureAutomationScheduler();
    await runAutomationCycle("manual");
    const db = await readDb();
    return NextResponse.json({
      success: true,
      settings: db.automationSettings
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
