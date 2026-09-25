import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.INTEGRATION_BASE_URL ?? "http://127.0.0.1:3007";

type ResponseBody = Record<string, unknown>;

class DemoSession {
  private cookie = "";

  async request(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (options.method?.toUpperCase() === "POST" && !headers.has("Origin")) {
      headers.set("Origin", new URL(base).origin);
    }
    const response = await fetch(new URL(path, base), { ...options, headers, cache: "no-store" });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
    const body = (await response.json()) as ResponseBody;
    return { status: response.status, body };
  }

  post(path: string, body: object = {}) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    });
  }
}

async function main() {
  const session = new DemoSession();
  const list = await session.request("/api/runs");
  assert.equal(list.status, 200, "sample run list should load");
  const runs = list.body.runs as Array<{ id: string; status: string }>;
  assert.ok(Array.isArray(runs) && runs.length >= 2, "session should receive sample runs");
  const failed = runs.find((run) => run.status === "failed");
  assert.ok(failed, "failed fixture should be present");

  const detail = await session.request(`/api/runs/${failed.id}`);
  assert.equal(detail.status, 200, "failed run detail should load");
  const diagnosis = await session.post(`/api/runs/${failed.id}/diagnose`);
  assert.equal(diagnosis.status, 200, "diagnosis should persist");
  assert.equal((diagnosis.body.diagnosis as { failedCount: number }).failedCount, 4);

  const proposed = await session.post(`/api/runs/${failed.id}/proposals`);
  assert.ok([200, 201].includes(proposed.status), "proposal should be created");
  const proposal = proposed.body.proposal as { id: string; source: string; status: string };
  assert.equal(proposal.source, "deterministic_demo");
  assert.equal(proposal.status, "pending");

  const unapproved = await session.post(`/api/runs/${failed.id}/rerun`, { proposalId: proposal.id });
  assert.equal(unapproved.status, 409, "unapproved proposal must not run");

  const decided = await session.post(`/api/runs/${failed.id}/proposals/${proposal.id}/decision`, {
    action: "approve",
    reason: "The revised task explicitly covers the four missed constraints.",
    reviewer: "Integration reviewer",
  });
  assert.ok([200, 201].includes(decided.status), "review decision should persist");
  assert.equal((decided.body.proposal as { status: string }).status, "approved");

  const after = await session.post(`/api/runs/${failed.id}/rerun`, { proposalId: proposal.id });
  assert.ok([200, 201].includes(after.status), "approved proposal should produce a synthetic follow-up");
  assert.equal(after.body.source, "deterministic_demo");
  const afterRun = after.body.after as { id: string };
  assert.ok(afterRun.id, "follow-up run should have an ID");
  const compare = await session.request(`/api/runs/${failed.id}/compare?afterRunId=${afterRun.id}`);
  assert.equal(compare.status, 200, "persisted before/after comparison should reload");
  const scores = compare.body.comparison as { before: { score: number }; after: { score: number } };
  assert.ok(scores.after.score > scores.before.score, "fixture follow-up score should improve");

  const stranger = new DemoSession();
  const strangerList = await stranger.request("/api/runs");
  assert.equal(strangerList.status, 200);
  const crossSession = await stranger.request(`/api/runs/${failed.id}`);
  assert.equal(crossSession.status, 404, "another visitor must not see the first visitor's review");

  console.log("HTTP journey passed: session isolation, diagnosis, proposal, guarded approval, synthetic follow-up, persisted comparison.");
}

void main().catch((error) => {
  console.error("HTTP journey failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
