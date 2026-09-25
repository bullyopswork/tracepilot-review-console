"use client";

import { useEffect, useRef, useState } from "react";

type RunSummary = {
  id: string;
  title: string;
  mode: string;
  createdAt: string;
  score: number | null;
  failedCount: number;
  status: string;
};

type Constraint = {
  id: string;
  label: string;
  passed: boolean;
  explanation: string;
};

type Span = {
  id: string;
  name: string;
  kind: string;
  summary: string;
  at: string;
};

type RunEvent = {
  id: string;
  type: string;
  summary: string;
  at: string;
};

type RunDetail = RunSummary & {
  prompt: string;
  answer: string;
  constraints: Constraint[];
  spans: Span[];
  events: RunEvent[];
  proposals?: Proposal[];
  decisions?: Decision[];
};

type Diagnosis = {
  score: number;
  passedCount: number;
  failedCount: number;
  failedChecks: Array<{ id: string; label: string; explanation: string }>;
};

type Proposal = {
  id: string;
  runId: string;
  version: number;
  source: "deterministic_demo";
  proposedTask: string;
  status: "pending" | "approved" | "rejected" | "executed";
  createdAt: string;
  afterRunId?: string | null;
};

type Decision = {
  id: string;
  proposalId: string;
  action: "approved" | "rejected";
  reason: string;
  reviewer?: string;
  at?: string;
  createdAt?: string;
};

type Comparison = {
  before: RunDetail;
  after: RunDetail;
  comparison: {
    before: { score: number; failedCount: number };
    after: { score: number; failedCount: number };
    checks: Array<{ id: string; label: string; before: "passed" | "failed"; after: "passed" | "failed" }>;
  };
  source: "deterministic_demo";
};

function formatTime(raw: string | undefined) {
  if (!raw) return "Time not recorded";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function safeScore(score: number | null | undefined) {
  return typeof score === "number" && Number.isFinite(score)
    ? `${Math.max(0, Math.min(100, Math.round(score)))}`
    : "—";
}

function scoreLabel(score: number | null | undefined) {
  if (typeof score !== "number") return "Not yet diagnosed";
  if (score >= 90) return "Constraints met";
  if (score >= 70) return "Needs a closer look";
  return "Action recommended";
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string | { message?: string } })
    | null;
  if (!response.ok) {
    const error = body?.error;
    const message = typeof error === "string" ? error : error?.message;
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (!body) throw new Error("The server returned an empty response.");
  return body;
}

