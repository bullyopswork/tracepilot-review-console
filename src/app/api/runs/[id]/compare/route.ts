import { UUID_PATTERN } from "@/lib/constants";
import { apiError, apiJson } from "@/lib/api";
import { compareSyntheticRuns } from "@/lib/review-workflow";
import { resolveReviewSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiJson({ error: { code: "invalid_run_id", message: "Run ID must be a UUID." } }, 400);
  const afterRunId = new URL(request.url).searchParams.get("afterRunId");
  if (!afterRunId || !UUID_PATTERN.test(afterRunId)) {
    return apiJson({ error: { code: "invalid_after_run_id", message: "Provide an afterRunId UUID query parameter." } }, 400);
  }

  let session;
  try {
    session = await resolveReviewSession(request);
    const result = await compareSyntheticRuns(id, afterRunId, session.workspaceId);
    if (!result) {
      return apiJson({ error: { code: "comparison_not_found", message: "This synthetic comparison was not found in the current review session." } }, 404, session);
    }
    return apiJson(result, 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
