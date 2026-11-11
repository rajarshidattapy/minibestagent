/**
 * Pure grading functions for the eval harness (evals/run.mjs).
 *
 * Kept free of any server, HTTP, or process concerns so they can be unit
 * tested directly - the grading logic itself is worth getting right
 * independently of whether a model was ever called.
 */

export type Verdict = { pass: boolean; detail: string };

type RecallFrame = { type: "recall"; count: number; since: string };
type StreamFrame = { type: string; [key: string]: unknown };

export type RecallExpectation = {
  min: number;
  /** Oldest recalled turn must fall on this day (YYYY-MM-DD, local). */
  onDay?: string;
};

/** Did memory recall fire the way this case expects? Always checkable - recall is assembled before the model is ever called. */
export function gradeRecall(
  frames: StreamFrame[],
  expectation: RecallExpectation | false,
): Verdict {
  const recall = frames.find((f): f is RecallFrame => f.type === "recall");

  if (expectation === false) {
    return recall
      ? { pass: false, detail: `expected no recall, but got ${recall.count} turn(s)` }
      : { pass: true, detail: "no recall triggered, as expected" };
  }

  if (!recall) {
    return { pass: false, detail: `expected recall (>= ${expectation.min} turns), got none` };
  }
  if (recall.count < expectation.min) {
    return {
      pass: false,
      detail: `expected >= ${expectation.min} recalled turns, got ${recall.count}`,
    };
  }
  if (expectation.onDay) {
    const day = recall.since.slice(0, 10);
    if (day !== expectation.onDay) {
      return {
        pass: false,
        detail: `expected the oldest recalled turn from ${expectation.onDay}, got ${day}`,
      };
    }
  }
  return {
    pass: true,
    detail: `recalled ${recall.count} turn(s)${expectation.onDay ? ` from ${expectation.onDay}` : ""}`,
  };
}

/**
 * Every group must have at least one match (AND of ORs) - lets a case say
 * "mentions (HubSpot OR Pipedrive OR ...) AND (price OR cost OR $)" without
 * demanding the model use one specific word for either idea.
 */
export function gradeMentionsAll(text: string, groups: string[][]): Verdict {
  const lower = text.toLowerCase();
  const missing = groups.filter(
    (group) => !group.some((phrase) => lower.includes(phrase.toLowerCase())),
  );
  if (missing.length) {
    return {
      pass: false,
      detail: `missing required group(s): ${missing.map((g) => `[${g.join(" | ")}]`).join(", ")}`,
    };
  }
  return { pass: true, detail: "every required phrase group was present" };
}

export function gradeMentionsNone(text: string, forbidden: string[]): Verdict {
  const lower = text.toLowerCase();
  const found = forbidden.filter((phrase) => lower.includes(phrase.toLowerCase()));
  if (found.length) {
    return { pass: false, detail: `found forbidden phrase(s): ${found.join(", ")}` };
  }
  return { pass: true, detail: "none of the forbidden phrases appeared" };
}

/** Did the final answer's content blocks include a web search? */
export function usedSearch(content: StreamFrame[]): boolean {
  return content.some((block) => block.type === "web_search_tool_result");
}

export function gradeSearchUsage(content: StreamFrame[], expected: boolean): Verdict {
  const did = usedSearch(content);
  if (did === expected) {
    return {
      pass: true,
      detail: expected ? "searched the web, as expected" : "did not search, as expected",
    };
  }
  return {
    pass: false,
    detail: expected
      ? "expected a web search, but none was made"
      : "expected no web search, but one was made",
  };
}
