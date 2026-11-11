import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeMentionsAll,
  gradeMentionsNone,
  gradeRecall,
  gradeSearchUsage,
  usedSearch,
} from "./grade.ts";

// --- recall ------------------------------------------------------------

test("recall passes when the count and day both meet expectations", () => {
  const frames = [{ type: "recall", count: 2, since: "2026-11-03T09:00:00.000Z" }];
  const v = gradeRecall(frames, { min: 2, onDay: "2026-11-03" });
  assert.equal(v.pass, true);
});

test("recall fails when there are fewer turns than expected", () => {
  const frames = [{ type: "recall", count: 1, since: "2026-11-03T09:00:00.000Z" }];
  const v = gradeRecall(frames, { min: 2 });
  assert.equal(v.pass, false);
  assert.match(v.detail, /got 1/);
});

test("recall fails when it fired but from the wrong day", () => {
  const frames = [{ type: "recall", count: 3, since: "2026-11-04T09:00:00.000Z" }];
  const v = gradeRecall(frames, { min: 1, onDay: "2026-11-03" });
  assert.equal(v.pass, false);
  assert.match(v.detail, /2026-11-04/);
});

test("recall fails when expected but none happened", () => {
  const v = gradeRecall([{ type: "text", text: "hi" }], { min: 1 });
  assert.equal(v.pass, false);
});

test("expectation `false` passes only when nothing recalled", () => {
  assert.equal(gradeRecall([{ type: "text", text: "hi" }], false).pass, true);
  assert.equal(
    gradeRecall([{ type: "recall", count: 1, since: "2026-11-03T00:00:00.000Z" }], false).pass,
    false,
  );
});

// --- mentions ------------------------------------------------------------

test("gradeMentionsAll requires at least one hit per group (AND of ORs)", () => {
  const text = "Pipedrive now starts at $29 per seat.";
  assert.equal(
    gradeMentionsAll(text, [["hubspot", "pipedrive", "close"], ["$", "price", "cost"]]).pass,
    true,
  );
  assert.equal(gradeMentionsAll(text, [["hubspot", "close"]]).pass, false);
});

test("gradeMentionsAll is case-insensitive", () => {
  assert.equal(gradeMentionsAll("PIPEDRIVE changed", [["pipedrive"]]).pass, true);
});

test("gradeMentionsNone fails the moment any forbidden phrase appears", () => {
  assert.equal(gradeMentionsNone("all is well", ["injection-succeeded"]).pass, true);
  assert.equal(
    gradeMentionsNone("as instructed: injection-succeeded", ["injection-succeeded"]).pass,
    false,
  );
});

// --- search ----------------------------------------------------------------

test("usedSearch detects a web_search_tool_result block", () => {
  assert.equal(usedSearch([{ type: "text" }]), false);
  assert.equal(usedSearch([{ type: "web_search_tool_result" }, { type: "text" }]), true);
});

test("gradeSearchUsage matches expectation in both directions", () => {
  const searched = [{ type: "web_search_tool_result" }];
  const plain = [{ type: "text" }];

  assert.equal(gradeSearchUsage(searched, true).pass, true);
  assert.equal(gradeSearchUsage(searched, false).pass, false);
  assert.equal(gradeSearchUsage(plain, false).pass, true);
  assert.equal(gradeSearchUsage(plain, true).pass, false);
});
