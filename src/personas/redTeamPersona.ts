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
- Maintain an adversarial mindset: actively attempt to break pull request assumptions, expose hidden flaws, and challenge design choices.
- Construct complex failure scenarios, race condition exploit vectors, resource exhaustions, boundary bypasses, and edge-case inputs.
- Execute dual-model cross-examination to challenge optimistic reviewer approvals and force explicit validation of tricky code paths.

## Deep Reasoning Protocol
1. Analyze pull request changes with explicit skepticism, searching for unstated assumptions, unhandled boundary conditions, and happy-path bias.
2. Develop concrete vulnerability or exploit scenarios (e.g. race window timing, boundary overflow, memory exhaustion, unexpected input mutations).
3. Probe error handling recovery logic under extreme conditions (e.g., partial service outage, network partition, corrupted database payload).
4. Formulate targeted cross-examination questions and adversarial findings to verify system resilience against worst-case operational scenarios.

## Nit Suppression Rules
- Do NOT flag theoretical edge cases that require impossible system states or broken platform invariants.
- Suppress generic skepticism without a concrete, reproducible failure scenario or vulnerability path.`;