export default function Home() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [workflowPending, setWorkflowPending] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const proposalRef = useRef<HTMLElement>(null);
  const comparisonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/runs", { signal: controller.signal, cache: "no-store" });
        const body = await responseJson<{ runs: RunSummary[] }>(response);
        if (!Array.isArray(body.runs)) throw new Error("Run list is unavailable.");
        const orderedRuns = [...body.runs].sort((a, b) =>
          a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === "failed" ? -1 : 1,
        );
        setRuns(orderedRuns);
        setSelectedId(orderedRuns[0]?.id ?? null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setListError(error instanceof Error ? error.message : "Unable to load runs.");
        }
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    async function load() {
      setDetailLoading(true);
      setDetailError(null);
      setDiagnosis(null);
      setWorkflowError(null);
      setProposal(null);
      setComparison(null);
      setDecisionReason("");
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(selectedId!)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = await responseJson<{ run: RunDetail }>(response);
        if (!body.run) throw new Error("Run detail is unavailable.");
        setRun(body.run);
        const latestProposal = body.run.proposals?.at(-1) ?? null;
        setProposal(latestProposal);
        if (latestProposal?.afterRunId) {
          const compareResponse = await fetch(
            `/api/runs/${encodeURIComponent(selectedId!)}/compare?afterRunId=${encodeURIComponent(latestProposal.afterRunId)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const compareBody = await responseJson<Comparison>(compareResponse);
          setComparison(compareBody);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRun(null);
          setDetailError(error instanceof Error ? error.message : "Unable to load this run.");
        }
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [selectedId]);

  async function diagnose() {
    if (!run || diagnosing) return;
    setDiagnosing(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/diagnose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await responseJson<{ diagnosis: Diagnosis; run: RunDetail }>(response);
      setDiagnosis(body.diagnosis);
      if (body.run) {
        setRun(body.run);
        setRuns((current) =>
          current.map((item) =>
            item.id === body.run.id
              ? { ...item, score: body.run.score, failedCount: body.run.failedCount, status: body.run.status }
              : item,
          ),
        );
      }
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Diagnosis failed.");
    } finally {
      setDiagnosing(false);
    }
  }

  async function refreshRun(id: string) {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await responseJson<{ run: RunDetail }>(response);
    setRun(body.run);
    setProposal(body.run.proposals?.at(-1) ?? null);
  }

  async function propose() {
    if (!run || workflowPending) return;
    setWorkflowPending(true);
    setWorkflowError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      });
      const body = await responseJson<{ proposal: Proposal }>(response);
      setProposal(body.proposal);
      setDecisionReason("");
      await refreshRun(run.id);
      window.setTimeout(() => proposalRef.current?.focus(), 0);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Unable to create a proposed task.");
    } finally {
      setWorkflowPending(false);
    }
  }

  async function decide(action: "approve" | "reject") {
    if (!run || !proposal || workflowPending) return;
    const reason = decisionReason.trim();
    if (reason.length < 8) {
      setWorkflowError("Add a brief reason of at least 8 characters for the review record.");
      return;
    }
    setWorkflowPending(true);
    setWorkflowError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/proposals/${encodeURIComponent(proposal.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action, reason, reviewer: "Demo reviewer" }),
      });
      const body = await responseJson<{ proposal: Proposal }>(response);
      setProposal(body.proposal);
      await refreshRun(run.id);
      window.setTimeout(() => proposalRef.current?.focus(), 0);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Unable to save the review decision.");
    } finally {
      setWorkflowPending(false);
    }
  }

  async function rerun() {
    if (!run || !proposal || workflowPending) return;
    setWorkflowPending(true);
    setWorkflowError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ proposalId: proposal.id }),
      });
      const body = await responseJson<Comparison>(response);
      setComparison(body);
      await refreshRun(run.id);
      const listResponse = await fetch("/api/runs", { cache: "no-store" });
      const listBody = await responseJson<{ runs: RunSummary[] }>(listResponse);
      setRuns(listBody.runs);
      window.setTimeout(() => comparisonRef.current?.focus(), 0);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Unable to run the reviewed synthetic follow-up.");
    } finally {
      setWorkflowPending(false);
    }
  }

  const passedCount = run?.constraints.filter((item) => item.passed).length ?? 0;
  const failedCount = run?.constraints.filter((item) => !item.passed).length ?? 0;
  const totalChecks = run?.constraints.length ?? 0;

  return (
    <div className="console-shell">
      <a className="skip-link" href="#main-content">Skip to run review</a>
      <aside className="sidebar" aria-label="Run navigator">
        <div className="brand-row">
          <div className="brand-symbol" aria-hidden="true"><span /><span /><span /></div>
          <div><div className="brand-name">TracePilot<span className="brand-period">.</span></div><div className="brand-subtitle">Review console</div></div>
        </div>
        <div className="sidebar-rule" />
        <div className="sidebar-heading"><span>RUN LIBRARY</span><span className="sidebar-count">{runs.length.toString().padStart(2, "0")}</span></div>
        <p className="sidebar-swipe-hint">Swipe to browse runs <span aria-hidden="true">→</span></p>
        <p className="sidebar-note">A closer look at what an agent did—and what it missed.</p>
        <nav className="run-nav" aria-label="Sample runs">
          {listLoading && <div className="sidebar-state" role="status">Loading sample runs…</div>}
          {listError && <div className="sidebar-state error" role="alert">{listError}</div>}
          {!listLoading && !listError && runs.length === 0 && <div className="sidebar-state">No sample runs available.</div>}
          {runs.map((item, index) => (
            <button
              className={`run-nav-item${selectedId === item.id ? " active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              disabled={workflowPending}
              aria-pressed={selectedId === item.id}
            >
              <span className="run-nav-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="run-nav-main"><strong>{item.title}</strong><small>{item.failedCount > 0 ? `${item.failedCount} checks need review` : "All checks passed"}</small></span>
              <span className="run-nav-score" aria-label={`Score ${safeScore(item.score)} out of 100`}>{safeScore(item.score)}</span>
            </button>
          ))}
        </nav>
        <span className="visually-hidden" role="status" aria-live="polite">{run ? `Reviewing ${run.title}` : ""}</span>
        <div className="sidebar-bottom">
          <div className="demo-marker"><span className="marker-dot" /><div><strong>Synthetic demo</strong><small>Fictional runs, no live agent or customer data.</small></div></div>
          <a href="https://github.com/bullyopswork/tracepilot" target="_blank" rel="noopener noreferrer">Original TracePilot agent proof <span aria-hidden="true">↗</span></a>
        </div>
      </aside>

      <main id="main-content" className="main-area">
        <header className="topbar"><div className="breadcrumb">WORKSPACE <span>/</span> RUN REVIEW</div><div className="topbar-right"><span className="live-dot" /> SAMPLE MODE <span className="topbar-divider" /> TRACEPILOT 01</div></header>
        <div className="main-inner">
          {detailLoading && <div className="loading-panel" role="status">Opening the run and its evidence…</div>}
          {detailError && <div className="alert-panel" role="alert">{detailError}</div>}
          {!detailLoading && !run && !detailError && <div className="loading-panel">Choose a run to inspect its evidence.</div>}
          {run && !detailLoading && (
            <>
              <div className="page-kicker"><span className="kicker-line" /> AGENT RUN / {run.id.slice(0, 8).toUpperCase()}</div>
              <div className="page-intro"><div><h1>Make the invisible<br /><em>inspectable.</em></h1><p>Good answers are not enough. Follow the trace, check the constraints, then decide what should happen next.</p><a className="mobile-evidence-jump" href="#constraint-review">Jump to constraint checks <span aria-hidden="true">↓</span></a></div><div className="intro-meta"><span className="meta-eyebrow">THIS REVIEW</span><strong>{run.title}</strong><span>{formatTime(run.createdAt)}</span><span className="sample-pill">SYNTHETIC TRACE</span></div></div>

              <section className="score-hero" aria-labelledby="score-title">
                <div className="score-grid" aria-hidden="true" />
                <div className="score-content"><div className="score-copy"><div className="light-kicker">01 / THE SIGNAL</div><h2 id="score-title">The answer looked right.<br /><span>The trace tells more.</span></h2><p>Compare the result against each instruction before approving any next step.</p><div className="score-status"><span className="status-orb" /><span>{scoreLabel(run.score)}</span></div></div><div className="score-meter" role="img" aria-label={`Constraint score ${safeScore(run.score)} out of 100`}><div className="meter-inner"><strong>{safeScore(run.score)}</strong><span>/ 100</span></div></div></div>
                <div className="score-footer"><div><span>CHECKS PASSED</span><strong>{passedCount.toString().padStart(2, "0")} <small>/ {totalChecks.toString().padStart(2, "0")}</small></strong></div><div><span>NEEDS REVIEW</span><strong>{failedCount.toString().padStart(2, "0")}</strong></div><div><span>TRACE EVENTS</span><strong>{run.spans.length.toString().padStart(2, "0")}</strong></div><a href="#constraint-review">Review the evidence <span aria-hidden="true">↘</span></a></div>
              </section>

              <div className="section-heading" id="constraint-review"><div><span className="section-index">02 / CONSTRAINT REVIEW</span><h2>Where the run holds up.<br /><em>Where it doesn’t.</em></h2></div><p>Each check is tied to the task and its observed result—not a vague confidence score.</p></div>
              <div className="review-grid"><section className="task-card" aria-labelledby="task-title"><div className="card-heading"><span className="card-icon">↳</span><span>THE ORIGINAL TASK</span></div><h3 id="task-title">What the agent was asked</h3><p>{run.prompt}</p><div className="task-foot">Source: fictional travel-planning scenario</div></section><section className="checks-card" aria-label="Constraint checks"><div className="card-heading"><span className="card-icon">✓</span><span>CHECKS / {totalChecks.toString().padStart(2, "0")}</span></div>{run.constraints.map((item) => <div key={item.id} className={`check-row ${item.passed ? "passed" : "failed"}`}><span className="check-symbol" aria-hidden="true">{item.passed ? "✓" : "!"}</span><div><strong>{item.label}</strong><p>{item.explanation}</p></div><span className="check-status">{item.passed ? "MET" : "MISSED"}</span></div>)}</section></div>

              <div className="section-heading trace-heading"><div><span className="section-index">03 / THE RECORD</span><h2>What actually<br /><em>happened.</em></h2></div><p>A compact, allowlisted timeline. Demo traces are synthetic and contain no private prompts or credentials.</p></div>
              <div className="record-grid"><section className="timeline-card" aria-label="Agent trace timeline"><div className="card-heading"><span className="card-icon">⌁</span><span>TRACE / {run.spans.length.toString().padStart(2, "0")} EVENTS</span></div><div className="timeline">{run.spans.map((span, index) => <div className="timeline-item" key={span.id}><div className="timeline-index">{String(index + 1).padStart(2, "0")}</div><div><div className="timeline-top"><strong>{span.name}</strong><span>{span.kind}</span></div><p>{span.summary}</p></div></div>)}</div></section><section className="answer-card" aria-labelledby="answer-title"><div className="card-heading"><span className="card-icon">“</span><span>FINAL OUTPUT</span></div><h3 id="answer-title">The agent’s answer</h3><blockquote>{run.answer}</blockquote><div className="answer-note"><span aria-hidden="true">↗</span><p>Plausible is not the same as complete. Check the output against the original constraints and trace.</p></div></section></div>

              <section className="diagnosis-panel" aria-labelledby="diagnosis-title"><div><span className="section-index">04 / OPERATOR STEP</span><h2 id="diagnosis-title">Run a grounded diagnosis.</h2><p>The check uses the stored synthetic trace and explicit rules. It does not call Gemini or rerun the agent.</p></div><button className="diagnose-button" type="button" onClick={() => void diagnose()} disabled={diagnosing}>{diagnosing ? "Checking evidence…" : "Diagnose this run"}<span aria-hidden="true">↗</span></button></section>
              {diagnosis && <div className="diagnosis-result" ref={resultRef} tabIndex={-1} role="status"><div><span className="section-index">DIAGNOSIS COMPLETE</span><h3>{diagnosis.failedCount === 0 ? "All checked constraints passed." : `${diagnosis.failedCount} constraint${diagnosis.failedCount === 1 ? "" : "s"} need attention.`}</h3><p>{diagnosis.passedCount} of {diagnosis.passedCount + diagnosis.failedCount} checks passed. Score: {safeScore(diagnosis.score)}/100.</p></div>{diagnosis.failedChecks.length > 0 && <ul>{diagnosis.failedChecks.map((item) => <li key={item.id}><strong>{item.label}</strong><span>{item.explanation}</span></li>)}</ul>}</div>}
              {failedCount > 0 && (diagnosis || proposal) && <section className="review-step" aria-labelledby="review-step-title" ref={proposalRef} tabIndex={-1}>
                <div className="review-step-intro"><div><span className="section-index">05 / HUMAN REVIEW</span><h2 id="review-step-title">A better next task.<br /><em>Your decision.</em></h2></div><p>The proposal is generated from fixed demo rules. It is not a Gemini output or an agent rerun. Review it before any follow-up is created.</p></div>
                {!proposal && <div className="review-empty"><div><strong>Ready to propose a correction?</strong><p>The revised task will target the missed constraints above. It will remain pending until you approve or reject it.</p></div><button className="review-primary" type="button" onClick={() => void propose()} disabled={workflowPending}>{workflowPending ? "Preparing proposal…" : "Propose revised task"}<span aria-hidden="true">↗</span></button></div>}
                {proposal && <div className="proposal-card"><div className="proposal-topline"><span>PROPOSAL {String(proposal.version).padStart(2, "0")}</span><span className={`proposal-status status-${proposal.status}`}>{proposal.status.toUpperCase()}</span></div><h3>What should change next</h3><p className="proposal-task">{proposal.proposedTask.split(/\n\n+/)[0]}</p><div className="proposal-checklist"><strong>Verify before any follow-up</strong><ul>{run.constraints.filter((item) => !item.passed).map((item) => <li key={item.id}>{item.label}</li>)}</ul><p>Do not infer a missing price, date, fare, or accessibility fact; state uncertainty instead.</p></div><details className="proposal-full-task"><summary>Read the complete proposed task</summary><p>{proposal.proposedTask}</p></details><p className="proposal-source">Source: deterministic demo rules · Created {formatTime(proposal.createdAt)}</p>
                  {proposal.status === "pending" && <div className="decision-form"><label htmlFor="decision-reason">Why approve or reject this proposal?</label><textarea id="decision-reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} maxLength={1000} rows={3} placeholder="Explain your decision for the review record." aria-describedby="decision-privacy-note" /><p id="decision-privacy-note">Your reason is saved in this private demo workspace. Session access expires after 30 days; expired workspaces are cleared by scheduled, batched cleanup. Use fictional details only—no personal or customer information. Approval alone does not run the agent.</p><div className="decision-actions"><button className="review-primary" type="button" onClick={() => void decide("approve")} disabled={workflowPending}>Approve proposed task</button><button className="review-secondary" type="button" onClick={() => void decide("reject")} disabled={workflowPending}>Reject proposal</button></div></div>}
                  {proposal.status === "approved" && <div className="review-followup"><p><strong>Approved—not executed.</strong> The reviewer decision is recorded. A separate action creates a labeled synthetic follow-up run.</p><button className="review-primary" type="button" onClick={() => void rerun()} disabled={workflowPending}>{workflowPending ? "Creating follow-up…" : "Run synthetic follow-up"}<span aria-hidden="true">↗</span></button></div>}
                  {proposal.status === "rejected" && <div className="review-followup"><p><strong>Rejected.</strong> No follow-up run was created from this proposal.</p><button className="review-secondary" type="button" onClick={() => void propose()} disabled={workflowPending}>Draft a new proposal</button></div>}
                  {proposal.status === "executed" && <div className="review-followup"><p><strong>Follow-up recorded.</strong> This is a simulated run with fictional data, linked to the approved proposal.</p>{proposal.afterRunId && <button className="review-secondary" type="button" onClick={() => setSelectedId(proposal.afterRunId!)}>Inspect follow-up run</button>}</div>}
                </div>}
                {workflowError && <p className="review-error" role="alert">{workflowError}</p>}
                {(run.decisions?.length ?? 0) > 0 && <div className="review-history"><h3>Decision history</h3><ol>{run.decisions!.map((item) => <li key={item.id}><strong>{item.action === "approved" ? "Approved" : "Rejected"}</strong><span>{item.reason}</span><small>{item.reviewer || "Session reviewer"} · {formatTime(item.at ?? item.createdAt)}</small></li>)}</ol></div>}
              </section>}
              {comparison && <section className="comparison-section" aria-labelledby="comparison-title" ref={comparisonRef} tabIndex={-1}><div className="comparison-heading"><div><span className="section-index">06 / BEFORE & AFTER</span><h2 id="comparison-title">See what changed.</h2><p>Both results are fictional. The second run is a deterministic simulation, not a live model execution.</p></div><span className="sample-pill">SYNTHETIC FOLLOW-UP</span></div><div className="comparison-scores"><div><span>ORIGINAL RUN</span><strong>{safeScore(comparison.comparison.before.score)}<small>/100</small></strong><p>{comparison.comparison.before.failedCount} missed constraints</p></div><div className="comparison-arrow" aria-hidden="true">→</div><div><span>REVIEWED FOLLOW-UP</span><strong>{safeScore(comparison.comparison.after.score)}<small>/100</small></strong><p>{comparison.comparison.after.failedCount} missed constraints</p></div></div><ul className="comparison-checks">{comparison.comparison.checks.map((item) => <li key={item.id}><strong>{item.label}</strong><span>{item.before.toUpperCase()} → {item.after.toUpperCase()}</span></li>)}</ul></section>}
              <footer className="page-footer"><span>TracePilot Review Console <span aria-hidden="true">/</span> Synthetic portfolio study</span><span>Human judgment stays in the loop.</span></footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
