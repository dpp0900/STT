import { AppError, ErrorCode } from "@/lib/errors";
import { plaudFetch } from "@/lib/plaud/fetch";
import { safeParseJson } from "@/lib/plaud/parse";
import {
  DEFAULT_PLAUD_API_BASE,
  isValidPlaudApiUrl,
  normalizePlaudApiBase
} from "@/lib/plaud/servers";
import type {
  PlaudDeviceListResponse,
  PlaudRecordingsResponse,
  PlaudTempUrlResponse
} from "@/lib/plaud/types";
import { resolveWorkspaceToken } from "@/lib/plaud/workspace";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlaudClient {
  private readonly userToken: string;
  private readonly apiBase: string;
  private workspaceToken?: string;
  private resolvedWorkspaceId?: string;
  private workspaceFetchInFlight?: Promise<void>;
  private workspaceFallbackToUserToken = false;

  constructor(
    userToken: string,
    apiBase: string = DEFAULT_PLAUD_API_BASE,
    workspaceId?: string | null
  ) {
    if (!isValidPlaudApiUrl(apiBase)) {
      throw new AppError(
        ErrorCode.PlaudInvalidApiBase,
        "Invalid Plaud API base",
        400
      );
    }
    this.userToken = userToken;
    this.apiBase = normalizePlaudApiBase(apiBase);
    this.resolvedWorkspaceId = workspaceId ?? undefined;
  }

  get workspaceId(): string | undefined {
    return this.resolvedWorkspaceId;
  }

  get usingUserTokenFallback(): boolean {
    return this.workspaceFallbackToUserToken;
  }

  private async ensureWorkspaceToken(): Promise<void> {
    if (this.workspaceToken || this.workspaceFallbackToUserToken) return;
    if (!this.workspaceFetchInFlight) {
      this.workspaceFetchInFlight = this.fetchWorkspaceToken();
    }
    try {
      await this.workspaceFetchInFlight;
    } finally {
      this.workspaceFetchInFlight = undefined;
    }
  }

  private async fetchWorkspaceToken(): Promise<void> {
    try {
      const { workspaceToken, workspaceId } = await resolveWorkspaceToken(
        this.userToken,
        this.apiBase,
        this.resolvedWorkspaceId
      );
      this.workspaceToken = workspaceToken;
      this.resolvedWorkspaceId = workspaceId;
    } catch (error) {
      console.warn(
        "[plaud] workspace token mint failed, falling back to user token:",
        error instanceof Error ? error.message : error
      );
      this.workspaceFallbackToUserToken = true;
    }
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit,
    retryCount = 0
  ): Promise<T> {
    await this.ensureWorkspaceToken();

    const bearer = this.workspaceToken ?? this.userToken;
    let response: Response;
    try {
      response = await plaudFetch(`${this.apiBase}${endpoint}`, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        await sleep(INITIAL_RETRY_DELAY_MS * 2 ** retryCount);
        return this.request<T>(endpoint, options, retryCount + 1);
      }
      throw error;
    }

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "", 10);
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : INITIAL_RETRY_DELAY_MS * 2 ** retryCount);
      return this.request<T>(endpoint, options, retryCount + 1);
    }

    if (!response.ok) {
      let message = response.statusText || "Plaud API request failed";
      try {
        const body = (await response.json()) as { msg?: unknown; message?: unknown };
        message =
          (typeof body.msg === "string" && body.msg) ||
          (typeof body.message === "string" && body.message) ||
          message;
      } catch {
        // Ignore unreadable upstream error bodies.
      }

      if (response.status === 401) {
        throw new AppError(
          ErrorCode.PlaudInvalidToken,
          "Plaud rejected the access token. Sign in again.",
          401,
          { plaudStatus: response.status, plaudMessage: message }
        );
      }
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        await sleep(INITIAL_RETRY_DELAY_MS * 2 ** retryCount);
        return this.request<T>(endpoint, options, retryCount + 1);
      }
      throw new AppError(
        response.status >= 500 ? ErrorCode.PlaudUpstreamError : ErrorCode.PlaudApiError,
        message,
        response.status >= 500 ? 502 : 400,
        { plaudStatus: response.status }
      );
    }

    return safeParseJson<T>(response);
  }

  async listDevices(): Promise<PlaudDeviceListResponse> {
    const body = await this.request<PlaudDeviceListResponse>("/device/list");
    if (body.status !== 0 || !Array.isArray(body.data_devices)) {
      throw new AppError(
        ErrorCode.PlaudApiError,
        body.msg || "Failed to list Plaud devices",
        400,
        { plaudStatus: body.status }
      );
    }
    return body;
  }

  async getRecordings(
    skip = 0,
    limit = 50,
    isTrash = 0,
    sortBy = "edit_time",
    isDesc = true
  ): Promise<PlaudRecordingsResponse> {
    const params = new URLSearchParams({
      skip: String(skip),
      limit: String(limit),
      is_trash: String(isTrash),
      sort_by: sortBy,
      is_desc: String(isDesc)
    });
    const body = await this.request<PlaudRecordingsResponse>(
      `/file/simple/web?${params.toString()}`
    );
    if (body.status !== 0 || !Array.isArray(body.data_file_list)) {
      throw new AppError(
        ErrorCode.PlaudApiError,
        body.msg || "Failed to list Plaud recordings",
        400,
        { plaudStatus: body.status }
      );
    }
    return body;
  }

  async getTempUrl(fileId: string, isOpus = false): Promise<PlaudTempUrlResponse> {
    const params = new URLSearchParams({ is_opus: isOpus ? "1" : "0" });
    const body = await this.request<PlaudTempUrlResponse>(
      `/file/temp-url/${encodeURIComponent(fileId)}?${params.toString()}`
    );
    if (body.status !== 0 || !body.temp_url) {
      throw new AppError(
        ErrorCode.PlaudApiError,
        body.msg || "Failed to get Plaud download URL",
        400,
        { plaudStatus: body.status }
      );
    }
    return body;
  }

  async downloadRecording(fileId: string, preferOpus = false): Promise<Buffer> {
    const tempUrlResponse = await this.getTempUrl(fileId, preferOpus);
    const downloadUrl =
      preferOpus && tempUrlResponse.temp_url_opus
        ? tempUrlResponse.temp_url_opus
        : tempUrlResponse.temp_url;

    const response = await plaudFetch(downloadUrl);
    if (!response.ok) {
      throw new AppError(
        ErrorCode.PlaudUpstreamError,
        "Failed to download recording from Plaud.",
        502,
        { plaudStatus: response.status }
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export type {
  PlaudDevice,
  PlaudDeviceListResponse,
  PlaudRecording,
  PlaudRecordingsResponse
} from "@/lib/plaud/types";
