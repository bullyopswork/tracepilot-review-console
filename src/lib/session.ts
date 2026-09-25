import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEMO_WORKSPACE_ID } from "@/lib/constants";
import { getDatabase, type DbRow, type Queryable } from "@/lib/db";
import { ApiFailure } from "@/lib/errors";
import { cleanupExpiredReviewSessionsInTransaction, MAX_EXPIRED_SESSION_CLEANUP_BATCH } from "@/lib/session-cleanup";

export const REVIEW_SESSION_COOKIE = "tracepilot_review_session";
export const MAX_STORED_REVIEW_SESSIONS = 500;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ReviewSession {
  token: string;
  workspaceId: string;
  isNew: boolean;
}

interface TemplateRun extends DbRow {
  id: string;
  baseline_run_id: string | null;
  title: string;
  mode: "synthetic_demo";
  status: "failed" | "improved";
  prompt: string;
  answer: string;
  trace_facts: Record<string, unknown>;
  created_at: string | Date;
}

interface TemplateConstraint extends DbRow {
  id: string;
  position: number;
  label: string;
  rule_code: string;
  required_value: Record<string, unknown>;
}

interface TemplateCheck extends DbRow {
  constraint_id: string;
  result: "passed" | "failed";
  explanation: string;
  source: "seeded" | "deterministic_demo";
  evaluated_at: string | Date;
}

interface TemplateSpan extends DbRow {
  position: number;
  name: string;
  kind: string;
  summary: string;
  occurred_at: string | Date;
}

interface TemplateEvent extends DbRow {
  sequence: number;
  event_type: string;
  summary: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(request: Request): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() !== REVIEW_SESSION_COOKIE) continue;
    const value = cookie.slice(separator + 1).trim();
    return SESSION_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

async function copySyntheticFixtures(tx: Queryable, workspaceId: string): Promise<void> {
  const runResult = await tx.query<TemplateRun>(
    `SELECT id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at
     FROM runs WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
    [DEMO_WORKSPACE_ID]
  );
  const newRunIds = new Map<string, string>();

  for (const run of runResult.rows) {
    const newRunId = randomUUID();
    newRunIds.set(run.id, newRunId);
    await tx.query(
      `INSERT INTO runs (id, workspace_id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newRunId,
        workspaceId,
        run.baseline_run_id ? newRunIds.get(run.baseline_run_id) ?? null : null,
        run.title,
        run.mode,
        run.status,
        run.prompt,
        run.answer,
        run.trace_facts,
        run.created_at
      ]
    );

    const constraintResult = await tx.query<TemplateConstraint>(
      `SELECT id, position, label, rule_code, required_value
       FROM constraints WHERE run_id = $1 ORDER BY position ASC`,
      [run.id]
    );
    const constraintIds = new Map<string, string>();
    for (const constraint of constraintResult.rows) {
      const constraintId = randomUUID();
      constraintIds.set(constraint.id, constraintId);
      await tx.query(
        `INSERT INTO constraints (id, run_id, position, label, rule_code, required_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [constraintId, newRunId, constraint.position, constraint.label, constraint.rule_code, constraint.required_value]
      );
    }

    const checkResult = await tx.query<TemplateCheck>(
      `SELECT constraint_id, result, explanation, source, evaluated_at
       FROM check_results WHERE run_id = $1`,
      [run.id]
    );
    for (const check of checkResult.rows) {
      const constraintId = constraintIds.get(check.constraint_id);
      if (!constraintId) continue;
      await tx.query(
        `INSERT INTO check_results (run_id, constraint_id, result, explanation, source, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newRunId, constraintId, check.result, check.explanation, check.source, check.evaluated_at]
      );
    }

    const spanResult = await tx.query<TemplateSpan>(
      `SELECT position, name, kind, summary, occurred_at
       FROM run_spans WHERE run_id = $1 ORDER BY position ASC`,
      [run.id]
    );
    for (const span of spanResult.rows) {
      await tx.query(
        `INSERT INTO run_spans (id, run_id, position, name, kind, summary, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), newRunId, span.position, span.name, span.kind, span.summary, span.occurred_at]
      );
    }

    const eventResult = await tx.query<TemplateEvent>(
      `SELECT sequence, event_type, summary, payload, occurred_at
       FROM run_events WHERE run_id = $1 ORDER BY sequence ASC`,
      [run.id]
    );
    for (const event of eventResult.rows) {
      await tx.query(
        `INSERT INTO run_events (id, run_id, sequence, event_type, summary, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), newRunId, event.sequence, event.event_type, event.summary, event.payload, event.occurred_at]
      );
    }
  }
}

export async function resolveReviewSession(request: Request): Promise<ReviewSession> {
  const database = await getDatabase();
  const existingToken = cookieValue(request);
  if (existingToken) {
    const existing = await database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM review_sessions
       WHERE token_hash = $1 AND expires_at > now()`,
      [sha256(existingToken)]
    );
    if (existing.rows[0]) return { token: existingToken, workspaceId: existing.rows[0].workspace_id, isNew: false };
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const workspaceId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await database.transaction(async (tx) => {
    await tx.query("SELECT lock_id FROM review_session_capacity_lock WHERE lock_id = 1 FOR UPDATE");
    await cleanupExpiredReviewSessionsInTransaction(tx, MAX_EXPIRED_SESSION_CLEANUP_BATCH);
    const sessionCount = await tx.query<{ count: number | string }>(
      "SELECT count(*) AS count FROM review_sessions"
    );
    if (Number(sessionCount.rows[0]?.count ?? 0) >= MAX_STORED_REVIEW_SESSIONS) {
      throw new ApiFailure(503, "session_capacity_reached", "The public demo is at visitor capacity. Please try again later.");
    }

    await tx.query(
      `INSERT INTO workspaces (id, slug, name, created_at)
       VALUES ($1, $2, 'TracePilot Private Review Workspace', $3)`,
      [workspaceId, `review-${workspaceId}`, now]
    );
    await tx.query(
      `INSERT INTO review_sessions (token_hash, workspace_id, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $3, $4)`,
      [tokenHash, workspaceId, now, expiresAt]
    );
    await copySyntheticFixtures(tx, workspaceId);
  });
  return { token, workspaceId, isNew: true };
}

export function attachReviewSession(response: Response, session: ReviewSession): Response {
  if (!session.isNew) return response;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${REVIEW_SESSION_COOKIE}=${session.token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`
  );
  return response;
}
