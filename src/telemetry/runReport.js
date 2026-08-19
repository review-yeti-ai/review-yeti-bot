'use strict';

const { canonicalJson, sha256 } = require('../review/reviewCore');

const RUN_REPORT_VERSION = 'review-run-report-v1';
const MAX_FINDINGS_PER_LANE = 50;
const MAX_LOG_LINE_CHARS = 60_000;
const SEVERITIES = ['P0', 'P1', 'P2'];

function clampString(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).slice(0, maxLength);
}

function boundedInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function laneUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const promptTokens = boundedInteger(usage.promptTokens);
  const completionTokens = boundedInteger(usage.completionTokens);
  const costUSD = typeof usage.costUSD === 'number' && Number.isFinite(usage.costUSD) && usage.costUSD >= 0
    ? Math.round(usage.costUSD * 1_000_000) / 1_000_000
    : undefined;
  if (promptTokens === undefined && completionTokens === undefined && costUSD === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(costUSD === undefined ? {} : { costUSD }),
  };
}

function laneFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.slice(0, MAX_FINDINGS_PER_LANE).map((finding) => ({
    severity: SEVERITIES.includes(String(finding?.severity || '').toUpperCase())
      ? String(finding.severity).toUpperCase()
      : 'P2',
    file: clampString(finding?.file || finding?.path, 300),
    title: clampString(finding?.title || finding?.summary, 200),
  }));
}

function laneReport(lane = {}) {
  const findings = laneFindings(lane.findings);
  const severity = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings) severity[finding.severity] += 1;
  const turnCount = boundedInteger(lane.turnCount ?? lane.investigationTurns);
  const durationMs = boundedInteger(lane.durationMs);
  return {
    persona: clampString(lane.personaId || lane.id || 'unknown', 100),
    decision: clampString(lane.decision || 'UNKNOWN', 40),
    ...(lane.error ? { failureClass: clampString(lane.error, 200) } : {}),
    provider: clampString(lane.provider, 100) || null,
    model: clampString(lane.model, 300) || null,
    ...(turnCount === undefined ? {} : { turnCount }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(laneUsage(lane.usage) ? { usage: laneUsage(lane.usage) } : {}),
    findingCount: findings.length,
    severity,
    findings,
  };
}

/**
 * Full-fidelity, run-local reviewer-noise report. This is deliberately NOT the
 * privacy-bounded reviewTelemetry exporter (pseudonymous personas, closed
 * failure-class set) nor the cloud dashboard event: it is an operator artifact
 * that stays with the run (file + log line + step output path) so callers can
 * measure per-persona flake rate, severity drift, and finding overlap across
 * re-rolls without any external service.
 */
function buildRunReport({
  repository,
  prNumber,
  baseSha,
  headSha,
  diffText,
  verdict,
  coverageStatus,
  personaResults,
  transports,
  investigation,
  startedAt,
  finishedAt,
} = {}) {
  const lanes = (Array.isArray(personaResults) ? personaResults : []).map(laneReport);
  const flaggedFiles = new Map();
  for (const lane of lanes) {
    for (const finding of lane.findings) {
      if (!finding.file) continue;
      if (!flaggedFiles.has(finding.file)) flaggedFiles.set(finding.file, new Set());
      flaggedFiles.get(finding.file).add(lane.persona);
    }
  }
  const overlapFiles = [...flaggedFiles.values()].filter((personas) => personas.size > 1).length;
  const startedAtMs = boundedInteger(startedAt);
  const finishedAtMs = boundedInteger(finishedAt);
  return {
    schemaVersion: RUN_REPORT_VERSION,
    repository: clampString(repository, 300),
    prNumber: boundedInteger(prNumber) ?? 0,
    baseSha: clampString(baseSha, 64),
    headSha: clampString(headSha, 64),
    // Groups re-rolls: empty canary commits change headSha but not diff content.
    diffDigest: sha256(String(diffText || '')),
    verdict: clampString(verdict || 'UNKNOWN', 40),
    coverageStatus: clampString(coverageStatus || 'unknown', 60),
    transports: (Array.isArray(transports) ? transports : [])
      .map((transport) => clampString(transport?.name || transport, 100))
      .filter(Boolean),
    investigation: {
      enabled: Boolean(investigation?.enabled),
      complete: Boolean(investigation?.complete),
    },
    ...(startedAtMs === undefined || finishedAtMs === undefined
      ? {}
      : { durationMs: Math.max(0, finishedAtMs - startedAtMs) }),
    laneCount: lanes.length,
    failedLaneCount: lanes.filter((lane) => lane.decision === 'ERROR').length,
    overlapFileCount: overlapFiles,
    flaggedFileCount: flaggedFiles.size,
    lanes,
  };
}

