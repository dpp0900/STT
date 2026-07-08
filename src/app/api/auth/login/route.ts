import { NextResponse } from "next/server";
import { setSessionCookie, verifyLogin } from "@/lib/auth";
import { AppError, ErrorCode, errorBody, normalizeError } from "@/lib/errors";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      username?: unknown;
      password?: unknown;
    } | null;

    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      throw new AppError(
        ErrorCode.MissingRequiredField,
        "Enter ID and password.",
        400
      );
    }

    if (!verifyLogin(username, password)) {
      throw new AppError(
        ErrorCode.InvalidCredentials,
        "Invalid ID or password.",
        401
      );
    }

    const response = NextResponse.json({
      success: true,
      user: { id: username }
    });
    await setSessionCookie(response, username);
    return response;
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
