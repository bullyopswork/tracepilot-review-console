import { UUID_PATTERN } from "@/lib/constants";
import { apiError, apiJson, readJsonObject, requireIdempotencyKey, requireOnlyKeys, requireSameOriginJsonRequest } from "@/lib/api";
import { createProposal } from "@/lib/review-workflow";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return apiJson({ error: { code: "invalid_run_id", message: "Run ID must be a UUID." } }, 400);
  }

  let session;
  try {
    requireSameOriginJsonRequest(request);
    const body = await readJsonObject(request, 1024, { allowEmpty: true });
    requireOnlyKeys(body, []);
    const idempotencyKey = requireIdempotencyKey(request);
    session = await resolveReviewSession(request);
    const result = await createProposal(id, session.workspaceId, idempotencyKey);
    if (!result) {
      return apiJson({ error: { code: "run_not_found", message: "Run was not found in this review session." } }, 404, session);
    }
    return apiJson({ proposal: result.proposal }, result.created ? 201 : 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
