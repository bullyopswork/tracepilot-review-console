import { UUID_PATTERN } from "@/lib/constants";
import { diagnoseRun } from "@/lib/repository";
import { apiError, apiJson, readJsonObject, requireOnlyKeys, requireSameOriginJsonRequest } from "@/lib/api";
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
    session = await resolveReviewSession(request);
    const result = await diagnoseRun(id, session.workspaceId);
    if (!result) {
      return apiJson({ error: { code: "run_not_found", message: "Run was not found in this review session." } }, 404, session);
    }
    return apiJson(result, 200, session);
  } catch (error) {
    return apiError(error, session);
  }
}
