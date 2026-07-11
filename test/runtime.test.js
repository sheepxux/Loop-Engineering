import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { readData, sha256File, sha256Json, writeJson } from "../src/fs-utils.js";
import { nextRun, recordExperiment, recordRun, resolveLoop, rollbackStrategy } from "../src/loop-state.js";

function initLoop() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-runtime-"));
  return main(["init", "ci-triage", "--from", "examples/ci-triage/loop.yaml", "--out", tmp]).then(() => {
    return path.join(tmp, "ci-triage");
  });
}

function runLog(overrides = {}) {
  return {
    apiVersion: "loop-engineering/v1",
    loop: "ci-triage",
    runId: "2026-07-10T0100Z",
    startedAt: "2026-07-10T01:00:00Z",
    finishedAt: "2026-07-10T01:20:00Z",
    status: "passed",
    discovered: [{ id: "run-101", summary: "flaky test", source: "github-actions" }],
    results: [{ itemId: "run-101", verdict: "pass", summary: "quarantined flaky test" }],
    budget: { runtimeMinutes: 20, itemsAttempted: 1, estimatedUsd: 1.5 },
    ...overrides
  };
}

function developmentRunLog(index, overrides = {}) {
  return {
    apiVersion: "loop-engineering/v1",
    loop: "self-improving-development",
    runId: `2026-07-10T0${index}00Z`,
    startedAt: `2026-07-10T0${index}:00:00Z`,
    finishedAt: `2026-07-10T0${index}:10:00Z`,
    status: "passed",
    discovered: [],
    results: [{ itemId: `feature-${index}`, verdict: "pass", summary: "verified" }],
    budget: { runtimeMinutes: 10, itemsAttempted: 1, estimatedUsd: 1 },
    metrics: { "verified-pass-rate": 0.7 },
    ...overrides
  };
}

function strategyExperiment(overrides = {}) {
  const experiment = {
    apiVersion: "loop-engineering/v1",
    loop: "self-improving-development",
    experimentId: "reproduction-first-v2",
    metric: "verified-pass-rate",
    benchmark: {
      manifest: "benchmarks/manifest.json",
      sha256: "",
      caseIds: ["case-1", "case-2", "case-3"]
    },
    baseline: {
      version: 1,
      score: 0.6,
      samples: 3,
      results: [
        { caseId: "case-1", score: 0.5, verdict: "pass", artifact: "benchmarks/baseline-case-1.json", sha256: "" },
        { caseId: "case-2", score: 0.6, verdict: "pass", artifact: "benchmarks/baseline-case-2.json", sha256: "" },
        { caseId: "case-3", score: 0.7, verdict: "pass", artifact: "benchmarks/baseline-case-3.json", sha256: "" }
      ]
    },
    candidate: {
      strategy: {
        apiVersion: "loop-engineering/v1",
        loop: "self-improving-development",
        version: 2,
        instructions: "Reproduce the defect first, isolate one causal hypothesis, then run the narrow check before the full suite.",
        hypothesis: "A reproduction-first strategy reduces speculative changes.",
        parentVersion: 1,
        createdAt: null
      },
      score: 0.8,
      samples: 3,
      results: [
        { caseId: "case-1", score: 0.7, verdict: "pass", artifact: "benchmarks/candidate-case-1.json", sha256: "" },
        { caseId: "case-2", score: 0.8, verdict: "pass", artifact: "benchmarks/candidate-case-2.json", sha256: "" },
        { caseId: "case-3", score: 0.9, verdict: "pass", artifact: "benchmarks/candidate-case-3.json", sha256: "" }
      ]
    },
    evidence: [{ command: "npm test", exitCode: 0, summary: "Matched benchmark passed." }],
    recommendation: "promote",
    ...overrides
  };
  return experiment;
}

