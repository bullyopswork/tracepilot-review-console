import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteTestDatabase, getDatabase, setDatabaseForTests, type Database } from "../src/lib/db";
import { applyMigrations, seedSyntheticDemo } from "../src/lib/migrations";
import { readJsonObject } from "../src/lib/api";
import { MAX_STORED_REVIEW_SESSIONS } from "../src/lib/session";
import { MAX_PROPOSALS_PER_RUN } from "../src/lib/review-workflow";
import { GET as cleanupExpiredSessions } from "../src/app/api/cron/cleanup-expired-sessions/route";
import { GET as listRuns } from "../src/app/api/runs/route";
import { GET as getRun } from "../src/app/api/runs/[id]/route";
import { POST as diagnoseRun } from "../src/app/api/runs/[id]/diagnose/route";
import { POST as createProposal } from "../src/app/api/runs/[id]/proposals/route";
import { POST as decideProposal } from "../src/app/api/runs/[id]/proposals/[proposalId]/decision/route";
import { POST as rerun } from "../src/app/api/runs/[id]/rerun/route";
import { GET as compare } from "../src/app/api/runs/[id]/compare/route";

let engine: PGlite;
let database: Database;
let cookie: string;
let failedRunId: string;
let improvedRunId: string;

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function decisionContext(id: string, proposalId: string) {
  return { params: Promise.resolve({ id, proposalId }) };
}

function request(path: string, options: {
  method?: string;
  cookie?: string;
  key?: string;
  body?: string;
  origin?: string | null;
  contentType?: string | null;
} = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.key) headers.set("Idempotency-Key", options.key);
  if (method === "POST" && options.origin !== null) headers.set("Origin", options.origin ?? "http://localhost");
  if (options.body !== undefined && options.contentType !== null) headers.set("Content-Type", options.contentType ?? "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body
  });
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected new session cookie");
  return value.split(";", 1)[0];
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

async function bootstrapSession(): Promise<{ cookie: string; runs: Array<Record<string, unknown>> }> {
  const response = await listRuns(request("/api/runs"));
  const body = await responseJson(response);
  return { cookie: cookieFrom(response), runs: body.runs as Array<Record<string, unknown>> };
}

async function createProposalFor(runId: string, sessionCookie = cookie, key = crypto.randomUUID()) {
  const response = await createProposal(
    request(`/api/runs/${runId}/proposals`, { method: "POST", cookie: sessionCookie, key, body: "{}" }),
    routeContext(runId)
  );
  return { response, body: await responseJson(response), key };
}

async function decideFor(
  runId: string,
  proposalId: string,
  sessionCookie: string,
  key: string,
  action: "approve" | "reject",
  reason = `Reviewed ${action} for synthetic demo`
) {
  const response = await decideProposal(
    request(`/api/runs/${runId}/proposals/${proposalId}/decision`, {
      method: "POST",
      cookie: sessionCookie,
      key,
      body: JSON.stringify({ action, reason })
    }),
    decisionContext(runId, proposalId)
  );
  return { response, body: await responseJson(response) };
}

async function rerunFor(runId: string, proposalId: string, sessionCookie: string, key: string) {
  const response = await rerun(
    request(`/api/runs/${runId}/rerun`, {
      method: "POST",
      cookie: sessionCookie,
      key,
      body: JSON.stringify({ proposalId })
    }),
    routeContext(runId)
  );
  return { response, body: await responseJson(response) };
}

beforeEach(async () => {
  engine = new PGlite();
  database = createPGliteTestDatabase(engine);
  setDatabaseForTests(database);
  await applyMigrations(database);
  await seedSyntheticDemo(database);
  const session = await bootstrapSession();
  cookie = session.cookie;
  failedRunId = String(session.runs.find((run) => run.status === "failed")?.id);
  improvedRunId = String(session.runs.find((run) => run.status === "improved")?.id);
});

afterEach(async () => {
  setDatabaseForTests(undefined);
  await database.close();
});

