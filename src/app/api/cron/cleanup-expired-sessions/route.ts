import { timingSafeEqual } from "node:crypto";
import { apiError, apiJson } from "@/lib/api";
import { cleanupExpiredReviewSessions, MAX_EXPIRED_SESSION_CLEANUP_BATCH } from "@/lib/session-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasValidCronAuthorization(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return apiJson({ error: { code: "cron_auth_not_configured", message: "Scheduled cleanup is not configured." } }, 503);
  }
  if (!hasValidCronAuthorization(request, secret)) {
    return apiJson({ error: { code: "unauthorized", message: "A valid scheduled-task authorization is required." } }, 401);
  }

  try {
    const removed = await cleanupExpiredReviewSessions(MAX_EXPIRED_SESSION_CLEANUP_BATCH);
    return apiJson({ removed, batchLimit: MAX_EXPIRED_SESSION_CLEANUP_BATCH });
  } catch (error) {
    return apiError(error);
  }
}