function bindEvaluatorEvidence(loop, log) {
  const next = structuredClone(log);
  for (const result of next.results) {
    const contextId = `eval-${next.runId}-${result.itemId}`;
    const artifact = path.join(loop.loopDir, "evaluators", `${slug(next.runId)}-${slug(result.itemId)}.json`);
    const evidence = loop.spec.verification.requiredEvidence.map((type) => ({
      type,
      summary: `${type} evidence captured.`
    }));
    for (const command of loop.spec.verification.commands) {
      evidence.push({ type: "command", summary: `${command} completed.`, command, exitCode: result.verdict === "pass" ? 0 : 1 });
    }
    writeJson(artifact, {
      apiVersion: "loop-engineering/v1",
      loop: loop.spec.metadata.name,
      itemId: result.itemId,
      evaluator: {
        identity: loop.spec.verification.evaluator,
        contextId,
        evaluatedAt: next.finishedAt
      },
      verdict: result.verdict,
      evidence,
      reasons: result.verdict === "pass" ? [] : [result.summary],
      nextAction: result.verdict === "pass" ? "accept" : "retry"
    });
    result.evaluator = {
      artifact: path.relative(loop.loopDir, artifact),
      sha256: sha256File(artifact),
      contextId
    };
  }
  return next;
}

function materializeExperiment(loop, experiment) {
  const next = structuredClone(experiment);
  const manifest = path.join(loop.loopDir, next.benchmark.manifest);
  writeJson(manifest, { caseIds: next.benchmark.caseIds });
  next.benchmark.sha256 = sha256File(manifest);
  for (const arm of [next.baseline, next.candidate]) {
    for (const result of arm.results) {
      const artifact = path.join(loop.loopDir, result.artifact);
      writeJson(artifact, { caseId: result.caseId, score: result.score, verdict: result.verdict });
      result.sha256 = sha256File(artifact);
    }
  }
  return next;
}

function approvalFor(experiment) {
  return {
    apiVersion: "loop-engineering/v1",
    loop: experiment.loop,
    experimentId: experiment.experimentId,
    experimentSha256: sha256Json(experiment),
    baselineVersion: experiment.baseline.version,
    approver: "human-reviewer",
    approvedAt: new Date(Date.now() + 1_000).toISOString(),
    reason: "Matched benchmark evidence exceeded the configured threshold."
  };
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

test("next reports full budget for a fresh loop", async () => {
  const loopDir = await initLoop();
  const plan = nextRun(resolveLoop(loopDir));

  assert.equal(plan.ok, true);
  assert.equal(plan.itemsAllowed, 3);
  assert.equal(plan.budget.runsRemainingToday, 2);
  assert.deepEqual(plan.retryQueue, []);
});

test("record files the run log and updates state budgets and items", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  const now = new Date("2026-07-10T02:00:00Z");
  const outcome = recordRun(loop, bindEvaluatorEvidence(loop, runLog()), { now });

  assert.equal(fs.existsSync(outcome.runFile), true);
  const state = readData(path.join(loopDir, "state.json"));
  assert.equal(state.budgets.runsToday, 1);
  assert.equal(state.budgets.runtimeMinutesToday, 20);
  assert.equal(state.budgets.estimatedUsdToday, 1.5);
  assert.equal(state.lastRunAt, "2026-07-10T01:20:00Z");
  assert.deepEqual(state.items.map((item) => [item.id, item.status]), [["run-101", "passed"]]);
});

test("record increments retries on repeated failure and next queues the retry", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  const now = new Date("2026-07-10T02:00:00Z");
  const failing = { itemId: "run-102", verdict: "fail", summary: "did not compile" };

  recordRun(loop, bindEvaluatorEvidence(loop, runLog({
    results: [failing],
    discovered: [{ id: "run-102", summary: "compile failure", source: "github-actions" }],
    status: "failed"
  })), { now });
  recordRun(
    loop,
    bindEvaluatorEvidence(loop, runLog({
      runId: "2026-07-10T0200Z",
      results: [failing],
      discovered: [],
      status: "failed"
    })),
    { now }
  );

  const state = readData(path.join(loopDir, "state.json"));
  assert.deepEqual(state.items, [
    { id: "run-102", status: "failed", retries: 1, summary: "did not compile" }
  ]);

  const plan = nextRun(resolveLoop(loopDir), now);
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join("\n"), /Daily run budget exhausted/);
  assert.deepEqual(plan.retryQueue, [{ id: "run-102", status: "failed", retries: 1 }]);
});

