import type { ResourceDefinition, ResourceTemplateDefinition } from '../mcpTypes';

export interface ResourceDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ReviewRunResourceData {
  uri: string;
  owner: string;
  repo: string;
  pr_number: number;
  found: boolean;
  run_id: string | null;
  head_sha: string | null;
  phase: 'queued' | 'evaluating_personas' | 'arbitration' | 'completed';
  verdict: 'SHIP' | 'NACK' | 'COMMENT' | 'FIX_FIRST' | 'PENDING' | 'RUNNING' | 'FAILED';
  attempt_id: string | null;
  check_run: {
    id: number | null;
    url: string | null;
    conclusion: string | null;
  } | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ReviewFindingResourceItem {
  finding_id: string;
  severity: 'P0' | 'P1' | 'P2';
  category: string;
  title: string;
  file_path: string;
  line_start: number;
  line_end: number;
  violated_adrs?: string[];
  rationale: string;
  suggested_fix?: string;
  unresolved: boolean;
  status?: string;
}

export interface ReviewFindingsResourceData {
  uri: string;
  owner: string;
  repo: string;
  pr_number: number;
  total_count: number;
  unresolved_count: number;
  findings: ReviewFindingResourceItem[];
}

export interface PersonaCharterItem {
  id: string;
  name: string;
  charter: string;
  description?: string;
}

export interface ReviewChartersResourceData {
  uri: string;
  owner: string;
  repo: string;
  active_personas: PersonaCharterItem[];
  directives: {
    max_investigation_turns: number;
    lane_call_budget: number;
    zoekt_enabled: boolean;
    [key: string]: unknown;
  };
}

export const RESOURCE_TEMPLATES: ResourceTemplateDefinition[] = [
  {
    uriTemplate: 'review-yeti://runs/{owner}/{repo}/{pr_number}',
    name: 'Pull Request Review Run Status',
    description: 'Current run metadata, phase, attempt ID, overall verdict, and check-runs',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'review-yeti://findings/{owner}/{repo}/{pr_number}',
    name: 'Pull Request Review Findings Ledger',
    description: 'Structured review findings from PostgreSQL ledger (severities, file paths, line anchors, violated ADRs, rationale, suggestions)',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'review-yeti://charters/{owner}/{repo}',
    name: 'Active Review Personas and Directives',
    description: 'Active review personas and repository directives',
    mimeType: 'application/json',
  },
];

export const STATIC_RESOURCES: ResourceDefinition[] = RESOURCE_TEMPLATES.map((t) => ({
  uri: t.uriTemplate,
  name: t.name,
  description: t.description,
  mimeType: t.mimeType,
}));
