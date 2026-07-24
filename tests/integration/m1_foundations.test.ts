import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { validateTicketLinkage } from '../../src/ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from '../../src/constitution/constitutionEngine';
import { createDiffStateStorage, IDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';

describe('Milestone 1 Foundations Integration Test Suite', () => {
  const tmpDir = path.join(__dirname, '../tmp');
  const dbPath = path.join(tmpDir, 'm1_integration.db');
  let storage: IDiffStateStorage;
  let stateManager: DiffStateManager;

  const rawConfigYaml = `
version: "1.0"
quorum:
  minApprovals: 2
  personas:
    - security
    - architecture
    - quality
  effortLevel: medium
ticketEnforcement:
  required: true
  providers:
    - linear
    - jira
    - github
constitution:
  enabled: true
  path: ".github/constitution.md"
`;

  const rawConstitutionMd = `
# Engineering Constitution

## Forbidden Patterns
- Prohibit direct eval execution \`/eval\\(.*?\\)/\`.
- Never hardcode API secrets \`/SECRET_[A-Z0-9]{8,}/\`.

## Directives
- MUST: PR description must contain detailed testing steps.
`;

  const jsonPath = path.join(tmpDir, 'm1_integration.json');

  beforeEach(async () => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
    storage = await createDiffStateStorage(':memory:', jsonPath);
    stateManager = new DiffStateManager(storage);
  });

  afterEach(async () => {
    if (storage) {
      await storage.close();
    }
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
  });

  it('executes full PR lifecycle across multiple commits with config, ticket, constitution, and state manager', async () => {
    // 1. Config Loader Execution
    const config = parseAndValidateConfig(rawConfigYaml);
    expect(config.quorum.minApprovals).toBe(2);
    expect(config.ticketEnforcement.required).toBe(true);

    // 2. Parse Constitution
    const constitution = parseConstitution(rawConstitutionMd);
    expect(constitution.rules.length).toBe(3);

    // --- COMMIT 1 LIFECYCLE ---
    const prCommit1 = {
      owner: 'acme-corp',
      repo: 'payment-service',
      number: 101,
      headSha: 'c111111111111111111111111111111111111111',
      baseSha: 'c000000000000000000000000000000000000000',
      title: 'feat(auth): implement JWT validation [PROJ-101]',
      body: 'Implements JWT token validation. Detailed testing steps: 1. Run auth tests.',
      files: [
        {
          path: 'src/auth/jwt.ts',
          content: 'export function parseToken(raw: string) { return eval(raw); }',
        },
      ],
      hunks: [
        {
          filePath: 'src/auth/jwt.ts',
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 10,
          hunkContent: '+export function parseToken(raw: string) { return eval(raw); }',
        },
      ],
    };

    // Step 2A: Ticket Validation for Commit 1
    const ticketResult1 = validateTicketLinkage({
      title: prCommit1.title,
      body: prCommit1.body,
      config: config.ticketEnforcement,
    });
    expect(ticketResult1.valid).toBe(true);
    expect(ticketResult1.ticketsFound).toContain('PROJ-101');

    // Step 2B: Constitution Evaluation for Commit 1
    const constitutionResult1 = evaluateConstitution({
      constitution,
      prTitle: prCommit1.title,
      prBody: prCommit1.body,
      changedFiles: prCommit1.files,
    });
    expect(constitutionResult1.compliant).toBe(false);
    expect(constitutionResult1.violations.length).toBe(1);
    expect(constitutionResult1.violations[0]).toContain("Forbidden pattern matched in file 'src/auth/jwt.ts'");

    // Step 2C: Diff State Manager Processing for Commit 1
    const stateUpdate1 = await stateManager.processPRCommitUpdate({
      repoOwner: prCommit1.owner,
      repoName: prCommit1.repo,
      prNumber: prCommit1.number,
      headSha: prCommit1.headSha,
      baseSha: prCommit1.baseSha,
      hunks: prCommit1.hunks,
      quorumFindings: [
        {
          filePath: 'src/auth/jwt.ts',
          startLine: 1,
          endLine: 1,
          persona: 'security',
          severity: 'critical',
          comment: 'Forbidden eval execution in JWT parser',
          codeSnippet: 'return eval(raw);',
          ruleId: 'SEC-NO-EVAL',
        },
        {
          filePath: 'src/auth/jwt.ts',
          startLine: 1,
          endLine: 1,
          persona: 'architecture',
          severity: 'minor',
          comment: 'Export function signature should use typed interface',
          codeSnippet: 'export function parseToken(raw: string)',
          ruleId: 'ARCH-TYPED-INTERFACE',
        },
      ],
    });

    expect(stateUpdate1.previousState).toBeNull();
    expect(stateUpdate1.hunksToReview).toHaveLength(1);
    expect(stateUpdate1.activeFindings).toHaveLength(2);
    expect(stateUpdate1.resolvedFindings).toHaveLength(0);

    // --- COMMIT 2 LIFECYCLE ---
    // Developer fixes the eval issue in Commit 2, leaving the architecture finding active
    const prCommit2 = {
      owner: 'acme-corp',
      repo: 'payment-service',
      number: 101,
      headSha: 'c222222222222222222222222222222222222222',
      baseSha: 'c000000000000000000000000000000000000000',
      title: 'feat(auth): implement safe JWT validation [PROJ-101]',
      body: 'Implements safe JWT token validation. Detailed testing steps: 1. Run auth tests.',
      files: [
        {
          path: 'src/auth/jwt.ts',
          content: 'export function parseToken(raw: string) { return JSON.parse(raw); }',
        },
      ],
      hunks: [
        {
          filePath: 'src/auth/jwt.ts',
          oldStart: 1,
          oldLines: 10,
          newStart: 1,
          newLines: 10,
          hunkContent: '+export function parseToken(raw: string) { return JSON.parse(raw); }',
        },
      ],
    };

    // Step 3A: Ticket Validation for Commit 2
    const ticketResult2 = validateTicketLinkage({
      title: prCommit2.title,
      body: prCommit2.body,
      config: config.ticketEnforcement,
    });
    expect(ticketResult2.valid).toBe(true);

    // Step 3B: Constitution Evaluation for Commit 2
    const constitutionResult2 = evaluateConstitution({
      constitution,
      prTitle: prCommit2.title,
      prBody: prCommit2.body,
      changedFiles: prCommit2.files,
    });
    expect(constitutionResult2.compliant).toBe(true);
    expect(constitutionResult2.violations).toEqual([]);

    // Step 3C: Diff State Manager Processing for Commit 2
    const stateUpdate2 = await stateManager.processPRCommitUpdate({
      repoOwner: prCommit2.owner,
      repoName: prCommit2.repo,
      prNumber: prCommit2.number,
      headSha: prCommit2.headSha,
      baseSha: prCommit2.baseSha,
      hunks: prCommit2.hunks,
      quorumFindings: [
        {
          filePath: 'src/auth/jwt.ts',
          startLine: 1,
          endLine: 1,
          persona: 'architecture',
          severity: 'minor',
          comment: 'Export function signature should use typed interface',
          codeSnippet: 'export function parseToken(raw: string)',
          ruleId: 'ARCH-TYPED-INTERFACE',
        },
      ],
    });

    expect(stateUpdate2.previousState).not.toBeNull();
    expect(stateUpdate2.previousState?.headSha).toBe(prCommit1.headSha);
    expect(stateUpdate2.currentState.headSha).toBe(prCommit2.headSha);

    // The eval finding is resolved in Commit 2
    expect(stateUpdate2.resolvedFindings).toHaveLength(1);
    expect(stateUpdate2.resolvedFindings[0].ruleId || stateUpdate2.resolvedFindings[0].comment).toContain('eval');
    expect(stateUpdate2.resolvedFindings[0].status).toBe('RESOLVED');
    expect(stateUpdate2.resolvedFindings[0].resolvedAtCommit).toBe(prCommit2.headSha);

    // The architecture finding remains active
    expect(stateUpdate2.activeFindings).toHaveLength(1);
    expect(stateUpdate2.activeFindings[0].persona).toBe('architecture');

    // Retrieve state directly from storage to confirm persistence
    const savedState = await storage.getPRState(prCommit2.owner, prCommit2.repo, prCommit2.number);
    expect(savedState).not.toBeNull();
    expect(savedState?.headSha).toBe(prCommit2.headSha);
    expect(savedState?.findings).toHaveLength(2);
  });
});
