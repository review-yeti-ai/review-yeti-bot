import type { ResourceDbClient, ReviewChartersResourceData, PersonaCharterItem } from './resourceTypes';

export const DEFAULT_ACTIVE_PERSONAS: PersonaCharterItem[] = [
  {
    id: 'architect',
    name: 'Architect',
    charter: 'builtin:architecture',
    description: 'System architecture, modularity, and ADR compliance',
  },
  {
    id: 'security',
    name: 'Security Auditor',
    charter: 'builtin:security',
    description: 'Security, authentication, authorization, and tenant isolation',
  },
  {
    id: 'correctness',
    name: 'Correctness Reviewer',
    charter: 'builtin:correctness',
    description: 'Correctness defects, race conditions, and error propagation',
  },
  {
    id: 'performance',
    name: 'Performance Reviewer',
    charter: 'builtin:performance',
    description: 'Performance bottlenecks, query efficiency, and memory footprint',
  },
];

export const DEFAULT_DIRECTIVES = {
  max_investigation_turns: 3,
  lane_call_budget: 5,
  zoekt_enabled: true,
};

export async function fetchChartersResource(
  owner: string,
  repo: string,
  db?: ResourceDbClient
): Promise<ReviewChartersResourceData> {
  const uri = `review-yeti://charters/${owner}/${repo}`;

  let directives = { ...DEFAULT_DIRECTIVES };
  let activePersonas = [...DEFAULT_ACTIVE_PERSONAS];

  if (db) {
    try {
      const sql = `
        SELECT policy, directives, personas
          FROM repo_review_policies
         WHERE owner = $1 AND repo = $2
         LIMIT 1
      `;
      const res = await db.query(sql, [owner, repo]);
      if (res && res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        if (row.directives && typeof row.directives === 'object') {
          directives = { ...directives, ...row.directives };
        }
        if (Array.isArray(row.personas) && row.personas.length > 0) {
          activePersonas = row.personas;
        }
      }
    } catch {
      // Table may not exist; use default charters and directives
    }
  }

  return {
    uri,
    owner,
    repo,
    active_personas: activePersonas,
    directives,
  };
}
