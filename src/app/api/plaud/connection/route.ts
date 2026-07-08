import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readDb, updateDb } from "@/lib/db";
import { errorBody, normalizeError } from "@/lib/errors";

export async function GET() {
  try {
    await requireAuth();
    const db = await readDb();
    if (!db.connection) {
      return NextResponse.json({ success: true, connected: false });
    }
    const {
      encryptedAccessToken: _token,
      encryptedRefreshToken: _refreshToken,
      ...connection
    } = db.connection;
    return NextResponse.json({
      success: true,
      connected: true,
      connection,
      localRecordings: db.recordings.length,
      downloadedRecordings: db.recordings.filter((record) => record.storagePath).length
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}

export async function DELETE() {
  try {
    await requireAuth();
    await updateDb((db) => {
      db.connection = null;
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const normalized = normalizeError(error);
    return NextResponse.json(errorBody(normalized), {
      status: normalized.statusCode
    });
  }
}
