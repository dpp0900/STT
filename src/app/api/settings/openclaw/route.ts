import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto-store";
import {
  defaultOpenClawSettings,
  readDb,
  updateDb
} from "@/lib/db";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";
import { publicOpenClawSettings } from "@/lib/openclaw";

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    return NextResponse.json({
      success: true,
      settings: publicOpenClawSettings(db.openClawSettings)
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
      enabled?: unknown;
      webhookUrl?: unknown;
      webhookToken?: unknown;
      agentName?: unknown;
      model?: unknown;
      thinking?: unknown;
      deliver?: unknown;
      promptTemplate?: unknown;
    } | null;

    if (!body) {
      throw new AppError(ErrorCode.InvalidInput, "Invalid JSON body.", 400);
    }

    const updated = await updateDb(async (db) => {
      const current = {
        ...defaultOpenClawSettings(),
        ...db.openClawSettings
      };

      const next = {
        ...current,
        enabled:
          typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        webhookUrl:
          typeof body.webhookUrl === "string" && body.webhookUrl.trim()
            ? body.webhookUrl.trim()
            : current.webhookUrl,
        agentName:
          typeof body.agentName === "string" && body.agentName.trim()
            ? body.agentName.trim()
            : current.agentName,
        model:
          typeof body.model === "string" ? body.model.trim() : current.model,
        thinking:
          typeof body.thinking === "string"
            ? body.thinking.trim()
            : current.thinking,
        deliver:
          typeof body.deliver === "boolean" ? body.deliver : current.deliver,
        promptTemplate:
          typeof body.promptTemplate === "string" && body.promptTemplate.trim()
            ? body.promptTemplate
            : current.promptTemplate,
        updatedAt: new Date().toISOString()
      };

      if (body.webhookToken !== undefined) {
        if (typeof body.webhookToken !== "string") {
          throw new AppError(
            ErrorCode.InvalidInput,
            "OpenClaw hook token must be a string.",
            400,
            { field: "webhookToken" }
          );
        }
        const webhookToken = body.webhookToken.trim();
        next.encryptedWebhookToken = webhookToken
          ? await encryptSecret(webhookToken)
          : null;
      }

      db.openClawSettings = next;
      return next;
    });

    return NextResponse.json({
      success: true,
      settings: publicOpenClawSettings(updated)
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
