import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto-store";
import { readDb } from "@/lib/db";
import { errorBody, normalizeError } from "@/lib/errors";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const SONIOX_API_BASE = "https://api.soniox.com";
const DAY_MS = 24 * 60 * 60 * 1000;

interface ProviderKey {
  apiKey: string | null;
  error?: string;
}

interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: unknown;
    total_usage?: unknown;
  };
  error?: {
    message?: unknown;
  };
}

interface OpenRouterKeyResponse {
  data?: {
    label?: unknown;
    limit?: unknown;
    limit_reset?: unknown;
    limit_remaining?: unknown;
    include_byok_in_limit?: unknown;
    usage?: unknown;
    usage_daily?: unknown;
    usage_weekly?: unknown;
    usage_monthly?: unknown;
    byok_usage?: unknown;
    byok_usage_daily?: unknown;
    byok_usage_weekly?: unknown;
    byok_usage_monthly?: unknown;
    is_free_tier?: unknown;
  };
  error?: {
    message?: unknown;
  };
}

interface SonioxUsageLog {
  end_time?: unknown;
  cost_usd?: unknown;
  input_audio_duration_ms?: unknown;
}

interface SonioxUsageLogsResponse {
  usage_logs?: SonioxUsageLog[];
  next_page_cursor?: unknown;
  error_type?: unknown;
  message?: unknown;
}

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function providerKey(
  encrypted: string | null | undefined,
  envNames: string[]
): Promise<ProviderKey> {
  if (encrypted) {
    try {
      return { apiKey: await decryptSecret(encrypted) };
    } catch (error) {
      return {
        apiKey: null,
        error: error instanceof Error ? error.message : "Could not decrypt stored API key."
      };
    }
  }
  return { apiKey: envValue(...envNames) };
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  const text = await response.text().catch(() => "");
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    const maybeError = parsed as {
      error?: { message?: unknown };
      error_type?: unknown;
      message?: unknown;
    };
    const message =
      (typeof maybeError.error?.message === "string" && maybeError.error.message) ||
      (typeof maybeError.message === "string" && maybeError.message) ||
      (typeof maybeError.error_type === "string" && maybeError.error_type) ||
      `${response.status} ${response.statusText || "request failed"}`;
    throw new Error(message);
  }
  return parsed;
}

async function openRouterUsage(key: ProviderKey) {
  if (key.error) {
    return { hasApiKey: false, error: key.error };
  }
  if (!key.apiKey) {
    return { hasApiKey: false };
  }

  const [creditsResult, keyResult] = await Promise.allSettled([
    fetchJson<OpenRouterCreditsResponse>(`${OPENROUTER_API_BASE}/credits`, key.apiKey),
    fetchJson<OpenRouterKeyResponse>(`${OPENROUTER_API_BASE}/key`, key.apiKey)
  ]);

  const totalCredits =
    creditsResult.status === "fulfilled"
      ? numberValue(creditsResult.value.data?.total_credits)
      : null;
  const totalUsage =
    creditsResult.status === "fulfilled"
      ? numberValue(creditsResult.value.data?.total_usage)
      : null;
  const normalizedCredits =
    totalCredits !== null && totalUsage !== null
      ? {
          totalCredits,
          totalUsage,
          remaining: totalCredits - totalUsage
        }
      : null;

  const keyData = keyResult.status === "fulfilled" ? keyResult.value.data ?? null : null;

  return {
    hasApiKey: true,
    account: normalizedCredits,
    key:
      keyData !== null
        ? {
            label: stringValue(keyData.label),
            limit: numberValue(keyData.limit),
            limitReset: stringValue(keyData.limit_reset),
            limitRemaining: numberValue(keyData.limit_remaining),
            includeByokInLimit: booleanValue(keyData.include_byok_in_limit),
            usage: numberValue(keyData.usage),
            usageDaily: numberValue(keyData.usage_daily),
            usageWeekly: numberValue(keyData.usage_weekly),
            usageMonthly: numberValue(keyData.usage_monthly),
            byokUsage: numberValue(keyData.byok_usage),
            byokUsageDaily: numberValue(keyData.byok_usage_daily),
            byokUsageWeekly: numberValue(keyData.byok_usage_weekly),
            byokUsageMonthly: numberValue(keyData.byok_usage_monthly),
            isFreeTier: booleanValue(keyData.is_free_tier)
          }
        : null,
    accountError:
      creditsResult.status === "rejected" ? creditsResult.reason?.message ?? "Credits request failed." : null,
    keyError: keyResult.status === "rejected" ? keyResult.reason?.message ?? "Key request failed." : null
  };
}

