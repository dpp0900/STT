export enum ErrorCode {
  InvalidInput = "INVALID_INPUT",
  MissingRequiredField = "MISSING_REQUIRED_FIELD",
  AuthRequired = "AUTH_REQUIRED",
  InvalidCredentials = "INVALID_CREDENTIALS",
  PlaudInvalidApiBase = "PLAUD_INVALID_API_BASE",
  PlaudInvalidToken = "PLAUD_INVALID_TOKEN",
  PlaudApiError = "PLAUD_API_ERROR",
  PlaudUpstreamError = "PLAUD_UPSTREAM_ERROR",
  PlaudRateLimited = "PLAUD_RATE_LIMITED",
  PlaudWorkspaceUnavailable = "PLAUD_WORKSPACE_UNAVAILABLE",
  NotConnected = "NOT_CONNECTED",
  NotFound = "NOT_FOUND",
  StorageError = "STORAGE_ERROR"
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(
      ErrorCode.PlaudUpstreamError,
      error.message || "Unexpected server error",
      500
    );
  }
  return new AppError(
    ErrorCode.PlaudUpstreamError,
    "Unexpected server error",
    500
  );
}

export function errorBody(error: unknown): {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
} {
  const appError = normalizeError(error);
  return {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {})
    }
  };
}
