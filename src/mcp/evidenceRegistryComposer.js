'use strict';

// ADR: knowledge/adr/0329-adopt-zoekt-as-a-bounded-review-time-search-pilot-for-review-yeti.md
//
// Composes multiple read-only evidence tool registries (each shaped like the
// registry returned by createReviewNavigationToolRegistry /
// createZoektSearchTool: `{ capabilities, call(tool, args, options) }`) into
// one registry that dispatches by tool name. This is the seam
// review-pipeline.js's `makeEvidenceRegistry` needs to offer both the
// existing GitHub-blob-backed tools (file_read, file_find, code_search,
// file_read_diff) and the new code_search_zoekt tool without either registry
// knowing about the other. It adds no new authority: a call for a tool name
// no member registry declares is simply `unavailable`, exactly like an
// unregistered tool today.

function composeEvidenceRegistries(registries = []) {
  const members = registries.filter((registry) => registry && typeof registry.call === 'function');
  const toolOwner = new Map();
  for (const registry of members) {
    const tools = Array.isArray(registry.capabilities?.tools) ? registry.capabilities.tools : [];
    for (const tool of tools) {
      if (!toolOwner.has(tool)) toolOwner.set(tool, registry);
    }
  }
  const allTools = [...toolOwner.keys()];
  return Object.freeze({
    capabilities: Object.freeze({
      enabled: members.some((registry) => registry.capabilities?.enabled),
      readOnly: members.every((registry) => registry.capabilities?.readOnly !== false),
      tools: allTools,
    }),
    call: async (tool, args = {}, options = {}) => {
      const owner = toolOwner.get(tool);
      if (!owner) return { status: 'unavailable', tool, reason: 'tool_not_registered' };
      return owner.call(tool, args, options);
    },
  });
}

module.exports = { composeEvidenceRegistries };