function renderRunReportLine(report) {
  const full = `[RunReport] ${canonicalJson(report)}`;
  if (full.length <= MAX_LOG_LINE_CHARS) return full;
  const compact = { ...report, lanes: report.lanes.map((lane) => ({ ...lane, findings: [] })) };
  return `[RunReport] ${canonicalJson(compact)}`;
}

function writeRunReport(report, filePath, fsImplementation = require('fs')) {
  fsImplementation.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return filePath;
}

function summarizePersona(reports, persona) {
  const lanes = reports.flatMap((report) => report.lanes.filter((lane) => lane.persona === persona));
  const failed = lanes.filter((lane) => lane.decision === 'ERROR');
  const failureClasses = {};
  for (const lane of failed) {
    const label = lane.failureClass || 'unlabeled';
    failureClasses[label] = (failureClasses[label] || 0) + 1;
  }
  const severity = { P0: 0, P1: 0, P2: 0 };
  for (const lane of lanes) for (const key of SEVERITIES) severity[key] += lane.severity?.[key] || 0;
  return {
    persona,
    runs: lanes.length,
    failed: failed.length,
    failureRate: lanes.length === 0 ? 0 : Math.round((failed.length / lanes.length) * 1000) / 1000,
    failureClasses,
    severity,
  };
}

/**
 * Aggregates run reports into the noise metrics the improvement plan tracks:
 * per-persona flake rate + failure-class histogram, severity distribution,
 * cross-persona finding overlap, and re-roll variance grouped by diffDigest.
 */
function aggregateRunReports(reports = []) {
  const valid = reports.filter((report) => report?.schemaVersion === RUN_REPORT_VERSION);
  const personas = [...new Set(valid.flatMap((report) => report.lanes.map((lane) => lane.persona)))].sort();
  const byDigest = new Map();
  for (const report of valid) {
    if (!byDigest.has(report.diffDigest)) byDigest.set(report.diffDigest, []);
    byDigest.get(report.diffDigest).push(report);
  }
  const rerollGroups = [...byDigest.values()].filter((group) => group.length > 1);
  const inconsistentGroups = rerollGroups.filter(
    (group) => new Set(group.map((report) => report.verdict)).size > 1,
  );
  return {
    schemaVersion: 'review-run-report-summary-v1',
    reportCount: valid.length,
    personas: personas.map((persona) => summarizePersona(valid, persona)),
    verdicts: valid.reduce((counts, report) => {
      counts[report.verdict] = (counts[report.verdict] || 0) + 1;
      return counts;
    }, {}),
    overlap: {
      totalFlaggedFiles: valid.reduce((sum, report) => sum + (report.flaggedFileCount || 0), 0),
      totalOverlapFiles: valid.reduce((sum, report) => sum + (report.overlapFileCount || 0), 0),
    },
    rerolls: {
      groups: rerollGroups.length,
      inconsistentVerdictGroups: inconsistentGroups.length,
    },
  };
}

module.exports = {
  RUN_REPORT_VERSION,
  buildRunReport,
  renderRunReportLine,
  writeRunReport,
  aggregateRunReports,
};
