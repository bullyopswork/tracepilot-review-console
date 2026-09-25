import { evaluateConstraints, scoreChecks, type CheckEvaluation, type ConstraintInput, type RuleCode, type TraceFacts } from "@/lib/diagnosis";
import { getDatabase, type DbRow } from "@/lib/db";

export interface RunSummary {
  id: string;
  baselineRunId: string | null;
  title: string;
  mode: "synthetic_demo";
  createdAt: string;
  score: number;
  failedCount: number;
  status: "failed" | "improved";
}

export interface RunDetail extends RunSummary {
  prompt: string;
  answer: string;
  constraints: CheckEvaluation[];
  spans: Array<{ id: string; name: string; kind: string; summary: string; at: string }>;
  events: Array<{ id: string; type: string; summary: string; at: string }>;
  proposals: ProposalSummary[];
  decisions: DecisionSummary[];
}

export interface ProposalSummary {
  id: string;
  runId: string;
  version: number;
  source: "deterministic_demo" | "gemini";
  proposedTask: string;
  status: "pending" | "approved" | "rejected" | "executed";
  afterRunId: string | null;
  createdAt: string;
}

export interface DecisionSummary {
  id: string;
  proposalId: string;
  action: "approved" | "rejected";
  reason: string;
  reviewer: string;
  createdAt: string;
}

export interface Diagnosis {
  score: number;
  passedCount: number;
  failedCount: number;
  failedChecks: Array<{ id: string; label: string; explanation: string }>;
}

interface RunRow extends DbRow {
  id: string;
  baseline_run_id: string | null;
  title: string;
  mode: "synthetic_demo";
  status: "failed" | "improved";
  prompt: string;
  answer: string;
  trace_facts: TraceFacts;
  created_at: string | Date;
}

interface ProposalRow extends DbRow {
  id: string;
  run_id: string;
  version: number;
  source: "deterministic_demo" | "gemini";
  proposed_task: string;
  status: "pending" | "approved" | "rejected" | "executed";
  after_run_id: string | null;
  created_at: string | Date;
}

interface DecisionRow extends DbRow {
  id: string;
  proposal_id: string;
  action: "approved" | "rejected";
  reason: string;
  reviewer: string;
  created_at: string | Date;
}

interface ConstraintRow extends DbRow {
  id: string;
  label: string;
  position: number;
  rule_code: RuleCode;
  required_value: Record<string, unknown>;
  result: "passed" | "failed" | null;
  explanation: string | null;
}

