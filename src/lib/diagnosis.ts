export type RuleCode =
  | "destination_match"
  | "dates_exact"
  | "budget_max"
  | "accessible_route"
  | "round_trip";

export type TraceFacts = Record<string, unknown>;

export interface ConstraintInput {
  id: string;
  label: string;
  position: number;
  rule_code: RuleCode;
  required_value: Record<string, unknown>;
}

export interface CheckEvaluation {
  id: string;
  label: string;
  passed: boolean;
  explanation: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function evaluateConstraint(
  constraint: ConstraintInput,
  facts: TraceFacts
): CheckEvaluation {
  const required = constraint.required_value;
  let passed = false;
  let explanation: string;

  switch (constraint.rule_code) {
    case "destination_match": {
      const expected = requiredString(required.destination);
      const actual = requiredString(facts.destination);
      passed = Boolean(expected && actual && expected.toLocaleLowerCase("en-US") === actual.toLocaleLowerCase("en-US"));
      explanation = passed
        ? `The normalized trace records ${actual} as the destination.`
        : "The normalized trace does not confirm the required destination.";
      break;
    }
    case "dates_exact": {
      const expectedStart = requiredString(required.start);
      const expectedEnd = requiredString(required.end);
      const actualStart = requiredString(facts.proposed_start_date);
      const actualEnd = requiredString(facts.proposed_end_date);
      passed = Boolean(expectedStart && expectedEnd && actualStart === expectedStart && actualEnd === expectedEnd);
      explanation = passed
        ? `The proposed dates exactly match ${expectedStart} through ${expectedEnd}.`
        : "The proposed dates do not exactly match both requested dates.";
      break;
    }
    case "budget_max": {
      const maximum = required.max_usd;
      const actual = facts.quoted_total_usd;
      passed = isFiniteNumber(maximum) && maximum >= 0 && isFiniteNumber(actual) && actual <= maximum;
      explanation = passed
        ? `The fictional quote is $${actual}, within the $${maximum} maximum.`
        : isFiniteNumber(actual) && isFiniteNumber(maximum)
          ? `The fictional quote is $${actual}, which exceeds the $${maximum} maximum.`
          : "The normalized trace does not contain a valid quote and budget limit.";
      break;
    }
    case "accessible_route": {
      const requiredAccess = required.required;
      const actualAccess = facts.step_free_supported;
      passed = requiredAccess === true && actualAccess === true;
      explanation = passed
        ? "The normalized synthetic trace explicitly confirms step-free support."
        : "The trace has no step-free confirmation; a nearby hotel is not evidence of accessibility.";
      break;
    }
    case "round_trip": {
      const expected = requiredString(required.trip_type);
      const actual = requiredString(facts.trip_type);
      passed = expected === "round_trip" && actual === expected;
      explanation = passed
        ? "The selected fare is round-trip."
        : "The selected fare is not confirmed as round-trip.";
      break;
    }
    default: {
      const unreachable: never = constraint.rule_code;
      throw new Error(`Unsupported deterministic rule: ${unreachable}`);
    }
  }

  return { id: constraint.id, label: constraint.label, passed, explanation };
}

export function evaluateConstraints(
  constraints: ConstraintInput[],
  facts: TraceFacts
): CheckEvaluation[] {
  return constraints.map((constraint) => evaluateConstraint(constraint, facts));
}

export function scoreChecks(checks: CheckEvaluation[]): number {
  if (checks.length === 0) return 0;
  return Math.round((checks.filter((check) => check.passed).length / checks.length) * 100);
}
