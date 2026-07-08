import { AppError, ErrorCode } from "@/lib/errors";
import { safeParseJson } from "@/lib/plaud/parse";
import type {
  PlaudRecordingsResponse,
  PlaudTempUrlResponse
} from "@/lib/plaud/types";
import { isValidPlaudApiUrl } from "@/lib/plaud/servers";
import {
  normalizePlaudDeveloperApiBase,
  PLAUD_OAUTH_DEFAULT_API_BASE
} from "@/lib/plaud/oauth";

interface PlaudDeveloperFile {
  id: string;
  name?: string;
  filename?: string;
  created_at?: string;
  start_at?: string;
  duration?: number;
  serial_number?: string;
  presigned_url?: string;
  filesize?: number;
  file_size?: number;
  size?: number;
  updated_at?: string;
}

interface PlaudDeveloperListFilesResponse {
  data?: PlaudDeveloperFile[];
  files?: PlaudDeveloperFile[];
  page?: number;
  total?: number;
  total_count?: number;
  count?: number;
}

export class PlaudDeveloperClient {
  private readonly accessToken: string;
  private readonly apiBase: string;

  constructor(
    accessToken: string,
    apiBase: string = PLAUD_OAUTH_DEFAULT_API_BASE
  ) {
    if (!isValidPlaudApiUrl(apiBase)) {
      throw new AppError(
        ErrorCode.PlaudInvalidApiBase,
        "Invalid Plaud OAuth API base",
        400
      );
    }
    this.accessToken = accessToken;
    this.apiBase = normalizePlaudDeveloperApiBase(apiBase);
  }

  get workspaceId(): undefined {
    return undefined;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init?.headers,
        Authorization: `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new AppError(
          ErrorCode.PlaudInvalidToken,
          "Plaud OAuth token is invalid or expired. Reconnect the official CLI/MCP token file.",
          401,
          { plaudStatus: response.status, bodySnippet: body.slice(0, 300) }
        );
      }
      throw new AppError(
        response.status >= 500 ? ErrorCode.PlaudUpstreamError : ErrorCode.PlaudApiError,
        `Plaud developer API request failed: ${response.status}`,
        response.status >= 500 ? 502 : 400,
        { plaudStatus: response.status, bodySnippet: body.slice(0, 300) }
      );
    }

    return safeParseJson<T>(response);
  }

  async getCurrentUser(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/open/third-party/users/current");
  }

  async listFiles(
    page = 1,
    pageSize = 20
  ): Promise<PlaudDeveloperListFilesResponse> {
    const safePage = Math.max(1, Math.round(page));
    const safePageSize = Math.min(100, Math.max(10, Math.round(pageSize)));
    return this.request<PlaudDeveloperListFilesResponse>(
      `/open/third-party/files/?page=${safePage}&page_size=${safePageSize}`
    );
  }

  async getFile(fileId: string): Promise<PlaudDeveloperFile> {
    return this.request<PlaudDeveloperFile>(
      `/open/third-party/files/${encodeURIComponent(fileId)}`
    );
  }

  async getRecordings(
    skip = 0,
    limit = 50
  ): Promise<PlaudRecordingsResponse> {
    const pageSize = Math.min(100, Math.max(10, Math.round(limit || 50)));
    let page = Math.floor(Math.max(0, skip) / pageSize) + 1;
    const files: PlaudDeveloperFile[] = [];
    let total = 0;

    while (files.length < limit) {
      const body = await this.listFiles(page, pageSize);
      const data = Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.files)
          ? body.files
          : [];
      files.push(...data);
      total =
        numberValue(body.total) ??
        numberValue(body.total_count) ??
        numberValue(body.count) ??
        Math.max(total, files.length);
      if (data.length < pageSize) break;
      page += 1;
    }

    return {
      status: 0,
      msg: "",
      data_file_total: total || files.length,
      data_file_list: files.slice(0, limit).map(toPlaudRecording)
    };
  }

  async getTempUrl(fileId: string): Promise<PlaudTempUrlResponse> {
    const file = await this.getFile(fileId);
    const url = typeof file.presigned_url === "string" ? file.presigned_url : "";
    if (!url) {
      throw new AppError(
        ErrorCode.PlaudApiError,
        "Plaud developer API did not return an audio URL for this recording.",
        400
      );
    }
    return {
      status: 0,
      msg: "",
      temp_url: url
    };
  }

  async downloadRecording(fileId: string): Promise<Buffer> {
    const tempUrlResponse = await this.getTempUrl(fileId);
    const response = await fetch(tempUrlResponse.temp_url);
    if (!response.ok) {
      throw new AppError(
        ErrorCode.PlaudUpstreamError,
        "Failed to download recording from Plaud OAuth audio URL.",
        502,
        { plaudStatus: response.status }
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dateMs(value: unknown, fallback = Date.now()): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPlaudRecording(file: PlaudDeveloperFile) {
  const startTime = dateMs(file.start_at ?? file.created_at);
  const duration = numberValue(file.duration) ?? 0;
  const endTime = startTime + Math.max(0, duration);
  const updatedAt = dateMs(file.updated_at ?? file.created_at ?? file.start_at, startTime);
  const name = file.name || file.filename || file.id;

  return {
    id: file.id,
    filename: name,
    filesize:
      numberValue(file.filesize) ??
      numberValue(file.file_size) ??
      numberValue(file.size) ??
      0,
    file_md5: file.id,
    version_ms: updatedAt,
    is_trash: false,
    start_time: startTime,
    end_time: endTime,
    duration,
    timezone: 0,
    zonemins: 0,
    scene: 0,
    serial_number: file.serial_number ?? "",
    is_trans: false,
    is_summary: false
  };
}
