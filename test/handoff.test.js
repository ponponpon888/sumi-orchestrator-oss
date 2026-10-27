import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, addTask, createProject } from "../src/domain.js";
import { formatHandoff } from "../src/handoff.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "../src/result.js";

function section(text, name) {
  return text.split(`## ${name}\n`)[1].split("\n## ")[0];
}

test("handoff preserves blockers and puts ready routed work before waiting work", () => {
  const p = createProject({ id: "guard", name: "Guard", vercel: "none", supabase: "none" });
  addScopeCriterion(p, "Verify local checkout", "done");
  addScopeCriterion(p, "Run Windows host verification", "blocked");
  addScopeCriterion(p, "Prepare continuation evidence", "todo");
  addTask(p, "External dependency", "blocked");
  const text = formatHandoff(p, { dataPath: "/custom state/pilot.json" });
  assert.match(section(text, "Project"), /State file: \/custom state\/pilot.json/);
  assert.match(section(text, "Project"), /pass --data/);
  assert.match(section(text, "Blocked"), /C002 Run Windows host verification/);
  assert.match(section(text, "Blocked"), /External dependency/);
  const next = section(text, "Next");
  assert.match(next, /^- C003 Prepare continuation evidence -> .*\[ready\]/);
  assert.match(next, /C002 .*\[waiting\] — .+/);
  assert.doesNotMatch(next, /C001/);
});

test("handoff agrees with effective remediation blockers", () => {
  const p = createProject({ id: "prod", name: "Production" });
  addScopeCriterion(p, "Production smoke test", "todo");
  const result = analyzeAgentResult(p, "C001", "BLOCKER: Turnstile authentication fails. C001 remains blocked. Add a remediation scope for Turnstile hostname configuration and Production retest.");
  const record = recordAgentResult(p, result);
  const applied = applyAgentResult(p, result);
  record.addedCriteria = applied.addedCriteria;
  const remediation = p.scope.criteria.find(item => item.id === applied.addedCriteria[0].criterionId);
  remediation.status = "blocked";
  record.addedCriteria[0].status = "blocked";
  const text = formatHandoff(p);
  assert.match(section(text, "Blocked"), /C001 Production smoke test/);
  assert.doesNotMatch(section(text, "Blocked"), new RegExp(remediation.id));
  assert.match(section(text, "Next"), new RegExp(`^- ${remediation.id} .*human / action \\[ready\\]`));
  assert.doesNotMatch(section(text, "Project"), /State file:/);
});
