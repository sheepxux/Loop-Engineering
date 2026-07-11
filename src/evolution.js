export function initialEvolutionState() {
  return {
    currentStrategyVersion: 1,
    runsSincePromotion: 0,
    consecutiveFailures: 0,
    pendingExperiment: null,
    observations: [],
    history: [],
    rollbackHistory: []
  };
}

export function initialStrategy(spec, loopName) {
  return {
    apiVersion: "loop-engineering/v1",
    loop: loopName,
    version: 1,
    instructions: spec.evolution.initialStrategy,
    hypothesis: "Initial task strategy from loop.yaml",
    parentVersion: null,
    createdAt: null
  };
}

export function evolutionPlan(spec, state, paths) {
  if (!spec.evolution?.enabled) {
    return { enabled: false, due: false };
  }

  const current = state.evolution || initialEvolutionState();
  const reasons = [];
  if (current.runsSincePromotion >= spec.evolution.trigger.afterRuns) {
    reasons.push(
      `Strategy has run ${current.runsSincePromotion} time(s) since promotion; threshold is ${spec.evolution.trigger.afterRuns}.`
    );
  }
  if (current.consecutiveFailures >= spec.evolution.trigger.consecutiveFailures) {
    reasons.push(
      `Strategy has ${current.consecutiveFailures} consecutive failed run(s); threshold is ${spec.evolution.trigger.consecutiveFailures}.`
    );
  }

  return {
    enabled: true,
    due: reasons.length > 0,
    reasons,
    currentStrategyVersion: current.currentStrategyVersion,
    strategyPath: paths.strategyPath,
    experimentDir: paths.experimentDir,
    pendingExperiment: current.pendingExperiment,
    metric: spec.evolution.metric,
    evaluator: spec.evolution.evaluator,
    promotion: spec.evolution.promotion
  };
}

export function updateEvolutionForRun(spec, prior, runLog) {
  if (!spec.evolution?.enabled) {
    return undefined;
  }

  const next = structuredClone(prior || initialEvolutionState());
  if (runLog.results.length === 0 || ["dry-run", "no-work", "budget-exceeded"].includes(runLog.status)) {
    return next;
  }
  next.runsSincePromotion += 1;
  next.consecutiveFailures = runSucceeded(runLog) ? 0 : next.consecutiveFailures + 1;

  const metric = spec.evolution.metric.name;
  const score = runLog.metrics?.[metric];
  if (typeof score === "number" && Number.isFinite(score)) {
    next.observations.push({ runId: runLog.runId, metric, score });
    next.observations = next.observations.slice(-100);
  }

  return next;
}

export function assessExperiment(spec, strategy, experiment, { approve = false } = {}) {
  const config = spec.evolution;
  if (!config?.enabled) {
    throw new Error("This loop does not enable strategy evolution.");
  }
  if (experiment.loop !== spec.metadata.name) {
    throw new Error(`Experiment loop "${experiment.loop}" does not match spec loop "${spec.metadata.name}".`);
  }
  if (experiment.metric !== config.metric.name) {
    throw new Error(`Experiment metric "${experiment.metric}" does not match configured metric "${config.metric.name}".`);
  }
  if (experiment.baseline.version !== strategy.version) {
    throw new Error(
      `Experiment baseline version ${experiment.baseline.version} does not match current strategy version ${strategy.version}.`
    );
  }

  const candidate = experiment.candidate.strategy;
  if (candidate.loop !== spec.metadata.name) {
    throw new Error(`Candidate strategy loop "${candidate.loop}" does not match spec loop "${spec.metadata.name}".`);
  }
  if (candidate.version !== strategy.version + 1 || candidate.parentVersion !== strategy.version) {
    throw new Error(
      `Candidate strategy must be version ${strategy.version + 1} with parentVersion ${strategy.version}.`
    );
  }
  if (candidate.instructions.trim() === strategy.instructions.trim()) {
    throw new Error("Candidate strategy instructions must differ from the current strategy.");
  }

  const minimumSamples = config.metric.minimumSamples;
  if (experiment.baseline.samples < minimumSamples || experiment.candidate.samples < minimumSamples) {
    throw new Error(`Baseline and candidate each require at least ${minimumSamples} sample(s).`);
  }
  validateMatchedBenchmark(experiment);

  for (const command of config.evaluator.commands) {
    const evidence = experiment.evidence.find((item) => item.command === command);
    if (!evidence) {
      throw new Error(`Missing evolution evidence for configured command: ${command}`);
    }
    if (evidence.exitCode !== 0) {
      throw new Error(`Evolution evidence command failed (${evidence.exitCode}): ${command}`);
    }
  }

  const improvement = config.metric.direction === "maximize"
    ? experiment.candidate.score - experiment.baseline.score
    : experiment.baseline.score - experiment.candidate.score;
  const qualifies = improvement >= config.metric.minimumImprovement;

  let outcome;
  if (!qualifies || experiment.recommendation === "reject") {
    outcome = "rejected";
  } else if (
    !approve &&
    (config.promotion.mode === "human-review" || experiment.recommendation === "needs-human")
  ) {
    outcome = "pending-review";
  } else {
    outcome = "promoted";
  }

  return {
    outcome,
    improvement,
    qualifies,
    candidate,
    baselineVersion: strategy.version,
    candidateVersion: candidate.version
  };
}

function validateMatchedBenchmark(experiment) {
  const expected = experiment.benchmark.caseIds;
  if (new Set(expected).size !== expected.length) {
    throw new Error("Benchmark caseIds must be unique.");
  }
  const baselineIds = experiment.baseline.results.map((result) => result.caseId);
  const candidateIds = experiment.candidate.results.map((result) => result.caseId);
  if (experiment.baseline.samples !== baselineIds.length || experiment.candidate.samples !== candidateIds.length) {
    throw new Error("Experiment samples must equal the number of recorded case results.");
  }
  if (!sameIds(expected, baselineIds) || !sameIds(expected, candidateIds)) {
    throw new Error("Baseline and candidate must evaluate the exact benchmark caseIds.");
  }
  const baselineScore = average(experiment.baseline.results.map((result) => result.score));
  const candidateScore = average(experiment.candidate.results.map((result) => result.score));
  if (Math.abs(baselineScore - experiment.baseline.score) > 1e-9) {
    throw new Error(`Baseline score must be mechanically derived from case results (${baselineScore}).`);
  }
  if (Math.abs(candidateScore - experiment.candidate.score) > 1e-9) {
    throw new Error(`Candidate score must be mechanically derived from case results (${candidateScore}).`);
  }
}

function sameIds(expected, actual) {
  return expected.length === actual.length && [...expected].sort().every((value, index) => value === [...actual].sort()[index]);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function runSucceeded(runLog) {
  return runLog.status === "passed" && runLog.results.length > 0 && runLog.results.every((result) => result.verdict === "pass");
}
