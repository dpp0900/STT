import { AppError, ErrorCode } from "@/lib/errors";
import { plaudFetch } from "@/lib/plaud/fetch";
import { safeParseJson } from "@/lib/plaud/parse";
import type {
  PlaudWorkspaceListResponse,
  PlaudWorkspaceTokenResponse
} from "@/lib/plaud/types";
import { isValidPlaudApiUrl } from "@/lib/plaud/servers";

function safePlaudUrl(apiBase: string, path: string): URL {
  if (!isValidPlaudApiUrl(apiBase)) {
    throw new AppError(
      ErrorCode.PlaudInvalidApiBase,
      "Invalid Plaud API base",
      400
    );
  }
  const parsed = new URL(path, apiBase);
  if (!isValidPlaudApiUrl(parsed.toString())) {
    throw new AppError(
      ErrorCode.PlaudInvalidApiBase,
      "Invalid Plaud API base",
      400
    );
  }
  return parsed;
}

export async function listPlaudWorkspaces(
  userToken: string,
  apiBase: string
): Promise<PlaudWorkspaceListResponse> {
  const url = safePlaudUrl(
    apiBase,
    "/team-app/workspaces/list?need_personal_workspace=true"
  );
  const response = await plaudFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? ErrorCode.PlaudUpstreamError : ErrorCode.PlaudApiError,
      "Failed to list Plaud workspaces",
      response.status >= 500 ? 502 : 400,
      { plaudStatus: response.status }
    );
  }

  const body = await safeParseJson<PlaudWorkspaceListResponse>(response);
  if (body.status !== 0 || !body.data?.workspaces) {
    throw new AppError(
      ErrorCode.PlaudApiError,
      body.msg || "Failed to list Plaud workspaces",
      400,
      { plaudStatus: body.status }
    );
  }
  return body;
}

export function pickPersonalWorkspaceId(response: PlaudWorkspaceListResponse): string {
  const workspaces = response.data?.workspaces ?? [];
  if (workspaces.length === 0) {
    throw new AppError(
      ErrorCode.PlaudWorkspaceUnavailable,
      "This Plaud account has no workspaces.",
      400
    );
  }
  return (
    workspaces.find((workspace) => workspace.workspace_type === "0") ??
    workspaces[0]
  ).workspace_id;
}

export async function mintPlaudWorkspaceToken(
  userToken: string,
  workspaceId: string,
  apiBase: string
): Promise<string> {
  const url = safePlaudUrl(
    apiBase,
    `/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`
  );
  const response = await plaudFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });

  if (!response.ok) {
    throw new WorkspaceTokenError("Failed to mint Plaud workspace token", {
      stale: response.status >= 400 && response.status < 500,
      plaudStatus: response.status
    });
  }

  const body = await safeParseJson<PlaudWorkspaceTokenResponse>(response);
  if (body.status !== 0 || !body.data?.workspace_token) {
    throw new WorkspaceTokenError(
      body.msg || "Failed to mint Plaud workspace token",
      { stale: true }
    );
  }
  return body.data.workspace_token;
}

export class WorkspaceTokenError extends AppError {
  readonly stale: boolean;

  constructor(
    message: string,
    options: { stale?: boolean; plaudStatus?: number } = {}
  ) {
    super(
      ErrorCode.PlaudWorkspaceUnavailable,
      message,
      400,
      options.plaudStatus ? { plaudStatus: options.plaudStatus } : undefined
    );
    this.name = "WorkspaceTokenError";
    this.stale = options.stale ?? false;
  }
}

export async function resolveWorkspaceToken(
  userToken: string,
  apiBase: string,
  cachedWorkspaceId?: string | null
): Promise<{ workspaceToken: string; workspaceId: string }> {
  if (cachedWorkspaceId) {
    try {
      const workspaceToken = await mintPlaudWorkspaceToken(
        userToken,
        cachedWorkspaceId,
        apiBase
      );
      return { workspaceToken, workspaceId: cachedWorkspaceId };
    } catch (error) {
      if (!(error instanceof WorkspaceTokenError) || !error.stale) throw error;
    }
  }

  const list = await listPlaudWorkspaces(userToken, apiBase);
  const workspaceId = pickPersonalWorkspaceId(list);
  const workspaceToken = await mintPlaudWorkspaceToken(
    userToken,
    workspaceId,
    apiBase
  );
  return { workspaceToken, workspaceId };
}
