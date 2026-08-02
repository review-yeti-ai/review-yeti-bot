import { handleSearchSessions } from './tools/searchSessions.js';
import { handleGetSessionDetails } from './tools/getSessionDetails.js';
import { handleGetSessionKpis } from './tools/getSessionKpis.js';

/** Build the explicit MCP tool registry. The repository adapter is supplied by the host. */
export function buildToolRegistry() {
  return new Map([
    ['search_sessions', { name: 'search_sessions', handler: handleSearchSessions }],
    ['get_session_details', { name: 'get_session_details', handler: handleGetSessionDetails }],
    ['get_session_kpis', { name: 'get_session_kpis', handler: handleGetSessionKpis }],
  ]);
}