test("next resets daily budgets on UTC day rollover", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  const runDay = new Date("2026-07-10T02:00:00Z");
  recordRun(loop, bindEvaluatorEvidence(loop, runLog()), { now: runDay });
  recordRun(loop, bindEvaluatorEvidence(loop, runLog({ runId: "2026-07-10T0200Z" })), { now: runDay });

  const sameDay = nextRun(resolveLoop(loopDir), runDay);
  assert.equal(sameDay.ok, false);

  const nextDay = nextRun(resolveLoop(loopDir), new Date("2026-07-11T02:00:00Z"));
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.budget.dayRolledOver, true);
  assert.equal(nextDay.budget.runsToday, 0);
});

test("next flags items with exhausted retries", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  writeJson(path.join(loopDir, "state.json"), {
    apiVersion: "loop-engineering/v1",
    loop: "ci-triage",
    lastRunAt: "2026-07-10T01:00:00Z",
    items: [{ id: "run-103", status: "failed", retries: 3 }],
    budgets: { runsToday: 0, runtimeMinutesToday: 0, estimatedUsdToday: 0 }
  });

  const plan = nextRun(loop, new Date("2026-07-10T02:00:00Z"));
  assert.deepEqual(plan.exhausted, [{ id: "run-103", retries: 3, action: "move-to-inbox" }]);
  assert.deepEqual(plan.retryQueue, []);
});

test("record rejects run logs that violate the schema or the spec", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);

  assert.throws(() => recordRun(loop, runLog({ status: "nope" })), /run-log\.schema\.json/);
  assert.throws(
    () => recordRun(loop, bindEvaluatorEvidence(loop, runLog({ loop: "other-loop" }))),
    /does not match spec loop/
  );

  const tooMany = Array.from({ length: 4 }, (_, index) => ({
    itemId: `run-${index}`,
    verdict: "pass",
    summary: "verified"
  }));
  const discovered = tooMany.map((item) => ({ id: item.itemId, summary: "item", source: "manual" }));
  const oversized = bindEvaluatorEvidence(loop, runLog({
    results: tooMany,
    discovered,
    budget: { runtimeMinutes: 20, itemsAttempted: 4, estimatedUsd: 1.5 }
  }));
  assert.throws(() => recordRun(loop, oversized), /maxItemsPerRun/);
});

test("record refuses to overwrite an existing run log without force", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  const now = new Date("2026-07-10T02:00:00Z");
  recordRun(loop, bindEvaluatorEvidence(loop, runLog()), { now });
  assert.throws(() => recordRun(loop, bindEvaluatorEvidence(loop, runLog()), { now }), /--force/);
  recordRun(loop, bindEvaluatorEvidence(loop, runLog()), { now, force: true });
});

test("evolution-enabled init creates an active strategy and experiment directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-init-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);

  const loopDir = path.join(tmp, "self-improving-development");
  assert.equal(fs.existsSync(path.join(loopDir, "strategy.json")), true);
  assert.equal(fs.existsSync(path.join(loopDir, "experiments")), true);
  const strategy = readData(path.join(loopDir, "strategy.json"));
  const state = readData(path.join(loopDir, "state.json"));
  assert.equal(strategy.version, 1);
  assert.equal(state.evolution.currentStrategyVersion, 1);
});

