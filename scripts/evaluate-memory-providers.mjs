#!/usr/bin/env node
import fs from 'node:fs';

function validHead(item, headSha) {
  const candidate = item?.head_sha || item?.headSha || item?.metadata?.head_sha;
  return !candidate || String(candidate).toLowerCase() === String(headSha).toLowerCase();
}

function stateKey(item) {
  return `${item?.claim_id || item?.claimId || item?.event_id || item?.eventId || ''}:${item?.state || ''}`;
}

export function evaluateCorpus({ providerId = 'unknown', cases = [] } = {}) {
  let exactHeadPass = 0;
  let correctionSafetyPass = 0;
  let recallPass = 0;
  for (const testCase of Array.isArray(cases) ? cases : []) {
    const recalled = Array.isArray(testCase.recalled) ? testCase.recalled : [];
    const inHead = recalled.filter((item) => validHead(item, testCase.headSha));
    const noStale = inHead.length === recalled.length;
    if (noStale) exactHeadPass += 1;
    const expected = new Set((testCase.expected || []).map((item) => typeof item === 'string' ? item : stateKey(item)));
    const actual = new Set(inHead.map((item) => typeof item === 'string' ? item : (item.state || stateKey(item))));
    const expectedFound = [...expected].every((item) => actual.has(item) || [...inHead].some((candidate) => stateKey(candidate) === item));
    const noUnexpected = (testCase.forbidden || []).every((forbidden) => !actual.has(forbidden));
    if (expectedFound) recallPass += 1;
    if (expectedFound && noUnexpected && noStale) correctionSafetyPass += 1;
  }
  const total = Math.max(1, Array.isArray(cases) ? cases.length : 0);
  const score = (exactHeadPass + correctionSafetyPass + recallPass) / (3 * total);
  return {
    provider: providerId,
    cases: Array.isArray(cases) ? cases.length : 0,
    exactHeadPass,
    correctionSafetyPass,
    recallPass,
    score: Number(score.toFixed(4)),
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && process.argv[1].endsWith('evaluate-memory-providers.mjs')) {
  const corpusPath = arg('--corpus');
  if (!corpusPath) {
    console.error('Usage: evaluate-memory-providers.mjs --corpus <json> [--provider <id>]');
    process.exit(2);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const result = evaluateCorpus({ providerId: arg('--provider') || 'fixture', cases: corpus.cases || corpus });
  console.log(JSON.stringify(result));
  if (result.score < 1) process.exitCode = 1;
}