function isoUtc(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sumSonioxUsage(
  logs: SonioxUsageLog[],
  startTime: Date,
  endTime: Date,
  truncated: boolean
) {
  let costUsd = 0;
  let inputAudioDurationMs = 0;
  let requests = 0;

  for (const log of logs) {
    const endedAt = typeof log.end_time === "string" ? Date.parse(log.end_time) : NaN;
    if (!Number.isFinite(endedAt) || endedAt < startTime.getTime() || endedAt >= endTime.getTime()) {
      continue;
    }
    requests += 1;
    costUsd += numberValue(log.cost_usd) ?? 0;
    inputAudioDurationMs += numberValue(log.input_audio_duration_ms) ?? 0;
  }

  return {
    startTime: isoUtc(startTime),
    endTime: isoUtc(endTime),
    requests,
    costUsd,
    inputAudioDurationMs,
    truncated
  };
}

async function fetchSonioxUsageLogs(apiKey: string, startTime: Date, endTime: Date) {
  const logs: SonioxUsageLog[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      start_time: isoUtc(startTime),
      end_time: isoUtc(endTime),
      sort: "end_time_asc",
      limit: "1000"
    });
    if (cursor) params.set("cursor", cursor);

    const response = await fetchJson<SonioxUsageLogsResponse>(
      `${SONIOX_API_BASE}/v1/usage-logs?${params.toString()}`,
      apiKey
    );
    logs.push(...(Array.isArray(response.usage_logs) ? response.usage_logs : []));
    cursor = typeof response.next_page_cursor === "string" ? response.next_page_cursor : null;
    if (!cursor) return { logs, truncated };
  }

  truncated = true;
  return { logs, truncated };
}

async function sonioxUsage(key: ProviderKey) {
  if (key.error) {
    return { hasApiKey: false, balanceAvailable: false, error: key.error };
  }
  if (!key.apiKey) {
    return { hasApiKey: false, balanceAvailable: false };
  }

  const endTime = new Date();
  const start31Days = new Date(endTime.getTime() - 31 * DAY_MS + 1000);
  const monthStart = new Date(Date.UTC(endTime.getUTCFullYear(), endTime.getUTCMonth(), 1));

  try {
    const { logs, truncated } = await fetchSonioxUsageLogs(key.apiKey, start31Days, endTime);
    return {
      hasApiKey: true,
      balanceAvailable: false,
      last31Days: sumSonioxUsage(logs, start31Days, endTime, truncated),
      monthToDate: sumSonioxUsage(logs, monthStart, endTime, truncated)
    };
  } catch (error) {
    return {
      hasApiKey: true,
      balanceAvailable: false,
      error: error instanceof Error ? error.message : "Could not load Soniox usage."
    };
  }
}

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    const openRouterKey = await providerKey(db.sttSettings.encryptedOpenRouterApiKey, [
      "OPENROUTER_API_KEY",
      "OPENROUTER_KEY",
      "openrouter",
      "openrouter_api_key"
    ]);
    const sonioxKey = await providerKey(db.sttSettings.encryptedSonioxApiKey, [
      "SONIOX_API_KEY",
      "SONIOX_KEY",
      "soniox",
      "soniox_api_key"
    ]);

    const [openRouter, soniox] = await Promise.all([
      openRouterUsage(openRouterKey),
      sonioxUsage(sonioxKey)
    ]);

    return NextResponse.json({
      success: true,
      generatedAt: new Date().toISOString(),
      providers: {
        openRouter,
        soniox
      }
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
