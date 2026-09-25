# TracePilot Review Console

A synthetic, full-stack study of a practical AI-agent failure: an answer can sound helpful while missing the task's dates, budget, accessibility requirement, or round-trip fare. This console lets a reviewer inspect the trace and explicit checks before deciding whether a revised task should be used.

**Live synthetic demo:** https://tracepilot-review-console.vercel.app/

The public reviewer journey is hosted on Vercel with a separate Neon Free-plan PostgreSQL project. The original [TracePilot Python agent proof](https://github.com/bullyopswork/tracepilot) is a separate project; this console does not run that agent or use its Cloud Run deployment.

## Reviewer path

1. Select the fictional failed Kyoto run from the run library.
2. Compare the original task, final answer, trace timeline, and five explicit constraints.
3. Run the deterministic diagnosis to see each missed requirement.
4. Create a proposed revised task. This is fixed-rule demo output, **not** Gemini output.
5. Approve or reject with a reason. Approval is recorded but does **not** execute a follow-up.
6. If approved, separately start a labeled synthetic follow-up and compare the before/after checks.

All names, task details, prices, traces, and results are fictional. Do not enter real personal or customer information. No outbound message is sent and no live model or agent is called.

## Local setup

Requires Node.js 22 or newer. `DATABASE_URL` is optional for a local run: without it, the app uses a local PGlite data directory ignored by Git. With `DATABASE_URL`, use a dedicated disposable PostgreSQL database or schema; do not point this demo at a client database.

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. Run `npm test`, `npm run typecheck`, and `npm run build` before publishing a change.

## How it is built

- Next.js, React, TypeScript, route handlers, and PostgreSQL-compatible migrations.
- Synthetic run fixtures, allowlisted trace facts, deterministic constraint checks, and a persisted review trail.
- A random, HttpOnly review-session cookie maps each visitor to a separate server-side workspace with copied synthetic fixtures. The shared seed fixture is read-only; a second session cannot access the first visitor's run IDs or decisions.
- Transaction-guarded approval and follow-up transitions with idempotency keys; approving a proposal and executing a follow-up are separate actions. Proposal creation and retained anonymous sessions have hard caps, and write requests require same-origin JSON with a streamed body limit.
- Session access expires after 30 days. A protected Vercel cron route is configured for daily cleanup of up to 100 expired workspaces per run; new-session creation also performs bounded cleanup. Local operators can run `npm run db:cleanup-expired`. Batched cleanup can lag behind expiration, so expiration is not a promise of immediate deletion.

For public hosting, provide a dedicated PostgreSQL `DATABASE_URL` and a server-only `CRON_SECRET` in the deployment environment. Production fails closed without PostgreSQL. The live deployment has these as hidden Vercel secrets. Its daily cleanup is configured, but the first scheduled execution has not yet been observed; do not treat it as a verified retention-control run. The global visitor cap bounds storage but is not per-IP rate limiting or a guarantee of public availability under abuse.

This is a portfolio demo, not a production agent-operations platform. It does not implement real authentication, import untrusted external traces, or execute arbitrary tools. Any future live-model adapter would need a separate server-only key, cost/rate bounds, and an explicit UI source label.

## Credit and contribution boundary

The concept builds on the public TracePilot proof linked above, but this clean web-console codebase and synthetic travel scenario are separate. The initial implementation is AI-assisted. Repository ownership alone does not establish which code Eduardo personally wrote or debugged; that contribution should be described only after it is documented.