function isoDate(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

function normalizeFacts(value: unknown): TraceFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
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

function constraintInput(row: ConstraintRow): ConstraintInput {
  return {
    id: row.id,
    label: row.label,
    position: row.position,
    rule_code: row.rule_code,
    required_value: row.required_value && typeof row.required_value === "object"
      ? row.required_value
      : {}
  };
}

function resolveChecks(rows: ConstraintRow[], facts: TraceFacts): CheckEvaluation[] {
  const evaluated = evaluateConstraints(rows.map(constraintInput), facts);
  return evaluated.map((check, index) => {
    const stored = rows[index];
    if (!stored.result) return check;
    return {
      ...check,
      passed: stored.result === "passed",
      explanation: stored.explanation ?? check.explanation
    };
  });
}

export async function listRuns(workspaceId: string): Promise<RunSummary[]> {
  const database = await getDatabase();
  const result = await database.query<RunRow & {
    constraint_id: string | null;
    constraint_label: string | null;
    constraint_position: number | null;
    constraint_rule_code: RuleCode | null;
    constraint_required_value: Record<string, unknown> | null;
    check_result: "passed" | "failed" | null;
    check_explanation: string | null;
  }>(
    `SELECT
       r.id, r.baseline_run_id, r.title, r.mode, r.status, r.created_at, r.trace_facts,
       c.id AS constraint_id,
       c.label AS constraint_label,
       c.position AS constraint_position,
       c.rule_code AS constraint_rule_code,
       c.required_value AS constraint_required_value,
       cr.result AS check_result,
       cr.explanation AS check_explanation
     FROM runs r
     LEFT JOIN constraints c ON c.run_id = r.id
     LEFT JOIN check_results cr ON cr.run_id = c.run_id AND cr.constraint_id = c.id
     WHERE r.workspace_id = $1
     ORDER BY r.created_at DESC, c.position ASC`,
    [workspaceId]
  );

  const grouped = new Map<string, { row: RunRow; checks: ConstraintRow[] }>();
  for (const row of result.rows) {
    let group = grouped.get(row.id);
    if (!group) {
      group = { row, checks: [] };
      grouped.set(row.id, group);
    }
    if (
      row.constraint_id &&
      row.constraint_label &&
      row.constraint_position !== null &&
      row.constraint_rule_code &&
      row.constraint_required_value
    ) {
      group.checks.push({
        id: row.constraint_id,
        label: row.constraint_label,
        position: row.constraint_position,
        rule_code: row.constraint_rule_code,
        required_value: row.constraint_required_value,
        result: row.check_result,
        explanation: row.check_explanation
      });
    }
  }

  return [...grouped.values()].map(({ row, checks }) => {
    const resolved = resolveChecks(checks, normalizeFacts(row.trace_facts));
    return {
      id: row.id,
      baselineRunId: row.baseline_run_id,
      title: row.title,
      mode: row.mode,
      createdAt: isoDate(row.created_at),
      score: scoreChecks(resolved),
      failedCount: resolved.filter((check) => !check.passed).length,
      status: row.status
    };
  });
}

export async function getRunDetail(runId: string, workspaceId: string): Promise<RunDetail | null> {
  const database = await getDatabase();
  const runResult = await database.query<RunRow>(
    `SELECT id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at
     FROM runs WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId]
  );
  const row = runResult.rows[0];
  if (!row) return null;

  const facts = normalizeFacts(row.trace_facts);
  const constraintResult = await database.query<ConstraintRow>(
    `SELECT c.id, c.label, c.position, c.rule_code, c.required_value,
            cr.result, cr.explanation
     FROM constraints c
     LEFT JOIN check_results cr ON cr.constraint_id = c.id AND cr.run_id = c.run_id
     WHERE c.run_id = $1
     ORDER BY c.position ASC`,
    [runId]
  );
  const constraints = resolveChecks(constraintResult.rows, facts);

  const [spanResult, eventResult, proposalResult, decisionResult] = await Promise.all([
    database.query<{ id: string; name: string; kind: string; summary: string; occurred_at: string | Date }>(
      `SELECT id, name, kind, summary, occurred_at
       FROM run_spans WHERE run_id = $1 ORDER BY position ASC`,
      [runId]
    ),
    database.query<{ id: string; event_type: string; summary: string; occurred_at: string | Date }>(
      `SELECT id, event_type, summary, occurred_at
       FROM run_events WHERE run_id = $1 ORDER BY sequence ASC`,
      [runId]
    ),
    database.query<ProposalRow>(
      `SELECT p.id, p.run_id, p.version, p.source, p.proposed_task, p.status, e.after_run_id, p.created_at
       FROM proposals p
       LEFT JOIN rerun_executions e ON e.proposal_id = p.id AND e.workspace_id = p.workspace_id
       WHERE p.run_id = $1 AND p.workspace_id = $2 ORDER BY p.version ASC`,
      [runId, workspaceId]
    ),
    database.query<DecisionRow>(
      `SELECT d.id, d.proposal_id, d.action, d.reason, d.reviewer, d.created_at
       FROM decisions d
       WHERE d.run_id = $1 AND d.workspace_id = $2
       ORDER BY d.created_at ASC, d.id ASC`,
      [runId, workspaceId]
    )
  ]);

  return {
    id: row.id,
    baselineRunId: row.baseline_run_id,
    title: row.title,
    mode: row.mode,
    createdAt: isoDate(row.created_at),
    status: row.status,
    prompt: row.prompt,
    answer: row.answer,
    score: scoreChecks(constraints),
    failedCount: constraints.filter((check) => !check.passed).length,
    constraints,
    spans: spanResult.rows.map((span) => ({
      id: span.id,
      name: span.name,
      kind: span.kind,
      summary: span.summary,
      at: isoDate(span.occurred_at)
    })),
    events: eventResult.rows.map((event) => ({
      id: event.id,
      type: event.event_type,
      summary: event.summary,
      at: isoDate(event.occurred_at)
    })),
    proposals: proposalResult.rows.map((proposal) => ({
      id: proposal.id,
      runId: proposal.run_id,
      version: proposal.version,
      source: proposal.source,
      proposedTask: proposal.proposed_task,
      status: proposal.status,
      afterRunId: proposal.after_run_id,
      createdAt: isoDate(proposal.created_at)
    })),
    decisions: decisionResult.rows.map((decision) => ({
      id: decision.id,
      proposalId: decision.proposal_id,
      action: decision.action,
      reason: decision.reason,
      reviewer: decision.reviewer,
      createdAt: isoDate(decision.created_at)
    }))
  };
}

export async function diagnoseRun(runId: string, workspaceId: string): Promise<{ diagnosis: Diagnosis; run: RunDetail } | null> {
  const database = await getDatabase();
  const diagnosis = await database.transaction(async (tx) => {
    const runResult = await tx.query<RunRow>(
      `SELECT id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at
       FROM runs WHERE id = $1 AND workspace_id = $2`,
      [runId, workspaceId]
    );
    const run = runResult.rows[0];
    if (!run) return null;

    const constraintResult = await tx.query<ConstraintRow>(
      `SELECT id, label, position, rule_code, required_value, NULL::text AS result, NULL::text AS explanation
       FROM constraints WHERE run_id = $1 ORDER BY position ASC`,
      [runId]
    );
    const checks = evaluateConstraints(constraintResult.rows.map(constraintInput), normalizeFacts(run.trace_facts));

    for (const check of checks) {
      await tx.query(
        `INSERT INTO check_results (run_id, constraint_id, result, explanation, source, evaluated_at)
         VALUES ($1, $2, $3, $4, 'deterministic_demo', now())
         ON CONFLICT (run_id, constraint_id) DO UPDATE
         SET result = EXCLUDED.result,
             explanation = EXCLUDED.explanation,
             source = EXCLUDED.source,
             evaluated_at = EXCLUDED.evaluated_at`,
        [runId, check.id, check.passed ? "passed" : "failed", check.explanation]
      );
    }

    const passedCount = checks.filter((check) => check.passed).length;
    const failedChecks = checks
      .filter((check) => !check.passed)
      .map(({ id, label, explanation }) => ({ id, label, explanation }));
    return {
      score: scoreChecks(checks),
      passedCount,
      failedCount: failedChecks.length,
      failedChecks
    };
  });

  if (!diagnosis) return null;
  const run = await getRunDetail(runId, workspaceId);
  if (!run) return null;
  return { diagnosis, run };
}
