import { ProviderId } from '../config/schema';

export function isRedTeamPersona(personaId: string, charter?: string): boolean {
  const idLower = personaId.toLowerCase();
  if (idLower === 'red_team' || idLower === 'red-team' || idLower === 'skeptic') {
    return true;
  }
  if (charter === 'builtin:red-team' || charter === 'builtin:skeptic') {
    return true;
  }
  return false;
}

export function getModelFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('agy')) {
    return 'anthropic';
  }
  if (m.includes('gpt') || m.includes('codex') || m.includes('openai')) {
    return 'openai';
  }
  if (m.includes('deepseek') || m.includes('glm') || m.includes('grok') || m.includes('synthetic')) {
    return 'deepseek-grok';
  }
  return 'default';
}

export function resolveDualModel(
  primaryModel: string,
  candidateProviders: Array<{ id: ProviderId; model: string }>,
  preferredAdversarialModel?: string,
): { providerId: ProviderId; model: string } {
  if (preferredAdversarialModel) {
    const matched = candidateProviders.find((p) => p.model === preferredAdversarialModel);
    if (matched) {
      return { providerId: matched.id, model: preferredAdversarialModel };
    }
    return { providerId: candidateProviders[0].id, model: preferredAdversarialModel };
  }
  const primaryFamily = getModelFamily(primaryModel);
  const crossCandidate = candidateProviders.find((p) => getModelFamily(p.model) !== primaryFamily);
  if (crossCandidate) {
    return { providerId: crossCandidate.id, model: crossCandidate.model };
  }
  return { providerId: candidateProviders[0].id, model: candidateProviders[0].model };
}

export const RED_TEAM_CHARTER_DEFAULT = `Actively challenge PR diff assumptions, surface edge-case bugs, construct failure scenarios, probe unhandled exceptions, and execute dual-model cross-examination.

## Domain Charter & Core Scope
- Maintain an adversarial mindset: execute dual-model adversarial cross-examination to challenge optimistic approvals and detect hidden defects.
- Construct edge-case exploitation scenarios, race condition vectors, boundary overflows, and unhandled failure modes.
- Perform security bypass detection across authentication mechanisms, authorization gates, and multi-tenant boundary checks.

## Deep Reasoning Protocol
1. Analyze pull request changes with explicit skepticism, actively probing for security bypass vectors, missing checks, and logical flaws.
2. Construct edge-case exploitation sequences (e.g. boundary conditions, race conditions, parameter tampering) to test code robustness.
3. Leverage dual-model adversarial cross-examination to validate findings and uncover subtle vulnerabilities missed by standard review lanes.
4. Challenge underlying architecture and error recovery assumptions to expose silent failure modes or privilege escalation hazards.

## Nit Suppression Rules
- Do NOT flag theoretical edge cases that require impossible system states or broken platform invariants.
- Suppress generic skepticism without a concrete, reproducible failure scenario or vulnerability path.`;

