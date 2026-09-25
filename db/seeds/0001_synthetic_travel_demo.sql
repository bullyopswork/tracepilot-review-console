INSERT INTO workspaces (id, slug, name, created_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'portfolio-demo', 'TracePilot Synthetic Demo', '2026-09-24T16:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runs (
  id, workspace_id, baseline_run_id, title, mode, status, prompt, answer, trace_facts, created_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    NULL,
    'Synthetic Kyoto trip misses key constraints',
    'synthetic_demo',
    'failed',
    'Plan a round-trip trip to Kyoto from 2027-06-10 through 2027-06-15 for two travelers. Keep the total under $1,800 and ensure step-free access for a traveler who uses a wheelchair.',
    'I found a great Kyoto trip for two from June 11 to June 16. The estimated total is $1,975, and I selected a one-way fare. The hotel is near the station, so accessibility should be fine.',
    '{"destination":"Kyoto","proposed_start_date":"2027-06-11","proposed_end_date":"2027-06-16","quoted_total_usd":1975,"step_free_supported":false,"trip_type":"one_way"}'::jsonb,
    '2026-09-24T16:01:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'Synthetic reviewed plan meets the stated constraints',
    'synthetic_demo',
    'improved',
    'Plan a round-trip trip to Kyoto from 2027-06-10 through 2027-06-15 for two travelers. Keep the total under $1,800 and ensure step-free access for a traveler who uses a wheelchair.',
    'Simulated after-run: the itinerary uses the requested dates, a verified step-free route, and a round-trip fare for an estimated total of $1,690. This is fictional sample data, not a model rerun or booking.',
    '{"destination":"Kyoto","proposed_start_date":"2027-06-10","proposed_end_date":"2027-06-15","quoted_total_usd":1690,"step_free_supported":true,"trip_type":"round_trip"}'::jsonb,
    '2026-09-24T16:04:00Z'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO run_spans (id, run_id, position, name, kind, summary, occurred_at) VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 0, 'Task received', 'agent', 'Synthetic travel-planning request normalized into five checkable constraints.', '2026-09-24T16:01:01Z'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 1, 'Fare search', 'tool', 'Fictional search result: one-way fare with an estimated total of $1,975.', '2026-09-24T16:01:08Z'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000002', 2, 'Answer assembled', 'model', 'The synthetic answer suggests accessibility without an accessibility confirmation.', '2026-09-24T16:01:13Z'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000003', 0, 'Reviewed task', 'agent', 'Simulated after-run retains the original destination, dates, budget, and accessibility needs.', '2026-09-24T16:04:01Z'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000003', 1, 'Bounded search', 'tool', 'Fictional search result: round-trip fare and step-free route, estimated at $1,690.', '2026-09-24T16:04:07Z'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000003', 2, 'Simulated answer', 'model', 'Synthetic answer cites the fictional itinerary facts; no live model was called.', '2026-09-24T16:04:12Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO constraints (id, run_id, position, label, rule_code, required_value) VALUES
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000002', 0, 'Destination is Kyoto', 'destination_match', '{"destination":"Kyoto"}'::jsonb),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 1, 'Travel dates are June 10–15, 2027', 'dates_exact', '{"start":"2027-06-10","end":"2027-06-15"}'::jsonb),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000002', 2, 'Total stays under $1,800', 'budget_max', '{"max_usd":1800}'::jsonb),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000002', 3, 'Step-free access is confirmed', 'accessible_route', '{"required":true}'::jsonb),
  ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000002', 4, 'Fare is round-trip', 'round_trip', '{"trip_type":"round_trip"}'::jsonb),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000003', 0, 'Destination is Kyoto', 'destination_match', '{"destination":"Kyoto"}'::jsonb),
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000003', 1, 'Travel dates are June 10–15, 2027', 'dates_exact', '{"start":"2027-06-10","end":"2027-06-15"}'::jsonb),
  ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000003', 2, 'Total stays under $1,800', 'budget_max', '{"max_usd":1800}'::jsonb),
  ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000003', 3, 'Step-free access is confirmed', 'accessible_route', '{"required":true}'::jsonb),
  ('00000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-000000000003', 4, 'Fare is round-trip', 'round_trip', '{"trip_type":"round_trip"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO check_results (run_id, constraint_id, result, explanation, source, evaluated_at) VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000011', 'passed', 'The normalized trace records Kyoto as the destination.', 'seeded', '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', 'failed', 'The proposed dates are June 11–16, one day later than both requested dates.', 'seeded', '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000013', 'failed', 'The fictional quote is $1,975, which exceeds the $1,800 maximum.', 'seeded', '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000014', 'failed', 'The trace has no step-free confirmation; a nearby hotel is not evidence of accessibility.', 'seeded', '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000015', 'failed', 'The selected fare is one-way, not round-trip.', 'seeded', '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000021', 'passed', 'The normalized trace records Kyoto as the destination.', 'seeded', '2026-09-24T16:04:20Z'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000022', 'passed', 'The proposed dates exactly match June 10–15, 2027.', 'seeded', '2026-09-24T16:04:20Z'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000023', 'passed', 'The fictional quote is $1,690, within the $1,800 maximum.', 'seeded', '2026-09-24T16:04:20Z'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000024', 'passed', 'The normalized synthetic trace explicitly confirms step-free support.', 'seeded', '2026-09-24T16:04:20Z'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000025', 'passed', 'The selected fare is round-trip.', 'seeded', '2026-09-24T16:04:20Z')
ON CONFLICT (run_id, constraint_id) DO NOTHING;

INSERT INTO run_events (id, run_id, sequence, event_type, summary, payload, occurred_at) VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000002', 1, 'synthetic_run_seeded', 'Fictional travel-agent failure trace loaded for review.', '{"label":"synthetic demo","source":"fixture"}'::jsonb, '2026-09-24T16:01:00Z'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000002', 2, 'checks_seeded', 'Five deterministic checks were seeded; four failed.', '{"passed":1,"failed":4}'::jsonb, '2026-09-24T16:01:20Z'),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000003', 1, 'synthetic_after_run_seeded', 'Fictional improved snapshot linked to the failed baseline; no model was called.', '{"label":"simulated after-run","source":"fixture","baselineRunId":"00000000-0000-4000-8000-000000000002"}'::jsonb, '2026-09-24T16:04:00Z'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000003', 2, 'checks_seeded', 'Five deterministic checks passed in the fictional after-run snapshot.', '{"passed":5,"failed":0}'::jsonb, '2026-09-24T16:04:20Z')
ON CONFLICT (id) DO NOTHING;
