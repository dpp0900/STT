import { AppError, ErrorCode } from "@/lib/errors";

const BODY_SNIPPET_MAX = 200;

export async function safeParseJson<T>(response: Response): Promise<T> {
  const text = await response.text().catch(() => "");
  if (text.length > 0) {
    try {
      return JSON.parse(text) as T;
    } catch {
      // Fall through to typed error below.
    }
  }

  const status = response.status;
  if (status === 401) {
    throw new AppError(
      ErrorCode.PlaudInvalidToken,
      "Plaud rejected the access token. Sign in again.",
      401,
      { plaudStatus: status, bodySnippet: text.slice(0, BODY_SNIPPET_MAX) }
    );
  }
  if (status === 429) {
    throw new AppError(
      ErrorCode.PlaudRateLimited,
      "Plaud rate limited this request. Try again later.",
      429,
      { plaudStatus: status, bodySnippet: text.slice(0, BODY_SNIPPET_MAX) }
    );
  }
  if (status >= 500) {
    throw new AppError(
      ErrorCode.PlaudUpstreamError,
      "Plaud is temporarily unavailable.",
      502,
      { plaudStatus: status, bodySnippet: text.slice(0, BODY_SNIPPET_MAX) }
    );
  }

  throw new AppError(
    ErrorCode.PlaudApiError,
    `Plaud returned an unreadable response (HTTP ${status}).`,
    status >= 400 ? 400 : 502,
    { plaudStatus: status, bodySnippet: text.slice(0, BODY_SNIPPET_MAX) }
  );
}
