import { NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/constants";
import { getRunDetail } from "@/lib/repository";
import { apiError, apiJson } from "@/lib/api";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return apiJson({ error: { code: "invalid_run_id", message: "Run ID must be a UUID." } }, 400);
  }

  let session;
  try {
    session = await resolveReviewSession(_request);
    const run = await getRunDetail(id, session.workspaceId);
    if (!run) {
      return apiJson({ error: { code: "run_not_found", message: "Run was not found in this review session." } }, 404, session);
    }
    return apiJson({ run }, 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
