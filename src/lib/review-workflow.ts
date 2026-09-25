import { randomUUID } from "node:crypto";
import { evaluateConstraints, scoreChecks, type ConstraintInput, type RuleCode, type TraceFacts } from "@/lib/diagnosis";
import { ApiFailure } from "@/lib/api";
import { getDatabase, type DbRow, type Queryable } from "@/lib/db";
import { getRunDetail, type DecisionSummary, type ProposalSummary, type RunDetail } from "@/lib/repository";

interface RunWorkflowRow extends DbRow {
  id: string;
  title: string;
  status: "failed" | "improved";
  prompt: string;
  answer: string;
  trace_facts: TraceFacts;
}

interface ConstraintWorkflowRow extends DbRow {
  id: string;
  position: number;
  label: string;
  rule_code: RuleCode;
  required_value: Record<string, unknown>;
  result?: "passed" | "failed" | null;
  explanation?: string | null;
}

interface ProposalWorkflowRow extends DbRow {
  id: string;
  run_id: string;
  workspace_id: string;
  version: number;
  source: "deterministic_demo" | "gemini";
  proposed_task: string;
  status: "pending" | "approved" | "rejected" | "executed";
  idempotency_key: string;
  after_run_id?: string | null;
  created_at: string | Date;
}

interface DecisionWorkflowRow extends DbRow {
  id: string;
  proposal_id: string;
  action: "approved" | "rejected";
  reason: string;
  reviewer: string;
  idempotency_key: string;
  created_at: string | Date;
}

interface ExecutionWorkflowRow extends DbRow {
  id: string;
  baseline_run_id: string;
  proposal_id: string;
  after_run_id: string;
  idempotency_key: string;
}

export const MAX_PROPOSALS_PER_RUN = 5;

function isoDate(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function proposalSummary(row: ProposalWorkflowRow): ProposalSummary {
  return {
    id: row.id,
    runId: row.run_id,
    version: row.version,
    source: row.source,
    proposedTask: row.proposed_task,
    status: row.status,
    afterRunId: row.after_run_id ?? null,
    createdAt: isoDate(row.created_at)
  };
}

function decisionSummary(row: DecisionWorkflowRow): DecisionSummary {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    action: row.action,
    reason: row.reason,
    reviewer: row.reviewer,
    createdAt: isoDate(row.created_at)
  };
}

