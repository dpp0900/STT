import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { errorBody, normalizeError } from "@/lib/errors";

export async function GET() {
  try {
    const user = await getSessionUser();
    return NextResponse.json({
      success: true,
      authenticated: Boolean(user),
      user: user ? { id: user } : null
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
