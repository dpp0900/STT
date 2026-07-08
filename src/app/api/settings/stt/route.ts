import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto-store";
import {
  defaultSttSettings,
  MAX_STT_CHUNK_SECONDS,
  MIN_STT_CHUNK_SECONDS,
  POSTPROCESS_MODEL_PRESETS,
  readDb,
  STT_MODEL_PRESETS,
  updateDb
} from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";

function publicSettings(settings: Awaited<ReturnType<typeof readDb>>["sttSettings"]) {
  const {
    encryptedOpenRouterApiKey: _openRouterApiKey,
    encryptedDeepgramApiKey: _deepgramApiKey,
    encryptedSonioxApiKey: _sonioxApiKey,
    ...rest
  } = settings;
  return {
    ...rest,
    hasApiKey: Boolean(
      settings.encryptedOpenRouterApiKey ||
        envValue("OPENROUTER_API_KEY", "OPENROUTER_KEY", "openrouter", "openrouter_api_key")
    ),
    hasDeepgramApiKey: Boolean(
      settings.encryptedDeepgramApiKey ||
        envValue("DEEPGRAM_API_KEY", "DEEPGRAM_KEY", "deepgram", "deepgram_api_key")
    ),
    hasSonioxApiKey: Boolean(
      settings.encryptedSonioxApiKey ||
        envValue("SONIOX_API_KEY", "SONIOX_KEY", "soniox", "soniox_api_key")
    ),
    presets: STT_MODEL_PRESETS,
    postprocessPresets: POSTPROCESS_MODEL_PRESETS
  };
}

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

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
  return parsed;
}

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    return NextResponse.json({
      success: true,
      settings: publicSettings(db.sttSettings)
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
      apiKey?: unknown;
      deepgramApiKey?: unknown;
      sonioxApiKey?: unknown;
      model?: unknown;
      fallbackModel?: unknown;
      postprocessEnabled?: unknown;
      postprocessModel?: unknown;
      language?: unknown;
      chunkSeconds?: unknown;
      overlapSeconds?: unknown;
      temperature?: unknown;
      concurrency?: unknown;
    } | null;

    if (!body) {
      throw new AppError(ErrorCode.InvalidInput, "Invalid JSON body.", 400);
    }

    const updated = await updateDb(async (db) => {
      const current = {
        ...defaultSttSettings(),
        ...db.sttSettings
      };

      const next = {
        ...current,
        model:
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : current.model,
        fallbackModel:
          typeof body.fallbackModel === "string" && body.fallbackModel.trim()
            ? body.fallbackModel.trim()
            : current.fallbackModel,
        postprocessEnabled:
          typeof body.postprocessEnabled === "boolean"
            ? body.postprocessEnabled
            : current.postprocessEnabled,
        postprocessModel:
          typeof body.postprocessModel === "string" && body.postprocessModel.trim()
            ? body.postprocessModel.trim()
            : current.postprocessModel,
        language:
          typeof body.language === "string" && body.language.trim()
            ? body.language.trim().toLowerCase()
            : current.language,
        chunkSeconds: numberInRange(
          body.chunkSeconds,
          current.chunkSeconds,
          MIN_STT_CHUNK_SECONDS,
          MAX_STT_CHUNK_SECONDS
        ),
        overlapSeconds: numberInRange(
          body.overlapSeconds,
          current.overlapSeconds,
          0,
          30
        ),
        temperature: numberInRange(body.temperature, current.temperature, 0, 1),
        concurrency: Math.round(
          numberInRange(body.concurrency, current.concurrency, 1, 1)
        ),
        updatedAt: new Date().toISOString()
      };

      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== "string") {
          throw new AppError(
            ErrorCode.InvalidInput,
            "OpenRouter API key must be a string.",
            400,
            { field: "apiKey" }
          );
        }
        const apiKey = body.apiKey.trim();
        next.encryptedOpenRouterApiKey = apiKey
          ? await encryptSecret(apiKey)
          : null;
      }

      if (body.deepgramApiKey !== undefined) {
        if (typeof body.deepgramApiKey !== "string") {
          throw new AppError(
            ErrorCode.InvalidInput,
            "Deepgram API key must be a string.",
            400,
            { field: "deepgramApiKey" }
          );
        }
        const deepgramApiKey = body.deepgramApiKey.trim();
        next.encryptedDeepgramApiKey = deepgramApiKey
          ? await encryptSecret(deepgramApiKey)
          : null;
      }

      if (body.sonioxApiKey !== undefined) {
        if (typeof body.sonioxApiKey !== "string") {
          throw new AppError(
            ErrorCode.InvalidInput,
            "Soniox API key must be a string.",
            400,
            { field: "sonioxApiKey" }
          );
        }
        const sonioxApiKey = body.sonioxApiKey.trim();
        next.encryptedSonioxApiKey = sonioxApiKey
          ? await encryptSecret(sonioxApiKey)
          : null;
      }

      db.sttSettings = next;
      return next;
    });

    return NextResponse.json({
      success: true,
      settings: publicSettings(updated)
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
