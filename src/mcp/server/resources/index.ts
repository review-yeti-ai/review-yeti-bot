import type { ReadResourceResult } from '../mcpTypes';
import {
  type ResourceDbClient,
  type ReviewRunResourceData,
  type ReviewFindingsResourceData,
  type ReviewChartersResourceData,
  RESOURCE_TEMPLATES,
  STATIC_RESOURCES,
} from './resourceTypes';
import { fetchRunResource } from './runResource';
import { fetchFindingsResource } from './findingsResource';
import { fetchChartersResource } from './chartersResource';

export * from './resourceTypes';
export { fetchRunResource } from './runResource';
export { fetchFindingsResource } from './findingsResource';
export { fetchChartersResource } from './chartersResource';

export type ParsedResourceUri =
  | { type: 'runs'; owner: string; repo: string; prNumber: number }
  | { type: 'findings'; owner: string; repo: string; prNumber: number }
  | { type: 'charters'; owner: string; repo: string };

const RUNS_URI_REGEX = /^review-yeti:\/\/runs\/([^/]+)\/([^/]+)\/(\d+)$/;
const FINDINGS_URI_REGEX = /^review-yeti:\/\/findings\/([^/]+)\/([^/]+)\/(\d+)$/;
const CHARTERS_URI_REGEX = /^review-yeti:\/\/charters\/([^/]+)\/([^/]+)$/;

export function parseResourceUri(uri: string): ParsedResourceUri | null {
  if (typeof uri !== 'string') return null;

  const runsMatch = RUNS_URI_REGEX.exec(uri);
  if (runsMatch) {
    const prNumber = parseInt(runsMatch[3], 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    return {
      type: 'runs',
      owner: runsMatch[1],
      repo: runsMatch[2],
      prNumber,
    };
  }

  const findingsMatch = FINDINGS_URI_REGEX.exec(uri);
  if (findingsMatch) {
    const prNumber = parseInt(findingsMatch[3], 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    return {
      type: 'findings',
      owner: findingsMatch[1],
      repo: findingsMatch[2],
      prNumber,
    };
  }

  const chartersMatch = CHARTERS_URI_REGEX.exec(uri);
  if (chartersMatch) {
    return {
      type: 'charters',
      owner: chartersMatch[1],
      repo: chartersMatch[2],
    };
  }

  return null;
}

export function listResourceCatalog() {
  return {
    resources: STATIC_RESOURCES,
    resourceTemplates: RESOURCE_TEMPLATES,
  };
}

export async function readResourceContent(
  uri: string,
  db?: ResourceDbClient
): Promise<ReadResourceResult> {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }

  let data: ReviewRunResourceData | ReviewFindingsResourceData | ReviewChartersResourceData;

  switch (parsed.type) {
    case 'runs':
      data = await fetchRunResource(parsed.owner, parsed.repo, parsed.prNumber, db);
      break;
    case 'findings':
      data = await fetchFindingsResource(parsed.owner, parsed.repo, parsed.prNumber, db);
      break;
    case 'charters':
      data = await fetchChartersResource(parsed.owner, parsed.repo, db);
      break;
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