async function appendEvent(
  tx: Queryable,
  runId: string,
  eventType: string,
  summary: string,
  payload: Record<string, unknown>
): Promise<void> {
  const current = await tx.query<{ next_sequence: number }>(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = $1",
    [runId]
  );
  await tx.query(
    `INSERT INTO run_events (id, run_id, sequence, event_type, summary, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), runId, Number(current.rows[0]?.next_sequence ?? 1), eventType, summary, payload, new Date()]
  );
}

function proposalTask(prompt: string, failedLabels: string[]): string {
  const instruction = failedLabels.length
    ? `Before presenting a plan, explicitly verify these missed constraints from the synthetic trace: ${failedLabels.join("; ")}. Do not infer accessibility, price, or availability when evidence is missing; state uncertainty instead.`
    : "Before presenting a plan, explicitly verify each requested constraint from the synthetic trace and state uncertainty when evidence is missing.";
  const note = "\n\nDeterministic demo revision (proposal only): ";
  const suffix = `${note}${instruction}\nGenerated as a proposal for human review; current workflow status is shown separately.`;
  if (prompt.length + suffix.length > 8000) {
    throw new ApiFailure(422, "proposal_too_large", "The source task is too long to fit a bounded proposal.");
  }
  return `${prompt}${suffix}`;
}

export async function createProposal(
  runId: string,
  workspaceId: string,
  idempotencyKey: string
): Promise<{ proposal: ProposalSummary; created: boolean } | null> {
  const database = await getDatabase();
  return database.transaction(async (tx) => {
    const runResult = await tx.query<RunWorkflowRow>(
      `SELECT id, title, status, prompt, answer, trace_facts
       FROM runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [runId, workspaceId]
    );
    const run = runResult.rows[0];
    if (!run) return null;

    const existing = await tx.query<ProposalWorkflowRow>(
      `SELECT id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at
       FROM proposals WHERE run_id = $1 AND workspace_id = $2 AND idempotency_key = $3`,
      [runId, workspaceId, idempotencyKey]
    );
    if (existing.rows[0]) return { proposal: proposalSummary(existing.rows[0]), created: false };

    const proposalCount = await tx.query<{ count: number | string }>(
      "SELECT count(*) AS count FROM proposals WHERE run_id = $1 AND workspace_id = $2",
      [runId, workspaceId]
    );
    if (Number(proposalCount.rows[0]?.count ?? 0) >= MAX_PROPOSALS_PER_RUN) {
      throw new ApiFailure(409, "proposal_limit_reached", `A run can have at most ${MAX_PROPOSALS_PER_RUN} proposals in this review session.`);
    }

    const constraintResult = await tx.query<ConstraintWorkflowRow>(
      `SELECT c.id, c.position, c.label, c.rule_code, c.required_value,
              cr.result, cr.explanation
       FROM constraints c
       LEFT JOIN check_results cr ON cr.run_id = c.run_id AND cr.constraint_id = c.id
       WHERE c.run_id = $1 ORDER BY c.position ASC`,
      [runId]
    );
    const evaluated = evaluateConstraints(
      constraintResult.rows.map((row) => ({
        id: row.id,
        label: row.label,
        position: row.position,
        rule_code: row.rule_code,
        required_value: row.required_value
      } satisfies ConstraintInput)),
      run.trace_facts
    );
    const failedLabels = evaluated.filter((check) => !check.passed).map((check) => check.label);
    if (!failedLabels.length) {
      throw new ApiFailure(409, "no_failed_constraints", "This run has no failed constraints to address with a proposal.");
    }
    const task = proposalTask(run.prompt, failedLabels);
    const versionResult = await tx.query<{ next_version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM proposals WHERE run_id = $1",
      [runId]
    );
    const version = Number(versionResult.rows[0]?.next_version ?? 1);
    const proposalId = randomUUID();
    const createdAt = new Date();
    const inserted = await tx.query<ProposalWorkflowRow>(
      `INSERT INTO proposals (id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 'deterministic_demo', $5, 'pending', $6, $7)
       RETURNING id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at`,
      [proposalId, runId, workspaceId, version, task, idempotencyKey, createdAt]
    );
    await appendEvent(tx, runId, "proposal_created", `Deterministic demo proposal v${version} created for human review.`, {
      proposalId,
      source: "deterministic_demo",
      status: "pending"
    });
    return { proposal: proposalSummary(inserted.rows[0]), created: true };
  });
}

