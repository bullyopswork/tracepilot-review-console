import { NextResponse } from "next/server";
import { attachReviewSession, type ReviewSession } from "@/lib/session";
import { ApiFailure } from "@/lib/errors";

export { ApiFailure } from "@/lib/errors";

export function apiJson(body: unknown, status = 200, session?: ReviewSession): Response {
  const response = NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
  return session ? attachReviewSession(response, session) : response;
}

export function apiError(error: unknown, session?: ReviewSession): Response {
  if (error instanceof ApiFailure) {
    return apiJson({ error: { code: error.code, message: error.message } }, error.status, session);
  }
  return apiJson({ error: { code: "database_unavailable", message: "The local review database is not ready." } }, 503, session);
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) {
    throw new ApiFailure(400, "invalid_idempotency_key", "Provide a valid Idempotency-Key header (1–120 letters, numbers, or . _ : - characters)." );
  }
  return value;
}

export function requireSameOriginJsonRequest(request: Request): void {
  const origin = request.headers.get("origin");
  let expectedOrigin: string;
  try {
    const requestUrl = new URL(request.url);
    // Next.js may normalize request.url to localhost in local development while
    // preserving the browser's actual destination in Host (for example 127.0.0.1).
    const host = request.headers.get("host");
    expectedOrigin = host
      ? new URL(`${requestUrl.protocol}//${host}`).origin
      : requestUrl.origin;
  } catch {
    throw new ApiFailure(400, "invalid_request_url", "The request URL is invalid.");
  }

  if (!origin || origin === "null" || origin !== expectedOrigin) {
    throw new ApiFailure(403, "same_origin_required", "Write requests must come from this site's origin.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() !== "same-origin") {
    throw new ApiFailure(403, "same_origin_required", "Write requests must come from this site's origin.");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiFailure(415, "json_required", "Write requests must use Content-Type: application/json.");
  }
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      throw new ApiFailure(413, "request_too_large", `Request body must be no larger than ${maximumBytes} bytes.`);
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiFailure(413, "request_too_large", `Request body must be no larger than ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiFailure(400, "invalid_json", "Request body must be valid UTF-8 JSON.");
  }
}

export async function readJsonObject(
  request: Request,
  maximumBytes: number,
  options: { allowEmpty?: boolean } = {}
): Promise<Record<string, unknown>> {
  const raw = await readBoundedBody(request, maximumBytes);
  if (!raw.trim() && options.allowEmpty) return {};
  if (!raw.trim()) throw new ApiFailure(400, "invalid_json", "A JSON object is required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiFailure(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiFailure(400, "invalid_body", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function requireOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ApiFailure(400, "unknown_field", `Unsupported request field: ${unknown}.`);
}

export function requireUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiFailure(400, "invalid_id", `${label} must be a UUID.`);
  }
}
