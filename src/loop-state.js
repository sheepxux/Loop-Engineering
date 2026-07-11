import fs from "node:fs";
import path from "node:path";
import { readData, sha256File, sha256Json, writeJson } from "./fs-utils.js";
import {
  assessExperiment,
  evolutionPlan,
  initialEvolutionState,
  updateEvolutionForRun
} from "./evolution.js";
import { validateData, validateLoopSpec } from "./validation.js";

const VERDICT_TO_STATUS = new Map([
  ["pass", "passed"],
  ["fail", "failed"],
  ["blocked", "blocked"],
  ["needs-human", "needs-human"]
]);

export function resolveLoop(target) {
  if (!fs.existsSync(target)) {
    throw new Error(`Loop target not found: ${target}`);
  }

  let specPath;
  let loopDir;
  if (fs.statSync(target).isDirectory()) {
    loopDir = target;
    specPath = path.join(target, "loop.yaml");
    if (!fs.existsSync(specPath)) {
      throw new Error(`No loop.yaml found in directory: ${target}`);
    }
  } else {
    specPath = target;
    loopDir = path.dirname(target);
  }

  const spec = readData(specPath);
  const specResult = validateLoopSpec(spec, specPath);
  if (!specResult.ok) {
    const details = specResult.errors.join("; ");
    throw new Error(`Invalid loop spec ${specPath}: ${details}`);
  }

  // Prefer files co-located with loop.yaml (the `loopctl init` layout);
  // fall back to the paths declared in persistence for hand-rolled layouts.
  const statePath = pickPath(path.join(loopDir, "state.json"), spec.persistence.statePath);
  const runLogDir = pickPath(path.join(loopDir, "runs"), spec.persistence.runLogDir);
  const inboxPath = pickPath(path.join(loopDir, "inbox.md"), spec.persistence.inboxPath);
  const strategyPath = spec.evolution?.enabled
    ? pickPath(path.join(loopDir, "strategy.json"), spec.persistence.strategyPath)
    : null;
  const experimentDir = spec.evolution?.enabled
    ? pickPath(path.join(loopDir, "experiments"), spec.persistence.experimentDir)
    : null;
  const strategyArchiveDir = spec.evolution?.enabled ? path.join(loopDir, "strategies") : null;

  return { spec, specPath, loopDir, statePath, runLogDir, inboxPath, strategyPath, experimentDir, strategyArchiveDir };
}

function pickPath(colocated, declared) {
  return fs.existsSync(colocated) ? colocated : declared;
}

export function readState(statePath, loopName) {
  if (!fs.existsSync(statePath)) {
    return {
      apiVersion: "loop-engineering/v1",
      loop: loopName,
      lastRunAt: null,
      paused: false,
      pauseReason: null,
      items: [],
      budgets: { runsToday: 0, runtimeMinutesToday: 0, estimatedUsdToday: 0 }
    };
  }
  const state = readData(statePath);
  const result = validateData("state", state, statePath);
  if (!result.ok) {
    throw new Error(`Invalid state file ${statePath}: ${result.errors.join("; ")}`);
  }
  return state;
}