describe("session-scoped synthetic run API", () => {
  it("bootstraps a private workspace with copied fixtures while leaving shared seed fixtures intact", async () => {
    expect(failedRunId).not.toBe("00000000-0000-4000-8000-000000000002");
    expect(improvedRunId).not.toBe("00000000-0000-4000-8000-000000000003");
    const rows = await database.query<{ workspaces: string; runs: string; sessions: string }>(
      `SELECT
         (SELECT count(*)::text FROM workspaces) AS workspaces,
         (SELECT count(*)::text FROM runs) AS runs,
         (SELECT count(*)::text FROM review_sessions) AS sessions`
    );
    expect(rows.rows[0]).toEqual({ workspaces: "2", runs: "4", sessions: "1" });
    const cookieHeader = (await listRuns(request("/api/runs", { cookie }))).headers.get("set-cookie");
    expect(cookieHeader).toBeNull();
  });

  it("returns the cloned synthetic run detail and diagnoses its stored facts deterministically", async () => {
    const response = await getRun(request(`/api/runs/${failedRunId}`, { cookie }), routeContext(failedRunId));
    const body = await responseJson(response);
    const run = body.run as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(run).toMatchObject({ id: failedRunId, mode: "synthetic_demo", score: 20, status: "failed" });
    expect(String(run.answer)).toContain("June 11 to June 16");
    expect(run.constraints).toHaveLength(5);
    expect(run.spans).toHaveLength(3);
    expect(run.events).toHaveLength(2);
    expect(run.proposals).toEqual([]);
    expect(run.decisions).toEqual([]);

    const diagnosed = await diagnoseRun(
      request(`/api/runs/${failedRunId}/diagnose`, { method: "POST", cookie, body: "{}" }),
      routeContext(failedRunId)
    );
    const diagnosisBody = await responseJson(diagnosed);
    expect(diagnosed.status).toBe(200);
    expect(diagnosisBody.diagnosis).toMatchObject({ score: 20, passedCount: 1, failedCount: 4 });
    expect((diagnosisBody.diagnosis as Record<string, unknown>).failedChecks).toHaveLength(4);
    expect((diagnosisBody.run as Record<string, unknown>).score).toBe(20);
  });

  it("does not seed the demo fixture on GET when the database has not been seeded", async () => {
    const emptyEngine = new PGlite();
    const emptyDatabase = createPGliteTestDatabase(emptyEngine);
    try {
      await applyMigrations(emptyDatabase);
      setDatabaseForTests(emptyDatabase);
      const response = await listRuns(request("/api/runs"));
      const body = await responseJson(response);
      expect(response.status).toBe(200);
      expect(body.runs).toEqual([]);
      const counts = await emptyDatabase.query<{ workspaces: string; runs: string; sessions: string }>(
        `SELECT
           (SELECT count(*)::text FROM workspaces) AS workspaces,
           (SELECT count(*)::text FROM runs) AS runs,
           (SELECT count(*)::text FROM review_sessions) AS sessions`
      );
      expect(counts.rows[0]).toEqual({ workspaces: "1", runs: "0", sessions: "1" });
    } finally {
      setDatabaseForTests(database);
      await emptyDatabase.close();
    }
  });

  it("keeps proposals, decisions, and after-runs isolated between visitor sessions", async () => {
    const secondSession = await bootstrapSession();
    const secondFailedId = String(secondSession.runs.find((run) => run.status === "failed")?.id);
    expect(secondFailedId).not.toBe(failedRunId);

    const proposal = await createProposalFor(failedRunId);
    expect(proposal.response.status).toBe(201);
    const proposalBody = proposal.body.proposal as Record<string, unknown>;
    expect(proposalBody).toMatchObject({ source: "deterministic_demo", status: "pending", afterRunId: null });
    expect(String(proposalBody.proposedTask)).toContain("Deterministic demo revision");
    const decision = await decideFor(failedRunId, String(proposalBody.id), cookie, "session-a-approve-01", "approve");
    expect(decision.response.status).toBe(201);

    const isolatedDetail = await getRun(
      request(`/api/runs/${secondFailedId}`, { cookie: secondSession.cookie }),
      routeContext(secondFailedId)
    );
    expect(isolatedDetail.status).toBe(200);
    expect((await responseJson(isolatedDetail)).run).toMatchObject({ proposals: [], decisions: [], events: expect.any(Array) });
    const crossSessionLookup = await getRun(
      request(`/api/runs/${failedRunId}`, { cookie: secondSession.cookie }),
      routeContext(failedRunId)
    );
    expect(crossSessionLookup.status).toBe(404);
  });

  it("supports idempotent proposal creation and ensures approval is not execution", async () => {
    const first = await createProposalFor(failedRunId, cookie, "proposal-key-0001");
    const second = await createProposalFor(failedRunId, cookie, "proposal-key-0001");
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(200);
    const proposal = first.body.proposal as Record<string, unknown>;
    expect((second.body.proposal as Record<string, unknown>).id).toBe(proposal.id);

    const approved = await decideFor(failedRunId, String(proposal.id), cookie, "approve-key-0001", "approve", "Reviewed constraints and approve");
    expect(approved.response.status).toBe(201);
    expect((approved.body.proposal as Record<string, unknown>).status).toBe("approved");
    const runs = await responseJson(await listRuns(request("/api/runs", { cookie })));
    expect(runs.runs).toHaveLength(2);
    const detail = await responseJson(await getRun(request(`/api/runs/${failedRunId}`, { cookie }), routeContext(failedRunId)));
    const run = detail.run as Record<string, unknown>;
    expect(run.proposals).toMatchObject([{ id: proposal.id, status: "approved", afterRunId: null }]);
    expect(run.decisions).toMatchObject([{ proposalId: proposal.id, action: "approved", reason: "Reviewed constraints and approve" }]);
    expect(run.events).toHaveLength(4);
  });

  it("caps proposal growth per run while keeping idempotent replays available", async () => {
    const proposals = [];
    for (let index = 0; index < MAX_PROPOSALS_PER_RUN; index += 1) {
      const created = await createProposalFor(failedRunId, cookie, `proposal-cap-${index}`);
      expect(created.response.status).toBe(201);
      proposals.push(created);
    }
    expect(String((proposals[0].body.proposal as Record<string, unknown>).proposedTask)).toContain(
      "Generated as a proposal for human review; current workflow status is shown separately."
    );
    expect(String((proposals[0].body.proposal as Record<string, unknown>).proposedTask)).not.toContain(
      "This proposal has not been approved, executed, or verified."
    );

    const replay = await createProposalFor(failedRunId, cookie, "proposal-cap-0");
    expect(replay.response.status).toBe(200);
    const capped = await createProposalFor(failedRunId, cookie, "proposal-cap-overflow");
    expect(capped.response.status).toBe(409);
    expect(capped.body.error).toMatchObject({ code: "proposal_limit_reached" });
    const count = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM proposals WHERE run_id = $1",
      [failedRunId]
    );
    expect(count.rows[0]?.count).toBe(String(MAX_PROPOSALS_PER_RUN));
  });

  it("rejects rejected proposals and never creates their rerun", async () => {
    const proposalResult = await createProposalFor(failedRunId);
    const proposalId = String((proposalResult.body.proposal as Record<string, unknown>).id);
    const rejected = await decideFor(failedRunId, proposalId, cookie, "reject-key-0001", "reject", "The revised request is not acceptable");
    expect(rejected.response.status).toBe(201);
    expect((rejected.body.proposal as Record<string, unknown>).status).toBe("rejected");

    const attempt = await rerunFor(failedRunId, proposalId, cookie, "rerun-rejected-01");
    expect(attempt.response.status).toBe(409);
    expect(attempt.body.error).toMatchObject({ code: "proposal_rejected" });
    const runs = await responseJson(await listRuns(request("/api/runs", { cookie })));
    expect(runs.runs).toHaveLength(2);
  });

  it("creates one labeled deterministic after-run, compares it, and restores comparison after reload", async () => {
    const proposalResult = await createProposalFor(failedRunId);
    const proposalId = String((proposalResult.body.proposal as Record<string, unknown>).id);
    const approve = await decideFor(failedRunId, proposalId, cookie, "approve-before-rerun", "approve", "The deterministic correction is acceptable");
    expect(approve.response.status).toBe(201);

    const [first, duplicate] = await Promise.all([
      rerunFor(failedRunId, proposalId, cookie, "rerun-key-0001"),
      rerunFor(failedRunId, proposalId, cookie, "rerun-key-0001")
    ]);
    expect([first.response.status, duplicate.response.status].sort()).toEqual([200, 201]);
    expect(first.body.source).toBe("deterministic_demo");
    const after = first.body.after as Record<string, unknown>;
    const comparisonResult = first.body.comparison as Record<string, unknown>;
    expect(after).toMatchObject({ baselineRunId: failedRunId, status: "improved", score: 100 });
    expect(String(after.answer)).toContain("No model, agent");
    expect(comparisonResult).toMatchObject({
      before: { score: 20, failedCount: 4 },
      after: { score: 100, failedCount: 0 }
    });
    expect(comparisonResult.checks).toHaveLength(5);
    expect((duplicate.body.after as Record<string, unknown>).id).toBe(after.id);

    const detail = await responseJson(await getRun(request(`/api/runs/${failedRunId}`, { cookie }), routeContext(failedRunId)));
    expect((detail.run as Record<string, unknown>).proposals).toMatchObject([{ id: proposalId, status: "executed", afterRunId: after.id }]);
    const restored = await compare(
      request(`/api/runs/${failedRunId}/compare?afterRunId=${after.id}`, { cookie }),
      routeContext(failedRunId)
    );
    expect(restored.status).toBe(200);
    expect((await responseJson(restored)).comparison).toMatchObject(comparisonResult);

    const runs = await responseJson(await listRuns(request("/api/runs", { cookie })));
    expect(runs.runs).toHaveLength(3);
    const executions = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM rerun_executions");
    expect(executions.rows[0]?.count).toBe("1");
  });

  it("rejects competing decisions and same-key payload changes without duplicating history", async () => {
    const proposalResult = await createProposalFor(failedRunId);
    const proposalId = String((proposalResult.body.proposal as Record<string, unknown>).id);
    const [approved, rejected] = await Promise.all([
      decideFor(failedRunId, proposalId, cookie, "race-approve-0001", "approve", "Approval from one tab"),
      decideFor(failedRunId, proposalId, cookie, "race-reject-0001", "reject", "Rejection from another tab")
    ]);
    expect([approved.response.status, rejected.response.status].sort()).toEqual([201, 409]);
    const count = await database.query<{ decisions: string }>(
      "SELECT count(*)::text AS decisions FROM decisions WHERE proposal_id = $1",
      [proposalId]
    );
    expect(count.rows[0]?.decisions).toBe("1");

    const winnerAction = approved.response.status === 201 ? "approve" : "reject";
    const winnerReason = winnerAction === "approve" ? "Approval from one tab" : "Rejection from another tab";
    const replay = await decideFor(
      failedRunId,
      proposalId,
      cookie,
      winnerAction === "approve" ? "race-approve-0001" : "race-reject-0001",
      winnerAction,
      winnerReason
    );
    expect(replay.response.status).toBe(200);
    const changed = await decideFor(
      failedRunId,
      proposalId,
      cookie,
      winnerAction === "approve" ? "race-approve-0001" : "race-reject-0001",
      winnerAction,
      "Changed reason for same idempotency key"
    );
    expect(changed.response.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: "idempotency_conflict" });
  });

  it("validates bounded inputs and route IDs", async () => {
    const malformed = await getRun(request("/api/runs/nope"), routeContext("nope"));
    expect(malformed.status).toBe(400);

    const noKey = await createProposal(
      request(`/api/runs/${failedRunId}/proposals`, { method: "POST", cookie, body: "{}" }),
      routeContext(failedRunId)
    );
    expect(noKey.status).toBe(400);
    expect((await responseJson(noKey)).error).toMatchObject({ code: "invalid_idempotency_key" });

    const large = await createProposal(
      request(`/api/runs/${failedRunId}/proposals`, { method: "POST", cookie, key: "large-body-0001", body: JSON.stringify({ input: "x".repeat(2048) }) }),
      routeContext(failedRunId)
    );
    expect(large.status).toBe(413);
  });

  it("rejects cross-origin and non-JSON write requests before creating session state", async () => {
    const crossOrigin = await createProposal(
      request(`/api/runs/${failedRunId}/proposals`, {
        method: "POST",
        key: "cross-origin-0001",
        body: "{}",
        origin: "https://attacker.example"
      }),
      routeContext(failedRunId)
    );
    expect(crossOrigin.status).toBe(403);
    expect((await responseJson(crossOrigin)).error).toMatchObject({ code: "same_origin_required" });

    const noOrigin = await createProposal(
      request(`/api/runs/${failedRunId}/proposals`, {
        method: "POST",
        key: "no-origin-0001",
        body: "{}",
        origin: null
      }),
      routeContext(failedRunId)
    );
    expect(noOrigin.status).toBe(403);
    expect((await responseJson(noOrigin)).error).toMatchObject({ code: "same_origin_required" });

    const noContentType = await createProposal(
      request(`/api/runs/${failedRunId}/proposals`, {
        method: "POST",
        cookie,
        key: "wrong-type-0001",
        body: "{}",
        contentType: null
      }),
      routeContext(failedRunId)
    );
    expect(noContentType.status).toBe(415);
    expect((await responseJson(noContentType)).error).toMatchObject({ code: "json_required" });
    expect(noContentType.headers.get("set-cookie")).toBeNull();
  });

  it("stops reading a streamed JSON body as soon as it crosses its byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel() {
        cancelled = true;
      }
    });
    const streamed = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readJsonObject(streamed, 1024)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large"
    });
    expect(cancelled).toBe(true);
  });

  it("enforces the hard cap on retained anonymous sessions", async () => {
    const workspaceIds = Array.from({ length: MAX_STORED_REVIEW_SESSIONS - 1 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    const tokenHashes = workspaceIds.map((_, index) => `a${String(index).padStart(63, "0")}`);
    const slugs = workspaceIds.map((_, index) => `capacity-test-${index}`);
    await database.query(
      `INSERT INTO workspaces (id, slug, name, created_at)
       SELECT items.id::uuid, items.slug, 'Capacity test workspace', now()
       FROM unnest($1::text[], $2::text[]) AS items(id, slug)`,
      [workspaceIds, slugs]
    );
    await database.query(
      `INSERT INTO review_sessions (token_hash, workspace_id, created_at, last_seen_at, expires_at)
       SELECT items.token_hash, items.workspace_id::uuid, now(), now(), now() + interval '1 day'
       FROM unnest($1::text[], $2::text[]) AS items(token_hash, workspace_id)`,
      [tokenHashes, workspaceIds]
    );

    const full = await listRuns(request("/api/runs", { cookie: "tracepilot_review_session=invalid-session-token" }));
    expect(full.status).toBe(503);
    expect((await responseJson(full)).error).toMatchObject({ code: "session_capacity_reached" });
    const count = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM review_sessions");
    expect(count.rows[0]?.count).toBe(String(MAX_STORED_REVIEW_SESSIONS));
  });

  it("disables local PGlite fallback in production even when explicitly requested", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalLocalDb = process.env.TRACEPILOT_LOCAL_DB;
    setDatabaseForTests(undefined);
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DATABASE_URL;
    process.env.TRACEPILOT_LOCAL_DB = "true";
    try {
      await expect(getDatabase()).rejects.toThrow(/DATABASE_URL is required in production/i);
    } finally {
      vi.unstubAllEnvs();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalLocalDb === undefined) delete process.env.TRACEPILOT_LOCAL_DB;
      else process.env.TRACEPILOT_LOCAL_DB = originalLocalDb;
      setDatabaseForTests(database);
    }
  });

  it("protects the bounded expiry cleanup endpoint and purges only expired sessions", async () => {
    const originalSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron-secret";
    try {
      await database.query("UPDATE review_sessions SET expires_at = now() - interval '1 second'");
      const denied = await cleanupExpiredSessions(new Request("http://localhost/api/cron/cleanup-expired-sessions"));
      expect(denied.status).toBe(401);

      const authorized = await cleanupExpiredSessions(new Request("http://localhost/api/cron/cleanup-expired-sessions", {
        headers: { Authorization: "Bearer test-cron-secret" }
      }));
      expect(authorized.status).toBe(200);
      expect(await responseJson(authorized)).toMatchObject({ removed: 1, batchLimit: 100 });
      const counts = await database.query<{ sessions: string; workspaces: string }>(
        `SELECT
           (SELECT count(*)::text FROM review_sessions) AS sessions,
           (SELECT count(*)::text FROM workspaces) AS workspaces`
      );
      expect(counts.rows[0]).toEqual({ sessions: "0", workspaces: "1" });
    } finally {
      if (originalSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalSecret;
    }
  });

  it("enforces append-only run/event/decision/execution history and guarded proposal transitions", async () => {
    const proposalResult = await createProposalFor(failedRunId);
    const proposalId = String((proposalResult.body.proposal as Record<string, unknown>).id);
    await decideFor(failedRunId, proposalId, cookie, "immutable-approve-01", "approve");
    const rerunResult = await rerunFor(failedRunId, proposalId, cookie, "immutable-rerun-01");
    expect(rerunResult.response.status).toBe(201);

    await expect(database.query("UPDATE runs SET answer = 'changed' WHERE id = $1", [failedRunId])).rejects.toThrow(/immutable/i);
    await expect(database.query("DELETE FROM run_events WHERE run_id = $1", [failedRunId])).rejects.toThrow(/immutable/i);
    await expect(database.query("DELETE FROM decisions WHERE proposal_id = $1", [proposalId])).rejects.toThrow(/immutable/i);
    await expect(database.query("DELETE FROM rerun_executions WHERE proposal_id = $1", [proposalId])).rejects.toThrow(/immutable/i);
    await expect(database.query("UPDATE proposals SET proposed_task = 'tampered' WHERE id = $1", [proposalId])).rejects.toThrow(/immutable/i);
    await expect(database.query("UPDATE proposals SET status = 'rejected' WHERE id = $1", [proposalId])).rejects.toThrow(/invalid proposal status transition/i);
  });
});
