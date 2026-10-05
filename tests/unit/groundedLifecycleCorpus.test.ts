import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findingFingerprint } from '../../src/review/findingConvergence';

const corpusRoot = path.resolve(process.cwd(), 'eval-baselines/grounded-lifecycle-corpus-v1');
const inputRoot = path.join(corpusRoot, 'inputs');
const oraclePath = path.join(corpusRoot, 'oracle/GroundedLifecycleOracle.v1.json');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function readInputs(): any[] {
  if (!pathExists(inputRoot)) return [];
  return readdirSync(inputRoot).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(readFileSync(path.join(inputRoot, file), 'utf8')));
}

function readOracle(): any | null {
  return pathExists(oraclePath) ? JSON.parse(readFileSync(oraclePath, 'utf8')) : null;
}

function pathExists(target: string): boolean {
  try { readFileSync(target); return true; } catch {
    try { readdirSync(target); return true; } catch { return false; }
  }
}

function git(repo: string, args: string[], options: { input?: string | Buffer } = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    input: options.input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trimEnd();
}

function resetSnapshotFiles(repo: string): void {
  for (const entry of readdirSync(repo)) {
    if (entry !== '.git') rmSync(path.join(repo, entry), { recursive: true, force: true });
  }
}

function replaySourceHistory(source: any) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'grounded-lifecycle-corpus-'));
  try {
    git(repo, ['init', '--quiet']);
    const built: Array<{ sha: string; tree: string }> = [];
    for (const revision of source.revisions ?? []) {
      resetSnapshotFiles(repo);
      for (const file of revision.files ?? []) {
        const target = path.join(repo, file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content, 'utf8');
        const blob = git(repo, ['hash-object', '--stdin'], { input: file.content });
        expect(blob).toBe(file.gitBlobSha);
        expect(sha(file.content)).toBe(file.sha256);
      }
      git(repo, ['add', '-A']);
      const tree = git(repo, ['write-tree']);
      expect(tree).toBe(revision.treeSha);
      const commitArgs = ['commit-tree', tree];
      const expectedParent = built.at(-1)?.sha;
      if (expectedParent) commitArgs.push('-p', expectedParent);
      const date = `${revision.commitTimestamp} +0000`;
      const commit = execFileSync('git', ['-C', repo, ...commitArgs], {
        input: `${revision.commitMessage}\n`,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Synthetic Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: 'Synthetic Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_DATE: date,
        },
      }).trim();
      expect(commit).toBe(revision.commitSha);
      expect(revision.parentSha ?? null).toBe(expectedParent ?? null);
      built.push({ sha: commit, tree });
    }
    const base = source.revisions.find((revision: any) => revision.commitSha === source.baseSha);
    const head = source.revisions.find((revision: any) => revision.commitSha === source.headSha);
    expect(base).toBeTruthy();
    expect(head).toBeTruthy();
    expect(built[0]?.sha).toBe(source.baseSha);
    expect(built.at(-1)?.sha).toBe(source.headSha);
    const patch = execFileSync('git', ['-C', repo, 'diff', '--no-ext-diff', '--no-color', source.baseSha, source.headSha], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const diffPaths = [...patch.matchAll(/^diff --git a\/([^ ]+) b\//gmu)].map((match) => match[1]).sort();
    expect(diffPaths).toEqual([...(source.changedPaths ?? [])].sort());
    expect(source.patches.map((entry: any) => entry.path).sort()).toEqual(diffPaths);
    for (const entry of source.patches) {
      expect(entry.patch).toContain(`diff --git a/${entry.path} b/${entry.path}`);
      expect(sha(entry.patch)).toBe(entry.sha256);
      expect(patch).toContain(entry.patch);
    }
    return { repo, patch, built };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function verifierCandidateProjection(candidate: any) {
  return {
    severity: candidate.severity,
    path: candidate.path,
    line: candidate.line,
    title: candidate.title,
    claimType: candidate.claimType,
    fingerprint: candidate.fingerprint,
  };
}

describe('grounded lifecycle qualification corpus', () => {
  it('ships versioned inputs and a separate oracle sidecar', () => {
    const inputs = readInputs();
    const oracle = readOracle();
    expect(inputs.length).toBe(8);
    expect(oracle?.schemaVersion).toBe('GroundedLifecycleOracle.v1');
    expect(Object.keys(oracle?.cases ?? {}).sort()).toEqual(inputs.map((input) => input.caseId).sort());
  });

  it('pins every synthetic source revision, blob, and diff to exact Git identities', () => {
    const inputs = readInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.schemaVersion).toBe('GroundedLifecycleInput.v1');
      expect(input.source.revisions.length).toBeGreaterThanOrEqual(2);
      expect(input.source.baseSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(input.source.headSha).toMatch(/^[a-f0-9]{40}$/u);
      replaySourceHistory(input.source);
      for (const candidate of input.candidates) {
        expect(findingFingerprint(candidate)).toBe(candidate.fingerprint);
      }
    }
  });

  it('covers repair, unrelated history, resolved P2, reopening, stale evidence, and stable replays', () => {
    const inputs = readInputs();
    const oracle = readOracle()?.cases ?? {};
    const allCandidates = inputs.flatMap((input) => input.candidates.map((candidate: any) => ({ input, candidate })));
    const crossFileRepair = inputs.find((input) => input.source.changedPaths.length >= 2
      && input.candidates.some((candidate: any) => input.source.changedPaths.includes(candidate.path))
      && oracle[input.caseId]?.expectation?.groundedReviewReceipt?.verification?.outcomes
        ?.some((outcome: any) => outcome.status === 'contradicted' && outcome.relatedDiffPaths?.length >= 2));
    expect(crossFileRepair).toBeTruthy();

    const unrelatedPriorNit = allCandidates.find(({ input, candidate }) => !input.source.changedPaths.includes(candidate.path)
      && ['P2', 'P3', 'NIT'].includes(candidate.severity));
    expect(unrelatedPriorNit).toBeTruthy();
    const unrelatedOracleOutcomes = oracle[unrelatedPriorNit?.input.caseId]?.expectation?.groundedReviewReceipt?.verification?.outcomes ?? [];
    expect(unrelatedOracleOutcomes.some((outcome: any) => outcome.fingerprint === unrelatedPriorNit?.candidate.fingerprint)).toBe(false);
    const unrelatedFileAtBase = unrelatedPriorNit?.input.source.revisions[0].files.find((file: any) => file.path === unrelatedPriorNit.candidate.path);
    const unrelatedFileAtHead = unrelatedPriorNit?.input.source.revisions.at(-1).files.find((file: any) => file.path === unrelatedPriorNit.candidate.path);
    expect(unrelatedFileAtBase?.content).toBe(unrelatedFileAtHead?.content);

    const resolvedP2 = inputs.find((input) => input.history.load.findings.some((finding: any) =>
      finding.sourceSeverity === 'P2' && finding.disposition === 'resolved')
      && input.history.load.events.some((event: any) => event.eventType === 'finding-resolution-recorded'));
    expect(resolvedP2).toBeTruthy();
    const resolvedFinding = resolvedP2?.history.load.findings.find((finding: any) =>
      finding.sourceSeverity === 'P2' && finding.disposition === 'resolved');
    const resolutionReceipt = resolvedP2?.history.load.events.find((event: any) =>
      event.eventType === 'finding-resolution-recorded');
    expect(resolutionReceipt?.verification?.findingEventId).toBe(resolvedFinding?.findingEventId);
    expect(resolutionReceipt?.verification?.fingerprint).toBe(resolvedFinding?.fingerprint);
    expect(resolutionReceipt?.verification?.status).toBe('contradicted');
    expect(oracle[resolvedP2?.caseId]?.expectation?.groundedReviewReceipt?.history?.status).toBe('complete');
    expect(oracle[resolvedP2?.caseId]?.expectation?.reviewDecisionClass).toBe('SHIP');

    const reopenedP1 = inputs.find((input) => input.source.revisions.length >= 3 && input.candidates.some((candidate: any) =>
      candidate.severity === 'P1' && input.history.load.findings.some((finding: any) =>
        finding.fingerprint === candidate.fingerprint && finding.sourceSeverity === 'P2' && finding.disposition === 'resolved')));
    expect(reopenedP1).toBeTruthy();
    expect(reopenedP1?.source.changedPaths.length).toBeGreaterThan(0);
    const priorP2 = reopenedP1?.history.load.findings.find((finding: any) => finding.sourceSeverity === 'P2'
      && finding.disposition === 'resolved');
    expect(priorP2?.lastSeenHead).toBe(reopenedP1?.source.revisions.at(-2)?.commitSha);
    expect(priorP2?.lastSeenHead).not.toBe(reopenedP1?.source.headSha);
    expect(reopenedP1?.source.changedPaths).toEqual(['audience-contract.ts', 'router.ts']);
    const reopenedOutcome = oracle[reopenedP1?.caseId]?.expectation?.groundedReviewReceipt?.verification?.outcomes
      ?.find((outcome: any) => outcome.fingerprint === reopenedP1?.candidates.find((candidate: any) => candidate.severity === 'P1')?.fingerprint);
    expect(reopenedOutcome?.status).toBe('confirmed');

    const staleHistory = inputs.find((input) => input.history.sourceObservation?.validation === 'identity-mismatch'
      && input.history.load.status === 'unavailable');
    expect(staleHistory).toBeTruthy();
    expect(staleHistory?.history.sourceObservation.snapshot.headSha).not.toBe(staleHistory?.source.headSha);
    expect(staleHistory?.history.load.events).toEqual([]);
    expect(staleHistory?.history.load.findings).toEqual([]);
    const forgedHistory = inputs.find((input) => input.history.sourceObservation?.validation === 'digest-mismatch'
      && input.history.load.status !== 'complete');
    expect(forgedHistory).toBeTruthy();
    expect(forgedHistory?.history.sourceObservation.digestMatches).toBe(false);
    expect(forgedHistory?.history.sourceObservation.expectedEventsDigest)
      .not.toBe(forgedHistory?.history.sourceObservation.suppliedEventsDigest);

    const coverageGap = inputs.find((input) => input.candidates.length === 1
      && input.candidates[0].claimType === 'missing-tests');
    expect(coverageGap).toBeTruthy();
    expect(coverageGap?.source.changedPaths).toContain(coverageGap?.candidates[0].path);
    const coverageGapReceipt = oracle[coverageGap?.caseId]?.expectation?.groundedReviewReceipt;
    expect(coverageGapReceipt?.verification?.outcomes).toEqual([expect.objectContaining({
      fingerprint: coverageGap?.candidates[0].fingerprint,
      severity: 'P2',
      status: 'confirmed',
      decisionEffect: 'advisory-nonblocking',
      blocking: false,
    })]);
    expect(oracle[coverageGap?.caseId]?.expectation?.reviewDecisionClass).toBe('SHIP');

    const genericBehavior = inputs.find((input) => input.caseId !== coverageGap?.caseId
      && input.candidates.some((candidate: any) => candidate.severity === 'P1' && candidate.claimType === 'generic')
      && oracle[input.caseId]?.expectation?.groundedReviewReceipt?.verification?.outcomes
        ?.some((outcome: any) => outcome.decisionEffect === 'blocking'));
    expect(genericBehavior).toBeTruthy();
    const behaviorOutcome = oracle[genericBehavior?.caseId]?.expectation?.groundedReviewReceipt?.verification?.outcomes[0];
    expect(behaviorOutcome.status).toBe('confirmed');
    const rawBehaviorFinding = genericBehavior?.proposerFindings?.[0];
    expect(rawBehaviorFinding?.body).toMatch(/add a regression test/i);
    const normalizedBehavior = genericBehavior?.candidates.find((candidate: any) => candidate.severity === 'P1');
    expect(normalizedBehavior?.claimType).toBe('generic');
    expect(normalizedBehavior?.severity).toBe('P1');
    const blindBehaviorClaim = verifierCandidateProjection({ ...normalizedBehavior, body: rawBehaviorFinding?.body });
    expect(blindBehaviorClaim.claimType).toBe('generic');
    expect(blindBehaviorClaim.severity).toBe('P1');
    expect(JSON.stringify(blindBehaviorClaim)).not.toMatch(/regression test|proposer/u);
    expect(behaviorOutcome.requiredEvidenceRefs).toEqual([
      'base:route-policy.ts', 'head:route-policy.ts', 'diff:route-policy.ts', 'diff:audience-contract.ts',
    ]);
    expect(genericBehavior?.source.changedPaths).toEqual(['audience-contract.ts', 'route-policy.ts']);
    expect(oracle[genericBehavior?.caseId]?.expectation?.reviewDecisionClass).toBe('BLOCK');

    const repeat = inputs.find((input) => input.replay?.identicalRuns === 2);
    expect(repeat).toBeTruthy();
    const replayed = Array.from({ length: repeat?.replay.identicalRuns ?? 0 }, () => repeat?.candidates.map(verifierCandidateProjection));
    expect(replayed[1]).toEqual(replayed[0]);
    expect(repeat?.source.headSha).toBe(repeat?.replay.headSha);
    const repeatExpectation = oracle[repeat?.caseId]?.expectation?.repeatExpectation;
    expect(repeatExpectation?.identicalRuns).toBe(2);
    expect(repeatExpectation?.stableFingerprint).toBe(repeat?.candidates[0].fingerprint);
    expect(repeatExpectation?.stableStatus).toBe('confirmed');
    expect(repeatExpectation?.stableDecisionClass).toBe(oracle[repeat?.caseId]?.expectation?.reviewDecisionClass);
  });

  it('keeps oracle, history prose, and proposer-only fields out of the verifier candidate projection', () => {
    const input = readInputs()[0];
    expect(input).toBeTruthy();
    const candidate = {
      ...input.candidates[0],
      body: 'synthetic proposer rationale',
      proposerEvidence: 'synthetic proposer evidence',
      authorReceipt: 'GroundedReviewReceipt.v1 synthetic sealed context',
      expectedStatus: 'confirmed',
      historyText: 'synthetic historical prose',
    };
    const projected = verifierCandidateProjection(candidate);
    expect(Object.keys(projected).sort()).toEqual(['claimType', 'fingerprint', 'line', 'path', 'severity', 'title']);
    expect(JSON.stringify(projected)).not.toMatch(/proposer|receipt|history|expectedStatus|synthetic rationale/u);
    expect(JSON.stringify(input.candidates.map(verifierCandidateProjection))).not.toContain('synthetic historical prose');
    expect(JSON.stringify(projected)).not.toContain('GroundedLifecycleOracle.v1');
  });

  it('keeps every repository identity synthetic and endpoint-free', () => {
    const inputs = readInputs();
    const serialized = JSON.stringify(inputs);
    for (const input of inputs) {
      expect(input.source.repository).toEqual({ repositoryId: 73001, owner: 'synthetic', repo: 'fixture-project' });
    }
    expect(serialized).not.toMatch(/https?:\/\/|Bearer\s|gh[pousr]_[A-Za-z0-9_]+|exampleorg|customer/iu);
  });

  it('pins oracle tri-state results and budget expectations without including them in inputs', () => {
    const inputs = readInputs();
    const oracle = readOracle()?.cases ?? {};
    for (const input of inputs) {
      const expectation = oracle[input.caseId]?.expectation;
      const receipt = expectation?.groundedReviewReceipt;
      expect(receipt?.version).toBe('GroundedReviewReceipt.v1');
      expect(['SHIP', 'FIX_FIRST', 'BLOCK', 'INCOMPLETE']).toContain(expectation?.reviewDecisionClass);
      expect(['complete', 'partial', 'unavailable']).toContain(receipt?.history?.status);
      const outcomes = receipt?.verification?.outcomes ?? [];
      expect(outcomes.every((outcome: any) => ['confirmed', 'contradicted', 'insufficient'].includes(outcome.status))).toBe(true);
      expect(receipt?.verification?.budget?.totalCalls).toBeGreaterThan(0);
      expect(receipt?.verification?.expectedCallsMaximum).toBeLessThanOrEqual(receipt?.verification?.budget?.totalCalls);
      expect(receipt?.verification?.candidates).toBe(outcomes.length);
      expect(receipt?.verification?.confirmed).toBe(outcomes.filter((outcome: any) => outcome.status === 'confirmed').length);
      expect(receipt?.verification?.contradicted).toBe(outcomes.filter((outcome: any) => outcome.status === 'contradicted').length);
      expect(receipt?.verification?.insufficient).toBe(outcomes.filter((outcome: any) => outcome.status === 'insufficient').length);
      expect(Object.keys(input)).not.toContain('oracle');
      expect(Object.keys(input)).not.toContain('expected');
      expect(JSON.stringify(input)).not.toContain('GroundedLifecycleOracle.v1');
      expect(input.caseId).toMatch(/^lc_[a-f0-9]{16}$/u);
      for (const candidate of input.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(['claimType', 'fingerprint', 'line', 'path', 'severity', 'title']);
      }
      if (input.history.load.status === 'complete') {
        expect(input.history.sourceObservation.validation).toBe('accepted');
        expect(input.history.sourceObservation.snapshot.headSha).toBe(input.source.headSha);
        expect(input.history.sourceObservation.snapshot.baseSha).toBe(input.source.baseSha);
        expect(input.history.load.eventsDigest).toBe(sha(JSON.stringify(input.history.load.events.map((event: any) => event.eventId))));
        expect(input.history.load.findingsDigest).toBe(sha(JSON.stringify(input.history.load.findings.map((finding: any) => finding.findingEventId))));
      }
    }
  });
});