export function nextRun(loop, now = new Date()) {
  const { spec, statePath } = loop;
  const state = readState(statePath, spec.metadata.name);
  const budgets = spec.safety.budgets;
  const retries = spec.safety.retries;

  const rolledOver = isNewUtcDay(state.lastRunAt, now);
  const runsToday = rolledOver ? 0 : state.budgets.runsToday;
  const runtimeMinutesToday = rolledOver ? 0 : state.budgets.runtimeMinutesToday;
  const estimatedUsdToday = rolledOver ? 0 : (state.budgets.estimatedUsdToday ?? 0);

  const reasons = [];
  if (state.paused) {
    reasons.push(`Loop is paused${state.pauseReason ? `: ${state.pauseReason}` : "."}`);
  }
  if (runsToday >= budgets.maxDailyRuns) {
    reasons.push(`Daily run budget exhausted (${runsToday}/${budgets.maxDailyRuns} runs today).`);
  }

  const retryQueue = [];
  const exhausted = [];
  const needsHuman = [];
  for (const item of state.items) {
    if (item.status === "needs-human") {
      needsHuman.push({ id: item.id, summary: item.summary });
      continue;
    }
    if (item.status !== "open" && item.status !== "failed") {
      continue;
    }
    if (item.retries > retries.maxRetriesPerItem) {
      exhausted.push({ id: item.id, retries: item.retries, action: retries.onRepeatedFailure });
    } else {
      retryQueue.push({ id: item.id, status: item.status, retries: item.retries });
    }
  }

  return {
    loop: spec.metadata.name,
    ok: reasons.length === 0,
    reasons,
    itemsAllowed: Math.min(spec.discovery.maxItemsPerRun, budgets.maxItemsPerRun),
    budget: {
      runsToday,
      maxDailyRuns: budgets.maxDailyRuns,
      runsRemainingToday: Math.max(0, budgets.maxDailyRuns - runsToday),
      runtimeMinutesToday,
      maxRuntimeMinutesPerRun: budgets.maxRuntimeMinutes,
      estimatedUsdToday,
      maxEstimatedUsdPerRun: budgets.maxEstimatedUsdPerRun ?? null,
      dayRolledOver: rolledOver
    },
    retryQueue,
    exhausted,
    needsHuman,
    humanOnly: spec.safety.humanGates.humanOnly,
    stopConditions: spec.goal.stopConditions,
    evolution: evolutionPlan(spec, state, loop)
  };
}

export function recordRun(loop, runLog, { force = false, now = new Date(), runFile: requestedRunFile = null } = {}) {
  const { spec, statePath, runLogDir } = loop;

  const runResult = validateData("run-log", runLog, "run log");
  if (!runResult.ok) {
    throw new Error(`Run log does not match protocol/run-log.schema.json: ${runResult.errors.join("; ")}`);
  }
  if (runLog.loop !== spec.metadata.name) {
    throw new Error(`Run log loop "${runLog.loop}" does not match spec loop "${spec.metadata.name}".`);
  }
  if (runLog.status === "running" || runLog.finishedAt === null) {
    throw new Error("loopctl record accepts terminal run logs only.");
  }

  const state = readState(statePath, spec.metadata.name);
  validateRunSemantics(loop, runLog, state, now);

  if (spec.evolution?.enabled && runLog.results.length > 0) {
    const metric = spec.evolution.metric.name;
    if (typeof runLog.metrics?.[metric] !== "number" || !Number.isFinite(runLog.metrics[metric])) {
      throw new Error(`Evolution-enabled run logs must include a finite metrics.${metric} value.`);
    }
  }

  const runFile = requestedRunFile || path.join(runLogDir, `${slugify(runLog.runId)}.json`);
  if (fs.existsSync(runFile) && !force) {
    throw new Error(`Run log already exists: ${runFile}. Pass --force to overwrite.`);
  }

  if (runLog.status === "dry-run") {
    writeJson(runFile, runLog);
    return { runFile, statePath, state, attention: [], observationOnly: true };
  }

  const rolledOver = isNewUtcDay(state.lastRunAt, now);
  const budgets = rolledOver
    ? { runsToday: 0, runtimeMinutesToday: 0, estimatedUsdToday: 0 }
    : {
        runsToday: state.budgets.runsToday,
        runtimeMinutesToday: state.budgets.runtimeMinutesToday,
        estimatedUsdToday: state.budgets.estimatedUsdToday ?? 0
      };

  budgets.runsToday += 1;
  budgets.runtimeMinutesToday += Number(runLog.budget?.runtimeMinutes || 0);
  budgets.estimatedUsdToday += Number(runLog.budget?.estimatedUsd || 0);

  const items = mergeItems(state.items, runLog);

  const nextState = {
    apiVersion: "loop-engineering/v1",
    loop: spec.metadata.name,
    lastRunAt: runLog.finishedAt || runLog.startedAt,
    paused: state.paused === true,
    pauseReason: state.pauseReason ?? null,
    items,
    budgets
  };
  const evolution = updateEvolutionForRun(spec, state.evolution, runLog);
  if (evolution) {
    nextState.evolution = evolution;
  }

  const stateResult = validateData("state", nextState, "updated state");
  if (!stateResult.ok) {
    throw new Error(`Refusing to write invalid state: ${stateResult.errors.join("; ")}`);
  }

  writeJson(runFile, runLog);
  writeJson(statePath, nextState);

  const attention = items.filter((item) => item.status === "blocked" || item.status === "needs-human");
  return { runFile, statePath, state: nextState, attention };
}

