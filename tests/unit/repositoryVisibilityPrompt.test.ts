import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel, repositoryVisibilityPromptLines } from '../../src/panel/panelEngine';
import { normalizeRepositoryVisibility, REPOSITORY_VISIBILITY_INSTRUCTION } from '../../src/review/repositoryVisibility';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';

// ct-meta#2884 (2026-09-08): the reviewer blocked a PR archiving internal planning
// docs (cluster IPs, registry digest pins, secret variable NAMES, no secret values)
// into a PRIVATE repository with four P1s of the shape "if this repo is public,
// this is reconnaissance-grade disclosure". Repository visibility was never part
// of the persona's input, so it hedged toward the unsafe assumption. These tests
// prove the visibility fact is now a binding, verbatim, testable part of every
// persona/moderator/arbiter prompt -- and that a missing/failed lookup degrades to
// UNKNOWN rather than throwing or silently defaulting to PUBLIC or PRIVATE.

function buildSinglePersonaConfig(): CtReviewConfigV3 {
  return {
    ...createDefaultV3Config(),
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'medium',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

/** Captures every prompt (messages[1].content) sent to the mock model client, keyed by role. */
function makeCapturingClient() {
  const prompts: { persona: string[]; moderator: string[]; arbiter: string[] } = {
    persona: [],
    moderator: [],
    arbiter: [],
  };
  const complete = vi.fn().mockImplementation(async (opts: any) => {
    const prompt = opts.messages[1].content as string;
    const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
    const nonce = nonceMatch ? nonceMatch[1].trim() : '';
    const allMsg = JSON.stringify(opts.messages);
    if (allMsg.includes("persona 'arbiter'")) {
      prompts.arbiter.push(prompt);
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Clean panel.' })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    }
    if (allMsg.includes("persona 'moderator'")) {
      prompts.moderator.push(prompt);
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    }
    prompts.persona.push(prompt);
    return {
      model: opts.model,
      content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
      usage: null,
      costUSD: null,
    };
  });
  return { complete, prompts };
}

describe('panelEngine.ts — repository visibility prompt fact', () => {
  it('normalizes a webhook boolean/string/absence into the tri-state contract', () => {
    expect(normalizeRepositoryVisibility(true)).toBe('PRIVATE');
    expect(normalizeRepositoryVisibility(false)).toBe('PUBLIC');
    expect(normalizeRepositoryVisibility('private')).toBe('PRIVATE');
    expect(normalizeRepositoryVisibility('PUBLIC')).toBe('PUBLIC');
    expect(normalizeRepositoryVisibility('internal')).toBe('PRIVATE');
    expect(normalizeRepositoryVisibility(undefined)).toBe('UNKNOWN');
    expect(normalizeRepositoryVisibility(null)).toBe('UNKNOWN');
    expect(normalizeRepositoryVisibility('nonsense')).toBe('UNKNOWN');
  });

  it('renders the exact binding instruction text for a given visibility', () => {
    const lines = repositoryVisibilityPromptLines('PRIVATE');
    expect(lines[0]).toBe('Repository visibility: PRIVATE.');
    expect(lines[1]).toBe(REPOSITORY_VISIBILITY_INSTRUCTION);
  });

  it('threads "Repository visibility: PRIVATE" into every persona/moderator/arbiter prompt', async () => {
    const { complete, prompts } = makeCapturingClient();
    const result = await executePersonaPanel({
      config: buildSinglePersonaConfig(),
      changedFiles: [{ path: 'src/main.ts', patch: '+ nothing sensitive' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'sha-private',
      repositoryVisibility: 'PRIVATE',
      client: { complete } as any,
    });

    expect(result.arbiter.verdict).toBe('SHIP');
    for (const prompt of [...prompts.persona, ...prompts.moderator, ...prompts.arbiter]) {
      expect(prompt).toContain('Repository visibility: PRIVATE.');
      expect(prompt).toContain(REPOSITORY_VISIBILITY_INSTRUCTION);
    }
    expect(prompts.persona.length + prompts.moderator.length + prompts.arbiter.length).toBeGreaterThan(0);
  });

  it('threads "Repository visibility: PUBLIC" into every prompt when the repository is public', async () => {
    const { complete, prompts } = makeCapturingClient();
    await executePersonaPanel({
      config: buildSinglePersonaConfig(),
      changedFiles: [{ path: 'src/main.ts', patch: '+ nothing sensitive' }],
      repository: 'calltelemetry/calltelemetry',
      headSha: 'sha-public',
      repositoryVisibility: 'PUBLIC',
      client: { complete } as any,
    });

    for (const prompt of [...prompts.persona, ...prompts.moderator, ...prompts.arbiter]) {
      expect(prompt).toContain('Repository visibility: PUBLIC.');
    }
  });

  it('degrades to "Repository visibility: UNKNOWN" when visibility is omitted entirely (never guesses PUBLIC or PRIVATE)', async () => {
    const { complete, prompts } = makeCapturingClient();
    await executePersonaPanel({
      config: buildSinglePersonaConfig(),
      changedFiles: [{ path: 'src/main.ts', patch: '+ nothing sensitive' }],
      repository: 'owner/repo',
      headSha: 'sha-unknown',
      // repositoryVisibility intentionally omitted -- simulates every call site
      // (webhook payload had neither field, and the fallback GitHub lookup failed).
      client: { complete } as any,
    });

    for (const prompt of [...prompts.persona, ...prompts.moderator, ...prompts.arbiter]) {
      expect(prompt).toContain('Repository visibility: UNKNOWN.');
      expect(prompt).not.toContain('Repository visibility: PRIVATE.');
      expect(prompt).not.toContain('Repository visibility: PUBLIC.');
    }
  });

  it('a rewording that drops the binding rule text would fail this assertion (verbatim guard)', async () => {
    const { complete, prompts } = makeCapturingClient();
    await executePersonaPanel({
      config: buildSinglePersonaConfig(),
      changedFiles: [{ path: 'src/main.ts', patch: '+ nothing sensitive' }],
      repository: 'owner/repo',
      headSha: 'sha-verbatim',
      repositoryVisibility: 'PRIVATE',
      client: { complete } as any,
    });

    const exactSentence =
      'In a PRIVATE repository, internal hostnames, IP addresses, registry paths, image digests, private repository names and secret variable NAMES are not a disclosure and must not be rated P0/P1 on that basis; only a literal credential VALUE is. In a PUBLIC repository the same material IS a disclosure. If visibility is UNKNOWN, report the concern as P2 and say visibility could not be determined.';
    expect(prompts.persona[0]).toContain(exactSentence);
  });
});