export async function decideProposal(
  runId: string,
  proposalId: string,
  workspaceId: string,
  idempotencyKey: string,
  action: "approve" | "reject",
  reason: string,
  reviewer: string
): Promise<{ decision: DecisionSummary; proposal: ProposalSummary; created: boolean } | null> {
  const database = await getDatabase();
  return database.transaction(async (tx) => {
    const run = await tx.query<{ id: string }>(
      "SELECT id FROM runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
      [runId, workspaceId]
    );
    if (!run.rows[0]) return null;

    const existing = await tx.query<DecisionWorkflowRow>(
      `SELECT id, proposal_id, action, reason, reviewer, idempotency_key, created_at
       FROM decisions WHERE proposal_id = $1 AND run_id = $2 AND workspace_id = $3 AND idempotency_key = $4`,
      [proposalId, runId, workspaceId, idempotencyKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.action !== (action === "approve" ? "approved" : "rejected") || row.reason !== reason || row.reviewer !== reviewer) {
        throw new ApiFailure(409, "idempotency_conflict", "This Idempotency-Key was already used for a different decision.");
      }
      const proposalResult = await tx.query<ProposalWorkflowRow>(
        `SELECT id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at
         FROM proposals WHERE id = $1 AND run_id = $2 AND workspace_id = $3`,
        [proposalId, runId, workspaceId]
      );
      return { decision: decisionSummary(row), proposal: proposalSummary(proposalResult.rows[0]), created: false };
    }

    const proposalResult = await tx.query<ProposalWorkflowRow>(
      `SELECT id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at
       FROM proposals WHERE id = $1 AND run_id = $2 AND workspace_id = $3`,
      [proposalId, runId, workspaceId]
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) throw new ApiFailure(404, "proposal_not_found", "Proposal was not found in this review session.");
    if (proposal.status !== "pending") {
      throw new ApiFailure(409, "proposal_already_decided", `This proposal is already ${proposal.status}; it cannot receive another decision.`);
    }

    const nextStatus = action === "approve" ? "approved" : "rejected";
    const updated = await tx.query<ProposalWorkflowRow>(
      `UPDATE proposals SET status = $1
       WHERE id = $2 AND run_id = $3 AND workspace_id = $4 AND status = 'pending'
       RETURNING id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at`,
      [nextStatus, proposalId, runId, workspaceId]
    );
    if (!updated.rows[0]) throw new ApiFailure(409, "proposal_already_decided", "This proposal has already received a decision.");

    const decisionId = randomUUID();
    const createdAt = new Date();
    const inserted = await tx.query<DecisionWorkflowRow>(
      `INSERT INTO decisions (id, proposal_id, run_id, workspace_id, action, reason, reviewer, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, proposal_id, action, reason, reviewer, idempotency_key, created_at`,
      [decisionId, proposalId, runId, workspaceId, nextStatus, reason, reviewer, idempotencyKey, createdAt]
    );
    const actionPast = action === "approve" ? "approved" : "rejected";
    await appendEvent(tx, runId, `proposal_${actionPast}`, `A human reviewer ${actionPast} deterministic demo proposal v${proposal.version}.`, {
      proposalId,
      decisionId,
      action: nextStatus
    });
    return {
      decision: decisionSummary(inserted.rows[0]),
      proposal: proposalSummary(updated.rows[0]),
      created: true
    };
  });
}

