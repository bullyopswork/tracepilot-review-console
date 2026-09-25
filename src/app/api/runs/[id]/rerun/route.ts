import { UUID_PATTERN } from "@/lib/constants";
import { ApiFailure, apiError, apiJson, readJsonObject, requireIdempotencyKey, requireOnlyKeys, requireSameOriginJsonRequest } from "@/lib/api";
import { executeSyntheticRerun } from "@/lib/review-workflow";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiJson({ error: { code: "invalid_run_id", message: "Run ID must be a UUID." } }, 400);

  let session;
  try {
    requireSameOriginJsonRequest(request);
    const body = await readJsonObject(request, 2048);
    requireOnlyKeys(body, ["proposalId"]);
    if (typeof body.proposalId !== "string" || !UUID_PATTERN.test(body.proposalId)) {
      throw new ApiFailure(400, "invalid_proposal_id", "proposalId must be a UUID.");
    }
    const idempotencyKey = requireIdempotencyKey(request);
    session = await resolveReviewSession(request);
    const result = await executeSyntheticRerun(id, body.proposalId, session.workspaceId, idempotencyKey);
    if (!result) {
      return apiJson({ error: { code: "run_not_found", message: "Run was not found in this review session." } }, 404, session);
    }
    return apiJson(result, result.created ? 201 : 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