test("next marks strategy evolution due after the configured number of runs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-due-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);
  const loop = resolveLoop(path.join(tmp, "self-improving-development"));
  const now = new Date("2026-07-10T10:00:00Z");
  for (let index = 1; index <= 3; index += 1) {
    recordRun(loop, bindEvaluatorEvidence(loop, developmentRunLog(index, {
      discovered: [{ id: `feature-${index}`, summary: "feature", source: "manual" }]
    })), { now });
  }

  const plan = nextRun(loop, now);
  assert.equal(plan.evolution.enabled, true);
  assert.equal(plan.evolution.due, true);
  assert.match(plan.evolution.reasons.join("\n"), /threshold is 3/);
  assert.equal(plan.evolution.currentStrategyVersion, 1);
});

test("human-reviewed strategy evolution stages then promotes a benchmark winner", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-promote-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);
  const loopDir = path.join(tmp, "self-improving-development");
  const loop = resolveLoop(loopDir);
  const experiment = materializeExperiment(loop, strategyExperiment());

  const staged = recordExperiment(loop, experiment);
  assert.equal(staged.assessment.outcome, "pending-review");
  assert.equal(readData(path.join(loopDir, "strategy.json")).version, 1);
  assert.equal(readData(path.join(loopDir, "state.json")).evolution.pendingExperiment.experimentId, experiment.experimentId);

  const experimentInput = path.join(loopDir, "experiment-input.json");
  const approvalPath = path.join(loopDir, "approval.json");
  writeJson(experimentInput, experiment);
  await main([
    "approval",
    "create",
    loopDir,
    "--experiment",
    experimentInput,
    "--approver",
    "human-reviewer",
    "--reason",
    "Matched benchmark evidence passed review.",
    "--out",
    approvalPath
  ]);
  const promoted = recordExperiment(loop, experiment, { approval: readData(approvalPath) });
  assert.equal(promoted.assessment.outcome, "promoted");
  assert.equal(readData(path.join(loopDir, "strategy.json")).version, 2);
  const state = readData(path.join(loopDir, "state.json"));
  assert.equal(state.evolution.currentStrategyVersion, 2);
  assert.equal(state.evolution.pendingExperiment, null);
  assert.equal(state.evolution.runsSincePromotion, 0);
});

test("strategy evolution rejects candidates below the configured improvement threshold", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-reject-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);
  const loopDir = path.join(tmp, "self-improving-development");
  const loop = resolveLoop(loopDir);
  const raw = strategyExperiment({ experimentId: "weak-v2" });
  raw.candidate.score = 0.65;
  raw.candidate.results[0].score = 0.6;
  raw.candidate.results[1].score = 0.65;
  raw.candidate.results[2].score = 0.7;
  const experiment = materializeExperiment(loop, raw);
  const outcome = recordExperiment(loop, experiment);
  assert.equal(outcome.assessment.outcome, "rejected");
  assert.equal(readData(path.join(loopDir, "strategy.json")).version, 1);
});

test("strategy approval is bound to the exact staged experiment digest", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-approval-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);
  const loop = resolveLoop(path.join(tmp, "self-improving-development"));
  const experiment = materializeExperiment(loop, strategyExperiment());
  recordExperiment(loop, experiment);
  const tampered = structuredClone(experiment);
  tampered.candidate.strategy.instructions += " Then skip a check.";

  assert.throws(
    () => recordExperiment(loop, tampered, { approval: approvalFor(experiment) }),
    /currently pending experiment digest/
  );
});

