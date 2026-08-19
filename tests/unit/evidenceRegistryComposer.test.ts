import { describe, expect, it, vi } from 'vitest';

const { composeEvidenceRegistries } = require('../../src/mcp/evidenceRegistryComposer.js');

function registry(tools: string[], callImpl: (tool: string) => any) {
  return {
    capabilities: Object.freeze({ enabled: true, readOnly: true, tools }),
    call: vi.fn(async (tool: string) => callImpl(tool)),
  };
}

describe('composeEvidenceRegistries', () => {
  it('dispatches each tool call to the registry that declares it', async () => {
    const nav = registry(['file_read', 'code_search'], (tool) => ({ status: 'ok', tool, source: 'nav' }));
    const zoekt = registry(['code_search_zoekt'], (tool) => ({ status: 'ok', tool, source: 'zoekt' }));
    const composed = composeEvidenceRegistries([nav, zoekt]);

    expect(await composed.call('file_read', {})).toMatchObject({ source: 'nav' });
    expect(await composed.call('code_search_zoekt', {})).toMatchObject({ source: 'zoekt' });
    expect(nav.call).toHaveBeenCalledTimes(1);
    expect(zoekt.call).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable/tool_not_registered for a name no member declares -- no new authority granted', async () => {
    const nav = registry(['file_read'], () => ({ status: 'ok' }));
    const composed = composeEvidenceRegistries([nav]);
    const result = await composed.call('shell_exec', {});
    expect(result).toEqual({ status: 'unavailable', tool: 'shell_exec', reason: 'tool_not_registered' });
  });

  it('aggregates capabilities.tools across members without duplicates', () => {
    const nav = registry(['file_read', 'code_search'], () => ({}));
    const zoekt = registry(['code_search_zoekt'], () => ({}));
    const composed = composeEvidenceRegistries([nav, zoekt]);
    expect(composed.capabilities.tools).toEqual(['file_read', 'code_search', 'code_search_zoekt']);
  });

  it('first registry to declare a tool name wins (stable, deterministic precedence)', async () => {
    const first = registry(['code_search'], () => ({ status: 'ok', source: 'first' }));
    const second = registry(['code_search'], () => ({ status: 'ok', source: 'second' }));
    const composed = composeEvidenceRegistries([first, second]);
    expect(await composed.call('code_search', {})).toMatchObject({ source: 'first' });
  });

  it('reports disabled when every member is disabled', () => {
    const disabledNav = { capabilities: Object.freeze({ enabled: false, readOnly: true, tools: [] }), call: vi.fn() };
    const composed = composeEvidenceRegistries([disabledNav]);
    expect(composed.capabilities.enabled).toBe(false);
  });

  it('ignores non-registry entries (undefined/null) passed in the list', async () => {
    const nav = registry(['file_read'], () => ({ status: 'ok' }));
    const composed = composeEvidenceRegistries([undefined, nav, null]);
    expect(await composed.call('file_read', {})).toMatchObject({ status: 'ok' });
  });
});