function validateRunSemantics(loop, runLog, state, now) {
  const { spec } = loop;
  const startedAt = parseTimestamp(runLog.startedAt, "startedAt");
  const finishedAt = parseTimestamp(runLog.finishedAt, "finishedAt");
  if (finishedAt < startedAt) {
    throw new Error("Run log finishedAt cannot be earlier than startedAt.");
  }
  if (finishedAt > now.getTime() + 5 * 60_000) {
    throw new Error("Run log finishedAt cannot be more than five minutes in the future.");
  }

  assertUnique(runLog.discovered.map((item) => item.id), "discovered item IDs");
  assertUnique(runLog.results.map((item) => item.itemId), "result item IDs");

  const budgets = spec.safety.budgets;
  if (runLog.results.length > budgets.maxItemsPerRun) {
    throw new Error(
      `Run log has ${runLog.results.length} results but safety.budgets.maxItemsPerRun is ${budgets.maxItemsPerRun}.`
    );
  }
  if (runLog.budget.itemsAttempted !== runLog.results.length) {
    throw new Error("runLog.budget.itemsAttempted must equal results.length.");
  }
  if (runLog.budget.runtimeMinutes > budgets.maxRuntimeMinutes) {
    throw new Error(`Run runtime ${runLog.budget.runtimeMinutes} exceeds maxRuntimeMinutes ${budgets.maxRuntimeMinutes}.`);
  }
  if (
    typeof budgets.maxEstimatedUsdPerRun === "number" &&
    runLog.budget.estimatedUsd > budgets.maxEstimatedUsdPerRun
  ) {
    throw new Error(
      `Run cost $${runLog.budget.estimatedUsd} exceeds maxEstimatedUsdPerRun $${budgets.maxEstimatedUsdPerRun}.`
    );
  }

  const rolledOver = isNewUtcDay(state.lastRunAt, now);
  if (runLog.status !== "dry-run" && !rolledOver && state.budgets.runsToday >= budgets.maxDailyRuns) {
    throw new Error(`Daily run budget exhausted (${state.budgets.runsToday}/${budgets.maxDailyRuns}).`);
  }

  const knownItems = new Set([
    ...state.items.map((item) => item.id),
    ...runLog.discovered.map((item) => item.id)
  ]);
  for (const result of runLog.results) {
    if (!knownItems.has(result.itemId)) {
      throw new Error(`Result item "${result.itemId}" is neither discovered nor present in persisted state.`);
    }
    validateEvaluatorBinding(loop, result);
  }

  const verdicts = runLog.results.map((result) => result.verdict);
  if (runLog.status === "passed" && (verdicts.length === 0 || verdicts.some((verdict) => verdict !== "pass"))) {
    throw new Error("A passed run requires at least one result and every evaluator verdict must be pass.");
  }
  if (runLog.status === "failed" && verdicts.length === 0 && !runLog.failure) {
    throw new Error("A failed run with no item results must include a failure object.");
  }
  if (runLog.status === "failed" && verdicts.length > 0 && !verdicts.includes("fail")) {
    throw new Error("A failed run with item results must include a fail verdict.");
  }
  if (runLog.status === "blocked" && !verdicts.includes("blocked")) {
    throw new Error("A blocked run must include a blocked verdict.");
  }
  if (runLog.status === "needs-human" && !verdicts.includes("needs-human")) {
    throw new Error("A needs-human run must include a needs-human verdict.");
  }
  if (["no-work", "dry-run"].includes(runLog.status) && runLog.results.length !== 0) {
    throw new Error(`${runLog.status} runs cannot contain attempted item results.`);
  }
}

