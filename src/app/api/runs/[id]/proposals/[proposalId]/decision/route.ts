import { UUID_PATTERN } from "@/lib/constants";
import { ApiFailure, apiError, apiJson, readJsonObject, requireIdempotencyKey, requireOnlyKeys, requireSameOriginJsonRequest } from "@/lib/api";
import { decideProposal } from "@/lib/review-workflow";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; proposalId: string }>;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new ApiFailure(400, "invalid_body", `${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApiFailure(400, "invalid_body", `${label} must be 1–${maximum} printable characters.`);
  }
  return normalized;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, proposalId } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiJson({ error: { code: "invalid_run_id", message: "Run ID must be a UUID." } }, 400);
  if (!UUID_PATTERN.test(proposalId)) return apiJson({ error: { code: "invalid_proposal_id", message: "Proposal ID must be a UUID." } }, 400);

  let session;
  try {
    requireSameOriginJsonRequest(request);
    const body = await readJsonObject(request, 4096);
    requireOnlyKeys(body, ["action", "reason", "reviewer"]);
    if (body.action !== "approve" && body.action !== "reject") {
      throw new ApiFailure(400, "invalid_action", "Action must be approve or reject.");
    }
    const reason = boundedText(body.reason, "Reason", 1000);
    const reviewer = body.reviewer === undefined ? "Session reviewer" : boundedText(body.reviewer, "Reviewer", 120);
    const idempotencyKey = requireIdempotencyKey(request);
    session = await resolveReviewSession(request);
    const result = await decideProposal(id, proposalId, session.workspaceId, idempotencyKey, body.action, reason, reviewer);
    if (!result) {
      return apiJson({ error: { code: "run_not_found", message: "Run was not found in this review session." } }, 404, session);
    }
    return apiJson({ decision: result.decision, proposal: result.proposal }, result.created ? 201 : 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
