'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { validateReviewWorkflowAssignments } = require('../review/reviewWorkflowAssignments');
const { trustedReviewWorkflowScript } = require('./reviewWorkflowScript');

const REVIEW_WORKFLOW_PACKAGE = '@quintinshaw/pi-dynamic-workflows';
const REVIEW_WORKFLOW_PACKAGE_VERSION = '3.7.0';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/u;

async function importPiWorkflowRuntime() {
  const runtime = await import(REVIEW_WORKFLOW_PACKAGE);
  if (typeof runtime.runWorkflow !== 'function' || typeof runtime.WorkflowAgent !== 'function') {
    throw new Error(`${REVIEW_WORKFLOW_PACKAGE}@${REVIEW_WORKFLOW_PACKAGE_VERSION} does not expose the expected runtime`);
  }
  return Object.freeze({ runWorkflow: runtime.runWorkflow, WorkflowAgent: runtime.WorkflowAgent });
}

/**
 * CommonJS-to-ESM boundary. Installed Action/package callers should pass generated provenance;
 * source tests can exercise the import in isolation without pretending to attest a release.
 */
async function loadPiWorkflowRuntime(options = {}) {
  const { loadBuildProvenance, verifyBuildProvenance } = require('../provenance/buildProvenance');
  const packageRoot = options.packageRoot || path.resolve(__dirname, '../..');
  let provenance = options.provenance;
  if (!provenance) {
    const provenancePath = options.provenancePath || path.join(packageRoot, 'src/provenance/generated-build-provenance.json');
    if (!fs.existsSync(provenancePath)) {
      throw new Error('Pi runtime build provenance is missing; use the lock-backed Action installer or a staged npm package');
    }
    provenance = loadBuildProvenance(provenancePath);
  }
  verifyBuildProvenance({
    packageRoot,
    provenance,
    requireNested: options.requireNested !== false,
  });
  return importPiWorkflowRuntime();
}

function assertRunId(value, label) {
  if (!RUN_ID.test(String(value || ''))) throw new TypeError(`${label} must be an explicit stable workflow run ID`);
}

function resolveRuntimeProvenance(options) {
  if (options.runtime) return null;
  if (options.provenance) return options.provenance;
  const candidate = options.provenancePath || path.resolve(__dirname, '../provenance/generated-build-provenance.json');
  if (!fs.existsSync(candidate)) {
    throw new Error('Pi runtime build provenance is missing; use the lock-backed Action installer or a staged npm package');
  }
  return candidate;
}

async function runDynamicReviewWorkflow(options = {}) {
  if (!options.immutableIdentity || typeof options.immutableIdentity !== 'object' || Array.isArray(options.immutableIdentity)) {
    throw new TypeError('immutableIdentity is required');
  }
  const assignments = validateReviewWorkflowAssignments(options.assignments, options.immutableIdentity);
  assertRunId(options.runId, 'runId');
  if (options.resumeFromRunId !== undefined && options.resumeFromRunId !== null) {
    assertRunId(options.resumeFromRunId, 'resumeFromRunId');
  }
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new TypeError('deadlineMs must be a finite positive number');
  }
  if (!options.agent || typeof options.agent.run !== 'function') throw new TypeError('agent runner is required');

  const requestedConcurrency = options.concurrency === undefined ? assignments.length : Math.floor(Number(options.concurrency));
  const concurrency = Math.max(1, Math.min(16, assignments.length, Number.isFinite(requestedConcurrency) ? requestedConcurrency : assignments.length));
  const provenance = resolveRuntimeProvenance(options);
  const runtime = options.runtime || await loadPiWorkflowRuntime({
    packageRoot: options.packageRoot,
    provenance: provenance && typeof provenance === 'object' ? provenance : undefined,
    provenancePath: typeof provenance === 'string' ? provenance : undefined,
    requireNested: options.requireNestedRuntime !== false,
  });
  const script = trustedReviewWorkflowScript();
  const workflowResult = await runtime.runWorkflow(script.source, {
    args: { assignments, deadlineMs: options.deadlineMs },
    agent: options.agent,
    runId: options.runId,
    resumeFromRunId: options.resumeFromRunId,
    concurrency,
    maxAgents: assignments.length,
    agentTimeoutMs: options.deadlineMs,
    signal: options.signal,
    resumeJournal: options.resumeJournal,
    onAgentJournal: options.onAgentJournal,
    onAgentStart: options.onAgentStart,
    onAgentEnd: options.onAgentEnd,
    onPhase: options.onPhase,
    onRuntimeEvent: options.onRuntimeEvent,
    persistLogs: options.persistLogs ?? false,
  });
  if (!workflowResult || !Array.isArray(workflowResult.result)) throw new Error('Pi workflow returned missing results');
  if (workflowResult.result.length !== assignments.length) {
    throw new Error(`Pi workflow returned ${workflowResult.result.length} results for ${assignments.length} assignments`);
  }
  const nullIndex = workflowResult.result.findIndex((result) => result === null || result === undefined);
  if (nullIndex >= 0) throw new Error(`Pi workflow returned null result for assignment ${assignments[nullIndex].assignmentId}`);
  return Object.freeze({
    ...workflowResult,
    results: Object.freeze([...workflowResult.result]),
    concurrency,
    workflowSchemaVersion: require('./reviewWorkflowScript').REVIEW_WORKFLOW_SCHEMA_VERSION,
    workflowScriptDigest: script.digest,
  });
}

module.exports = {
  REVIEW_WORKFLOW_PACKAGE,
  REVIEW_WORKFLOW_PACKAGE_VERSION,
  loadPiWorkflowRuntime,
  runDynamicReviewWorkflow,
};