test("strategy rollback restores archived behavior as a new monotonic version", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-rollback-"));
  await main([
    "init",
    "self-improving-development",
    "--from",
    "examples/self-improving-development/loop.yaml",
    "--out",
    tmp
  ]);
  const loop = resolveLoop(path.join(tmp, "self-improving-development"));
  const original = readData(path.join(loop.loopDir, "strategy.json"));
  const experiment = materializeExperiment(loop, strategyExperiment());
  recordExperiment(loop, experiment);
  recordExperiment(loop, experiment, { approval: approvalFor(experiment) });

  const outcome = rollbackStrategy(loop, 1, {
    actor: "human-reviewer",
    reason: "Post-promotion evidence regressed."
  });
  assert.equal(outcome.strategy.version, 3);
  assert.equal(outcome.restoredFromVersion, 1);
  assert.equal(outcome.strategy.instructions, original.instructions);
  assert.equal(fs.existsSync(path.join(loop.loopDir, "strategies", "v3.json")), true);
  assert.equal(outcome.state.evolution.rollbackHistory.length, 1);
});

test("record fails closed on empty success and hard budget overruns", async () => {
  const loopDir = await initLoop();
  const loop = resolveLoop(loopDir);
  const emptySuccess = runLog({
    status: "passed",
    discovered: [],
    results: [],
    budget: { runtimeMinutes: 1, itemsAttempted: 0, estimatedUsd: 0 }
  });
  assert.throws(() => recordRun(loop, emptySuccess), /passed run requires at least one result/);

  const expensive = bindEvaluatorEvidence(loop, runLog({
    budget: { runtimeMinutes: 20, itemsAttempted: 1, estimatedUsd: 999 }
  }));
  assert.throws(() => recordRun(loop, expensive), /exceeds maxEstimatedUsdPerRun/);
});

test("check validates data files against protocol schemas", async () => {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  await main(["check", "evaluator", "templates/evaluator-result.json"]);
  assert.equal(process.exitCode, undefined);

  await main(["check", "run-log", "templates/evaluator-result.json"]);
  assert.equal(process.exitCode, 1);
  process.exitCode = priorExitCode;
});

test("rendered executor skill is an operational playbook", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-skill-"));
  await main(["render", "codex", "examples/ci-triage/loop.yaml", "--out", tmp]);
  const skill = fs.readFileSync(path.join(tmp, ".agents", "skills", "ci-triage", "SKILL.md"), "utf8");

  assert.match(skill, /loopctl next \.loop-engineering\/loops\/ci-triage/);
  assert.match(skill, /loopctl record \.loop-engineering\/loops\/ci-triage --run/);
  assert.match(skill, /git worktree add/);
  assert.match(skill, /loopctl check evaluator/);
  assert.match(skill, /gh run list --status failure/);
});

test("rendered evolution skill loads strategy and uses benchmark-gated promotion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-evolution-skill-"));
  await main(["render", "codex", "examples/self-improving-development/loop.yaml", "--out", tmp]);
  const skill = fs.readFileSync(path.join(tmp, ".agents", "skills", "self-improving-development", "SKILL.md"), "utf8");

  assert.match(skill, /strategy\.json/);
  assert.match(skill, /loopctl evolve/);
  assert.match(skill, /improve by at least.*0\.1/i);
  assert.match(skill, /Never approve your own strategy/);
});

test("rendered chatgpt adapter is an advisor, not an executor", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-chatgpt-"));
  await main(["render", "chatgpt", "examples/ci-triage/loop.yaml", "--out", tmp]);
  const instructions = fs.readFileSync(path.join(tmp, "chatgpt", "ci-triage", "instructions.md"), "utf8");

  assert.match(instructions, /cannot execute this loop/);
  assert.doesNotMatch(instructions, /git worktree/);
});

test("github-actions scaffold is manual, read-only, and gates on loopctl next", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-engineering-gha-"));
  await main(["render", "github-actions-scaffold", "examples/ci-triage/loop.yaml", "--out", tmp]);
  const workflow = fs.readFileSync(path.join(tmp, ".github", "workflows", "ci-triage.yml"), "utf8");

  assert.match(workflow, /loopctl next '\.loop-engineering\/loops\/ci-triage'/);
  assert.match(workflow, /if: steps\.next\.outputs\.ok == 'true'/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /intentionally performs preflight only/);
});