function boundedFacts(value: TraceFacts): TraceFacts {
  const allowed = new Set([
    "destination",
    "proposed_start_date",
    "proposed_end_date",
    "quoted_total_usd",
    "step_free_supported",
    "trip_type"
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function simulatedFacts(baselineFacts: TraceFacts, constraints: ConstraintWorkflowRow[]): TraceFacts {
  const facts = boundedFacts(baselineFacts);
  for (const constraint of constraints) {
    const required = constraint.required_value;
    switch (constraint.rule_code) {
      case "destination_match":
        if (typeof required.destination === "string") facts.destination = required.destination;
        break;
      case "dates_exact":
        if (typeof required.start === "string") facts.proposed_start_date = required.start;
        if (typeof required.end === "string") facts.proposed_end_date = required.end;
        break;
      case "budget_max":
        if (typeof required.max_usd === "number" && Number.isFinite(required.max_usd) && required.max_usd >= 0) {
          facts.quoted_total_usd = Math.max(0, required.max_usd - Math.min(50, required.max_usd * 0.05));
        }
        break;
      case "accessible_route":
        if (required.required === true) facts.step_free_supported = true;
        break;
      case "round_trip":
        if (required.trip_type === "round_trip") facts.trip_type = "round_trip";
        break;
    }
  }
  return facts;
}

async function insertChildRun(
  tx: Queryable,
  workspaceId: string,
  baseline: RunWorkflowRow,
  proposal: ProposalWorkflowRow,
  constraints: ConstraintWorkflowRow[]
): Promise<string> {
  const facts = simulatedFacts(baseline.trace_facts, constraints);
  const inputs = constraints.map((constraint) => ({
    id: constraint.id,
    label: constraint.label,
    position: constraint.position,
    rule_code: constraint.rule_code,
    required_value: constraint.required_value
  } satisfies ConstraintInput));
  const checks = evaluateConstraints(inputs, facts);
  const now = new Date();
  const runId = randomUUID();
  const title = `Simulated after-run — ${baseline.title}`.slice(0, 180);
  const answer = "Deterministic synthetic simulation: the proposed task was applied to fictional normalized facts and checks were recomputed. No model, agent, booking, or external service was called.";
  await tx.query(
    `INSERT INTO runs (id, workspace_id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at)
     VALUES ($1, $2, $3, $4, 'synthetic_demo', $5, $6, $7, $8, $9)`,
    [runId, workspaceId, baseline.id, title, checks.every((check) => check.passed) ? "improved" : "failed", proposal.proposed_task, answer, facts, now]
  );

  const copiedConstraintIds = new Map<string, string>();
  for (const constraint of constraints) {
    const id = randomUUID();
    copiedConstraintIds.set(constraint.id, id);
    await tx.query(
      `INSERT INTO constraints (id, run_id, position, label, rule_code, required_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, runId, constraint.position, constraint.label, constraint.rule_code, constraint.required_value]
    );
  }
  for (const check of checks) {
    const constraintId = copiedConstraintIds.get(check.id);
    if (!constraintId) continue;
    await tx.query(
      `INSERT INTO check_results (run_id, constraint_id, result, explanation, source, evaluated_at)
       VALUES ($1, $2, $3, $4, 'deterministic_demo', $5)`,
      [runId, constraintId, check.passed ? "passed" : "failed", check.explanation, now]
    );
  }

  const spans = [
    ["Reviewed approved proposal", "check", "A human-approved deterministic proposal was selected for a synthetic-only rerun."],
    ["Resolve fictional trace facts", "check", "Allowlisted synthetic facts were adjusted to match explicit task constraints."],
    ["Recompute constraint checks", "check", "Deterministic rules produced the after-run score; no model or external tool was called."]
  ] as const;
  for (const [index, [name, kind, summary]] of spans.entries()) {
    await tx.query(
      `INSERT INTO run_spans (id, run_id, position, name, kind, summary, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), runId, index, name, kind, summary, new Date(now.getTime() + index * 1000)]
    );
  }
  await appendEvent(tx, runId, "synthetic_rerun_created", "A deterministic synthetic after-run was created from the approved proposal.", {
    proposalId: proposal.id,
    source: "deterministic_demo"
  });
  return runId;
}

function comparison(before: RunDetail, after: RunDetail) {
  return {
    before: { score: before.score, failedCount: before.failedCount },
    after: { score: after.score, failedCount: after.failedCount },
    checks: before.constraints.map((check, index) => ({
      id: check.id,
      label: check.label,
      before: check.passed ? "passed" as const : "failed" as const,
      after: after.constraints[index]?.passed ? "passed" as const : "failed" as const
    }))
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

export async function executeSyntheticRerun(
  baselineRunId: string,
  proposalId: string,
  workspaceId: string,
  idempotencyKey: string
): Promise<{ before: RunDetail; after: RunDetail; comparison: ReturnType<typeof comparison>; source: "deterministic_demo"; created: boolean } | null> {
  const database = await getDatabase();
  let outcome: { afterRunId: string; created: boolean } | null;
  try {
    outcome = await database.transaction(async (tx) => {
    const keyed = await tx.query<ExecutionWorkflowRow>(
      `SELECT id, baseline_run_id, proposal_id, after_run_id, idempotency_key
       FROM rerun_executions WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey]
    );
    if (keyed.rows[0]) {
      const existing = keyed.rows[0];
      if (existing.baseline_run_id !== baselineRunId || existing.proposal_id !== proposalId) {
        throw new ApiFailure(409, "idempotency_conflict", "This Idempotency-Key was already used for a different rerun.");
      }
      return { afterRunId: existing.after_run_id, created: false };
    }

    const baselineResult = await tx.query<RunWorkflowRow>(
      `SELECT id, title, status, prompt, answer, trace_facts
       FROM runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [baselineRunId, workspaceId]
    );
    const baseline = baselineResult.rows[0];
    if (!baseline) return null;

    const repeatedKey = await tx.query<ExecutionWorkflowRow>(
      `SELECT id, baseline_run_id, proposal_id, after_run_id, idempotency_key
       FROM rerun_executions WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey]
    );
    if (repeatedKey.rows[0]) {
      const existing = repeatedKey.rows[0];
      if (existing.baseline_run_id !== baselineRunId || existing.proposal_id !== proposalId) {
        throw new ApiFailure(409, "idempotency_conflict", "This Idempotency-Key was already used for a different rerun.");
      }
      return { afterRunId: existing.after_run_id, created: false };
    }

    const proposalResult = await tx.query<ProposalWorkflowRow>(
      `SELECT id, run_id, workspace_id, version, source, proposed_task, status, idempotency_key, created_at
       FROM proposals WHERE id = $1 AND run_id = $2 AND workspace_id = $3 FOR UPDATE`,
      [proposalId, baselineRunId, workspaceId]
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) throw new ApiFailure(404, "proposal_not_found", "Proposal was not found in this review session.");

    const existingForProposal = await tx.query<ExecutionWorkflowRow>(
      `SELECT id, baseline_run_id, proposal_id, after_run_id, idempotency_key
       FROM rerun_executions WHERE proposal_id = $1`,
      [proposalId]
    );
    if (existingForProposal.rows[0]) {
      throw new ApiFailure(409, "proposal_already_executed", "This proposal already has a synthetic after-run.");
    }
    if (proposal.status === "rejected") throw new ApiFailure(409, "proposal_rejected", "A rejected proposal cannot be rerun.");
    if (proposal.status !== "approved") {
      throw new ApiFailure(409, "proposal_not_approved", "Approve the proposal before explicitly requesting a synthetic rerun.");
    }

    const constraintResult = await tx.query<ConstraintWorkflowRow>(
      `SELECT id, position, label, rule_code, required_value
       FROM constraints WHERE run_id = $1 ORDER BY position ASC`,
      [baselineRunId]
    );
    const afterRunId = await insertChildRun(tx, workspaceId, baseline, proposal, constraintResult.rows);
    const updated = await tx.query<{ id: string }>(
      `UPDATE proposals SET status = 'executed'
       WHERE id = $1 AND run_id = $2 AND workspace_id = $3 AND status = 'approved'
       RETURNING id`,
      [proposalId, baselineRunId, workspaceId]
    );
    if (!updated.rows[0]) throw new ApiFailure(409, "proposal_state_conflict", "The proposal changed while the rerun was being recorded.");
    const now = new Date();
    await tx.query(
      `INSERT INTO rerun_executions (id, workspace_id, baseline_run_id, proposal_id, after_run_id, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), workspaceId, baselineRunId, proposalId, afterRunId, idempotencyKey, now]
    );
    await appendEvent(tx, baselineRunId, "synthetic_rerun_created", "An approved proposal produced a deterministic synthetic after-run.", {
      proposalId,
      afterRunId,
      source: "deterministic_demo"
    });
    return { afterRunId, created: true };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await database.query<ExecutionWorkflowRow>(
      `SELECT id, baseline_run_id, proposal_id, after_run_id, idempotency_key
       FROM rerun_executions WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey]
    );
    const existing = raced.rows[0];
    if (!existing) throw error;
    if (existing.baseline_run_id !== baselineRunId || existing.proposal_id !== proposalId) {
      throw new ApiFailure(409, "idempotency_conflict", "This Idempotency-Key was already used for a different rerun.");
    }
    outcome = { afterRunId: existing.after_run_id, created: false };
  }
  if (!outcome) return null;
  const [before, after] = await Promise.all([
    getRunDetail(baselineRunId, workspaceId),
    getRunDetail(outcome.afterRunId, workspaceId)
  ]);
  if (!before || !after) throw new ApiFailure(500, "rerun_snapshot_missing", "The synthetic rerun was recorded but its snapshot could not be read.");
  return { before, after, comparison: comparison(before, after), source: "deterministic_demo", created: outcome.created };
}

export async function compareSyntheticRuns(
  baselineRunId: string,
  afterRunId: string,
  workspaceId: string
): Promise<{ before: RunDetail; after: RunDetail; comparison: ReturnType<typeof comparison>; source: "deterministic_demo" } | null> {
  const database = await getDatabase();
  const execution = await database.query<{ id: string }>(
    `SELECT id FROM rerun_executions
     WHERE workspace_id = $1 AND baseline_run_id = $2 AND after_run_id = $3`,
    [workspaceId, baselineRunId, afterRunId]
  );
  if (!execution.rows[0]) return null;
  const [before, after] = await Promise.all([
    getRunDetail(baselineRunId, workspaceId),
    getRunDetail(afterRunId, workspaceId)
  ]);
  if (!before || !after) return null;
  return { before, after, comparison: comparison(before, after), source: "deterministic_demo" };
}
