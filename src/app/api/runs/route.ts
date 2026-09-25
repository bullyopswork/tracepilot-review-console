import { NextResponse } from "next/server";
import { listRuns } from "@/lib/repository";
import { apiError, apiJson } from "@/lib/api";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let session;
  try {
    session = await resolveReviewSession(request);
    return apiJson({ runs: await listRuns(session.workspaceId) }, 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