function validateEvaluatorBinding(loop, result) {
  const artifact = path.isAbsolute(result.evaluator.artifact)
    ? result.evaluator.artifact
    : path.resolve(loop.loopDir, result.evaluator.artifact);
  const loopRoot = `${path.resolve(loop.loopDir)}${path.sep}`;
  if (!artifact.startsWith(loopRoot)) {
    throw new Error(`Evaluator artifact must be stored inside the loop directory: ${result.evaluator.artifact}`);
  }
  if (!fs.existsSync(artifact)) {
    throw new Error(`Evaluator artifact not found: ${artifact}`);
  }
  const digest = sha256File(artifact);
  if (digest !== result.evaluator.sha256) {
    throw new Error(`Evaluator artifact digest mismatch for item ${result.itemId}.`);
  }
  const evaluator = readData(artifact);
  const validation = validateData("evaluator", evaluator, artifact);
  if (!validation.ok) {
    throw new Error(`Invalid evaluator artifact ${artifact}: ${validation.errors.join("; ")}`);
  }
  if (evaluator.loop !== loop.spec.metadata.name || evaluator.itemId !== result.itemId) {
    throw new Error(`Evaluator artifact identity does not match result item ${result.itemId}.`);
  }
  if (evaluator.verdict !== result.verdict) {
    throw new Error(`Evaluator artifact verdict does not match run-log verdict for ${result.itemId}.`);
  }
  if (evaluator.evaluator.contextId !== result.evaluator.contextId) {
    throw new Error(`Evaluator contextId does not match run-log binding for ${result.itemId}.`);
  }
  if (normalizeRole(evaluator.evaluator.identity) === normalizeRole(loop.spec.handoff.worker)) {
    throw new Error(`Evaluator identity must differ from worker identity for ${result.itemId}.`);
  }
  if (result.verdict === "pass") {
    for (const required of loop.spec.verification.requiredEvidence) {
      if (!evaluator.evidence.some((evidence) => evidence.type === required)) {
        throw new Error(`Passing evaluator artifact is missing required evidence "${required}" for ${result.itemId}.`);
      }
    }
    for (const command of loop.spec.verification.commands) {
      const evidence = evaluator.evidence.find((item) => item.command === command);
      if (!evidence || evidence.exitCode !== 0) {
        throw new Error(`Passing evaluator artifact lacks successful command evidence: ${command}`);
      }
    }
  }
}

function parseTimestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new Error(`Run log ${field} must be an ISO-8601 UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Run log ${field} is not a valid timestamp.`);
  return parsed;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Run log contains duplicate ${label}.`);
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

export function recordExperiment(loop, experiment, { approval = null, force = false, now = new Date() } = {}) {
  const { spec, statePath, strategyPath, experimentDir, strategyArchiveDir } = loop;
  if (!spec.evolution?.enabled || !strategyPath || !experimentDir) {
    throw new Error("This loop does not enable strategy evolution.");
  }

  const experimentResult = validateData("experiment", experiment, "experiment");
  if (!experimentResult.ok) {
    throw new Error(`Experiment does not match protocol/experiment.schema.json: ${experimentResult.errors.join("; ")}`);
  }
  validateExperimentProvenance(loop, experiment);

  const strategy = readData(strategyPath);
  const strategyResult = validateData("strategy", strategy, strategyPath);
  if (!strategyResult.ok) {
    throw new Error(`Invalid current strategy ${strategyPath}: ${strategyResult.errors.join("; ")}`);
  }

  const state = readState(statePath, spec.metadata.name);
  const digest = sha256Json(experiment);
  validateApprovalBinding({ approval, experiment, digest, state, experimentDir });

  const assessment = assessExperiment(spec, strategy, experiment, { approve: approval !== null });
  const experimentFile = path.join(experimentDir, `${slugify(experiment.experimentId)}.json`);
  if (fs.existsSync(experimentFile) && !force && approval === null) {
    throw new Error(`Experiment already exists: ${experimentFile}. Pass --force to overwrite.`);
  }

  const evolution = structuredClone(state.evolution || initialEvolutionState());
  evolution.history = evolution.history.filter((entry) => entry.experimentId !== experiment.experimentId);
  evolution.history.push({
    experimentId: experiment.experimentId,
    sha256: digest,
    outcome: assessment.outcome,
    baselineVersion: assessment.baselineVersion,
    candidateVersion: assessment.candidateVersion,
    improvement: assessment.improvement
  });

  if (assessment.outcome === "promoted") {
    const promoted = {
      ...assessment.candidate,
      createdAt: assessment.candidate.createdAt || now.toISOString()
    };
    archiveStrategy(strategyArchiveDir, strategy);
    archiveStrategy(strategyArchiveDir, promoted);
    writeJson(strategyPath, promoted);
    evolution.currentStrategyVersion = promoted.version;
    evolution.runsSincePromotion = 0;
    evolution.consecutiveFailures = 0;
    evolution.pendingExperiment = null;
  } else if (assessment.outcome === "pending-review") {
    evolution.pendingExperiment = {
      experimentId: experiment.experimentId,
      sha256: digest,
      baselineVersion: assessment.baselineVersion,
      candidateVersion: assessment.candidateVersion,
      stagedAt: now.toISOString()
    };
  } else if (evolution.pendingExperiment?.experimentId === experiment.experimentId) {
    evolution.pendingExperiment = null;
  }

  const nextState = { ...state, evolution };
  const stateResult = validateData("state", nextState, "updated state");
  if (!stateResult.ok) {
    throw new Error(`Refusing to write invalid state: ${stateResult.errors.join("; ")}`);
  }

  if (approval === null || !fs.existsSync(experimentFile)) {
    writeJson(experimentFile, experiment);
  }
  writeJson(statePath, nextState);
  return { experimentFile, strategyPath, statePath, assessment, state: nextState, sha256: digest };
}

export function rollbackStrategy(loop, version, { actor, reason, now = new Date() } = {}) {
  const { spec, statePath, strategyPath, strategyArchiveDir } = loop;
  if (!spec.evolution?.enabled || !strategyPath || !strategyArchiveDir) {
    throw new Error("This loop does not enable strategy evolution.");
  }
  if (!Number.isInteger(version) || version < 1) throw new Error("Rollback target version must be a positive integer.");
  if (typeof actor !== "string" || actor.trim().length === 0) throw new Error("Rollback requires --actor.");
  if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("Rollback requires a meaningful --reason.");

  const current = readData(strategyPath);
  const targetPath = path.join(strategyArchiveDir, `v${version}.json`);
  if (!fs.existsSync(targetPath)) throw new Error(`Archived strategy v${version} not found: ${targetPath}`);
  const target = readData(targetPath);
  const targetValidation = validateData("strategy", target, targetPath);
  if (!targetValidation.ok) throw new Error(`Archived strategy v${version} is invalid: ${targetValidation.errors.join("; ")}`);
  if (target.loop !== spec.metadata.name) throw new Error("Rollback strategy belongs to a different loop.");
  if (target.version === current.version) throw new Error(`Strategy v${version} is already active.`);

  const restored = {
    ...target,
    version: current.version + 1,
    parentVersion: current.version,
    hypothesis: `Rollback to the behavior of v${target.version}: ${reason.trim()}`,
    createdAt: now.toISOString()
  };
  const state = readState(statePath, spec.metadata.name);
  const evolution = structuredClone(state.evolution || initialEvolutionState());
  evolution.currentStrategyVersion = restored.version;
  evolution.runsSincePromotion = 0;
  evolution.consecutiveFailures = 0;
  evolution.pendingExperiment = null;
  evolution.rollbackHistory.push({
    fromVersion: current.version,
    restoredFromVersion: target.version,
    newVersion: restored.version,
    actor: actor.trim(),
    reason: reason.trim(),
    at: now.toISOString()
  });
  const nextState = { ...state, evolution };
  const stateValidation = validateData("state", nextState, "updated state");
  if (!stateValidation.ok) throw new Error(`Refusing to write invalid rollback state: ${stateValidation.errors.join("; ")}`);

  archiveStrategy(strategyArchiveDir, current);
  archiveStrategy(strategyArchiveDir, restored);
  writeJson(strategyPath, restored);
  writeJson(statePath, nextState);
  return { strategyPath, statePath, restoredFromVersion: target.version, strategy: restored, state: nextState };
}

function archiveStrategy(directory, strategy) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `v${strategy.version}.json`);
  if (fs.existsSync(file)) {
    const existing = readData(file);
    if (sha256Json(existing) !== sha256Json(strategy)) {
      throw new Error(`Archived strategy v${strategy.version} differs from the strategy being recorded.`);
    }
    return file;
  }
  writeJson(file, strategy);
  return file;
}

function validateApprovalBinding({ approval, experiment, digest, state, experimentDir }) {
  if (approval === null) return;
  const validation = validateData("approval", approval, "approval");
  if (!validation.ok) {
    throw new Error(`Approval does not match protocol/approval.schema.json: ${validation.errors.join("; ")}`);
  }
  const pending = state.evolution?.pendingExperiment;
  if (!pending || pending.experimentId !== experiment.experimentId || pending.sha256 !== digest) {
    throw new Error("Approval is not bound to the currently pending experiment digest.");
  }
  if (
    approval.loop !== experiment.loop ||
    approval.experimentId !== experiment.experimentId ||
    approval.experimentSha256 !== digest ||
    approval.baselineVersion !== experiment.baseline.version
  ) {
    throw new Error("Approval fields do not match the staged experiment.");
  }
  const approvedAt = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAt)) throw new Error("Approval approvedAt is not a valid timestamp.");
  const stagedAt = Date.parse(pending.stagedAt);
  if (Number.isFinite(stagedAt) && approvedAt < stagedAt) {
    throw new Error("Approval cannot predate the staged experiment.");
  }
  const experimentFile = path.join(experimentDir, `${slugify(experiment.experimentId)}.json`);
  if (!fs.existsSync(experimentFile)) {
    throw new Error(`Pending experiment artifact not found: ${experimentFile}`);
  }
  const staged = readData(experimentFile);
  if (sha256Json(staged) !== digest) {
    throw new Error("Staged experiment artifact has changed since review; approval is invalid.");
  }
}

function validateExperimentProvenance(loop, experiment) {
  const manifestPath = resolveLoopArtifact(loop, experiment.benchmark.manifest, "benchmark manifest");
  if (sha256File(manifestPath) !== experiment.benchmark.sha256) {
    throw new Error("Benchmark manifest digest does not match experiment.benchmark.sha256.");
  }
  const manifest = readData(manifestPath);
  if (!Array.isArray(manifest.caseIds) || !sameStringSet(manifest.caseIds, experiment.benchmark.caseIds)) {
    throw new Error("Benchmark manifest caseIds do not match the experiment benchmark.");
  }
  for (const arm of [experiment.baseline, experiment.candidate]) {
    for (const result of arm.results) {
      const artifact = resolveLoopArtifact(loop, result.artifact, `benchmark case ${result.caseId}`);
      if (sha256File(artifact) !== result.sha256) {
        throw new Error(`Benchmark artifact digest mismatch for case ${result.caseId}.`);
      }
    }
  }
}

function resolveLoopArtifact(loop, value, label) {
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(loop.loopDir, value);
  const root = `${path.resolve(loop.loopDir)}${path.sep}`;
  if (!target.startsWith(root)) throw new Error(`${label} must be stored inside the loop directory.`);
  if (!fs.existsSync(target)) throw new Error(`${label} not found: ${target}`);
  return target;
}

function sameStringSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function mergeItems(existing, runLog) {
  const byId = new Map(existing.map((item) => [item.id, { ...item }]));

  for (const result of runLog.results) {
    const status = VERDICT_TO_STATUS.get(result.verdict);
    const prior = byId.get(result.itemId);
    if (prior) {
      prior.status = status;
      if (result.verdict === "fail") {
        prior.retries += 1;
      }
      if (result.summary) {
        prior.summary = result.summary;
      }
      byId.set(result.itemId, prior);
    } else {
      const item = { id: result.itemId, status, retries: 0 };
      if (result.summary) {
        item.summary = result.summary;
      }
      byId.set(result.itemId, item);
    }
  }

  for (const discovered of runLog.discovered) {
    const id = discovered.id;
    if (!id || byId.has(id)) {
      continue;
    }
    const item = { id, status: "open", retries: 0 };
    if (discovered.summary) {
      item.summary = discovered.summary;
    }
    if (discovered.source) {
      item.source = discovered.source;
    }
    byId.set(id, item);
  }

  return [...byId.values()];
}

function isNewUtcDay(lastRunAt, now) {
  if (!lastRunAt) {
    return false;
  }
  const last = new Date(lastRunAt);
  if (Number.isNaN(last.getTime())) {
    return false;
  }
  return last.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

function slugify(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}
