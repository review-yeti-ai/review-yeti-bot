// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { RepoMemoryPivotPlatform } from '@/components/analytics/RepoMemoryPivotPlatform';
import MemoryPage from '@/app/memory/page';
import { fetchMemoryStats, purgeMemoryCache, exportMemorySnapshot } from '@/lib/api-client';

describe('RepoMemoryPivotPlatform Component Suite', () => {
  it('renders the interactive pivot control bar with all repository tabs', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Check title and badges
    expect(screen.getByText('Repository Memory & Cache Pivot')).toBeInTheDocument();
    expect(screen.getByText('Multi-Dimensional Matrix')).toBeInTheDocument();

    // Check repository pivot buttons
    expect(screen.getByText(/All Repositories \(3\)/)).toBeInTheDocument();
    expect(screen.getByText('review-yeti-bot')).toBeInTheDocument();
    expect(screen.getByText('sample-cdr')).toBeInTheDocument();
    expect(screen.getByText('sample-meta')).toBeInTheDocument();

    // Check timeline buttons
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('90d')).toBeInTheDocument();

    // Check metric switchers
    expect(screen.getByTestId('metric-btn-hit_rate')).toBeInTheDocument();
    expect(screen.getByTestId('metric-btn-compaction')).toBeInTheDocument();
    expect(screen.getByTestId('metric-btn-symbols')).toBeInTheDocument();
    expect(screen.getByTestId('metric-btn-velocity')).toBeInTheDocument();
  });

  it('renders the high-density repository matrix table with all 3 pilot repositories', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Table header and repos
    expect(screen.getByText(/Repository Matrix/i)).toBeInTheDocument();
    const tbody = screen.getByTestId('repo-matrix-tbody');
    expect(within(tbody).getByText('reviewyeti-ai/review-yeti-bot')).toBeInTheDocument();
    expect(within(tbody).getByText('example/sample-cdr')).toBeInTheDocument();
    expect(within(tbody).getByText('example/sample-meta')).toBeInTheDocument();

    // Check hit rate and size numbers inside table
    expect(within(tbody).getByText('95.8%')).toBeInTheDocument();
    expect(within(tbody).getByText('780 KB')).toBeInTheDocument();
    expect(within(tbody).getByText('93.4%')).toBeInTheDocument();
    expect(within(tbody).getByText('1120 KB')).toBeInTheDocument();
    expect(within(tbody).getByText('97.1%')).toBeInTheDocument();
    expect(within(tbody).getByText('260 KB')).toBeInTheDocument();
  });

  it('filters data matrix when switching repository pivot tabs', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Click 'sample-cdr' button
    const ciscoBtn = screen.getByText('sample-cdr');
    fireEvent.click(ciscoBtn);

    // Only sample-cdr should remain in the filtered matrix table
    const tbody = screen.getByTestId('repo-matrix-tbody');
    expect(within(tbody).getByText('example/sample-cdr')).toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/review-yeti-bot')).not.toBeInTheDocument();
    expect(within(tbody).queryByText('example/sample-meta')).not.toBeInTheDocument();

    // Reset back to All Repositories
    const allBtn = screen.getByText(/All Repositories \(3\)/);
    fireEvent.click(allBtn);

    expect(within(tbody).getByText('reviewyeti-ai/review-yeti-bot')).toBeInTheDocument();
    expect(within(tbody).getByText('example/sample-cdr')).toBeInTheDocument();
  });

  it('switches timeline horizon and metric dimensions', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Switch to 24h
    const btn24h = screen.getByText('24h');
    fireEvent.click(btn24h);
    expect(screen.getByText('Horizon: 24h')).toBeInTheDocument();

    // Switch to Compaction metric
    const compactionBtn = screen.getByTestId('metric-btn-compaction');
    fireEvent.click(compactionBtn);
    expect(
      screen.getByText(/Context Compaction Multiplier \(x Reduction\)/i)
    ).toBeInTheDocument();

    // Switch to Symbols metric
    const symbolsBtn = screen.getByTestId('metric-btn-symbols');
    fireEvent.click(symbolsBtn);
    expect(screen.getByText(/Indexed AST Symbol Nodes \(Volume\)/i)).toBeInTheDocument();

    // Switch to Velocity metric
    const velocityBtn = screen.getByTestId('metric-btn-velocity');
    fireEvent.click(velocityBtn);
    expect(
      screen.getByText(/PR Review Turnaround Velocity \(Seconds\)/i)
    ).toBeInTheDocument();
  });

  it('opens and closes the slide-over deep-dive drawer when clicking a repo row or button', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Deep-dive drawer should not be in document initially
    expect(screen.queryByTestId('repo-deep-dive-drawer')).not.toBeInTheDocument();

    // Click the deep-dive button for review-yeti-bot
    const deepDiveButtons = screen.getAllByText('Deep-Dive');
    fireEvent.click(deepDiveButtons[0]);

    // Drawer should now be visible
    expect(screen.getByTestId('repo-deep-dive-drawer')).toBeInTheDocument();
    expect(screen.getByText('AST Symbol Taxonomy')).toBeInTheDocument();
    expect(screen.getByText(/Active R2 Cache Objects/i)).toBeInTheDocument();
    expect(screen.getByText('ast-outline-review-yeti-bot-pr241.tar.zst')).toBeInTheDocument();

    // Close the drawer
    const closeBtn = screen.getByText('Close Drawer');
    fireEvent.click(closeBtn);

    expect(screen.queryByTestId('repo-deep-dive-drawer')).not.toBeInTheDocument();
  });

  it('filters data matrix by keyword search', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    const searchInput = screen.getByPlaceholderText(/Filter repository name or language/i);
    fireEvent.change(searchInput, { target: { value: 'Elixir' } });

    const tbody = screen.getByTestId('repo-matrix-tbody');
    expect(within(tbody).getByText('example/sample-cdr')).toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/review-yeti-bot')).not.toBeInTheDocument();
    expect(within(tbody).queryByText('example/sample-meta')).not.toBeInTheDocument();

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(within(tbody).getByText('reviewyeti-ai/review-yeti-bot')).toBeInTheDocument();
  });
});


vi.mock('@/lib/api-client', async () => ({
  ...await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client'),
  fetchMemoryStats: vi.fn(),
  purgeMemoryCache: vi.fn(),
  exportMemorySnapshot: vi.fn(),
}));



function memoryResponse() {
  const repositories = ['exampleorg/example-api', 'reviewyeti-ai/example-meta'];
  return {
    success: true,
    r2: { bucket: 'example-memory', objectCount: 2, totalBytes: 2048, hitRatePercent: 95 },
    compaction: { ratio: '4.2x', boundsReduction: '76%', lockfilesBypassed: '100%' },
    workspaces: repositories.map((repository, i) => ({ key: `example-outline-${i}`, repository, prNumber: i + 1, symbolCount: 100 + i, outlineDepth: 3, rawSizeKb: 20, compactedSizeKb: 5, compactionRatio: '4x', ttlMinutes: 20, status: i === 0 ? 'ready' : 'expired', lastHydratedAt: '2026-10-02T00:00:00Z' })),
    learnings: repositories.map((repo, i) => ({ id: `example-learning-${i}`, repo, prNumber: i + 1, category: i === 0 ? 'security' : 'architecture', title: i === 0 ? 'Quoted "boundary" rule' : 'Architecture ledger', description: 'Verify public filtering', filePath: `src/example-${i}.ts`, confidence: 0.95, triggersCount: 2, lastApplied: '2026-10-02T00:00:00Z' })),
    suppressedNits: repositories.map((repo, i) => ({ id: `example-nit-${i}`, ruleId: `sample-rule-${i}`, repo, prNumber: i + 1, pattern: `Quoted "sample" ${i}`, filePath: `src/nit-${i}.ts`, reason: 'Existing sample convention', suppressionCount: 3 })),
    adrConstraints: repositories.map((repo, i) => ({ id: `example-adr-${i}`, repo, adrNumber: i + 1, title: `Sample ADR ${i}`, rule: 'Keep public interfaces stable', targetPaths: [`src/adr-${i}.ts`], status: 'active' })),
    analytics: {
      timeline: [{ period: 'now', symbols: 200, cachedBytes: 2048, hitRate: 95, compactionRatio: 4.2 }],
      categoryDistribution: [{ name: 'security', count: 1, percentage: 50, color: '#00ff00' }, { name: 'architecture', count: 1, percentage: 50, color: '#0000ff' }],
      repoMetrics: repositories.map(repo => ({ repo, cachedBytes: 1024, hitRate: 95, symbols: 100, activeRules: 1 })),
    },
  };
}

function selectMemoryTab(name: RegExp) {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  expect(tab).toHaveAttribute('data-state', 'active');
}

async function renderMemoryPage() {
  render(<MemoryPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}

describe('MemoryPage public neutral state and export controls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchMemoryStats).mockResolvedValue(memoryResponse() as Awaited<ReturnType<typeof fetchMemoryStats>>);
    vi.mocked(purgeMemoryCache).mockResolvedValue({ success: true, message: 'Sample cache sweep completed', deletedCount: 2 });
    vi.mocked(exportMemorySnapshot).mockResolvedValue({ success: true, sha256Digest: 'a'.repeat(64) });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the public memory contract, filters both sample repositories and restores all filters', async () => {
    await renderMemoryPage();
    selectMemoryTab(/Workspaces & R2 Cache/);
    expect(screen.getByText('example-outline-0', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('example-outline-1', { exact: false })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'example-api' } });
    expect(screen.getByText('example-outline-0', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('example-outline-1', { exact: false })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'example-meta' } });
    expect(screen.getByText('example-outline-1', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear filters'));
    expect(screen.getByText('example-outline-0', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('all');
  });

  it('searches public ledger fields and category chips without retaining unrelated rules', async () => {
    await renderMemoryPage();
    selectMemoryTab(/Knowledge Ledger/);
    const search = screen.getByPlaceholderText(/Filter by keyword, symbol/);
    const records = ['Quoted "boundary" rule', 'Architecture ledger', 'Quoted "sample" 0', 'Quoted "sample" 1', 'Sample ADR 0', 'Sample ADR 1'];
    const expectVisibleRecords = (expected: string[]) => {
      for (const title of records) {
        if (expected.includes(title)) expect(screen.getByText(title)).toBeInTheDocument();
        else expect(screen.queryByText(title)).not.toBeInTheDocument();
      }
    };
    const searches: Array<{ query: string; expected: string[] }> = [
      { query: 'boundary', expected: [records[0]] },
      { query: 'public filtering', expected: [records[0], records[1]] },
      { query: 'src/example-0', expected: [records[0]] },
      { query: 'exampleorg/example-api', expected: [records[0]] },
      { query: 'sample convention', expected: [records[2], records[3]] },
      { query: 'Quoted "sample" 0', expected: [records[2]] },
      { query: 'src/nit-0', expected: [records[2]] },
      { query: 'sample-rule-0', expected: [records[2]] },
      { query: 'Sample ADR 0', expected: [records[4]] },
      { query: 'interfaces stable', expected: [records[4], records[5]] },
      { query: 'src/adr-0', expected: [records[4]] },
      { query: 'no-such-symbol', expected: [] },
    ];
    for (const { query, expected } of searches) {
      fireEvent.change(search, { target: { value: query } });
      expect(search).toHaveValue(query);
      expectVisibleRecords(expected);
    }
    fireEvent.click(screen.getByText('✕'));
    expect(search).toHaveValue('');
    expectVisibleRecords(records);
    const categories = [
      { label: 'Sec', expected: [records[0]] },
      { label: 'Arch', expected: [records[1]] },
      { label: 'Perf', expected: [] },
      { label: 'Nits', expected: [records[2], records[3]] },
      { label: 'ADRs', expected: [records[4], records[5]] },
      { label: 'All', expected: records },
    ];
    for (const { label, expected } of categories) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expectVisibleRecords(expected);
    }
  });

  it('exports only the chosen sample scope in JSON, Markdown and quote-safe CSV', async () => {
    await renderMemoryPage();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'example-api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export Memory' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(exportMemorySnapshot).toHaveBeenCalledWith('json', 'example-api'));
    const preview = within(dialog).getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(JSON.parse(preview.value).sha256Digest).toBe('a'.repeat(64)));
    const data = JSON.parse(preview.value);
    expect(data.organization).toBe('exampleorg');
    expect(data.workspaces).toHaveLength(1);
    expect(data.learnings[0].repo).toBe('exampleorg/example-api');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Executive Markdown Report' }));
    expect(preview.value).toContain('Organization: exampleorg');
    expect(preview.value).toContain('exampleorg/example-api');
    expect(preview.value).not.toContain('reviewyeti-ai/example-meta');
    fireEvent.click(within(dialog).getByRole('button', { name: 'CSV Spreadsheet' }));
    expect(preview.value).toContain('"Quoted ""boundary"" rule"');
    expect(preview.value).toContain('"Quoted ""sample"" 0"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'JSON Schema v2.1' }));
    expect(JSON.parse(preview.value).organization).toBe('exampleorg');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('copies and downloads each real export format and resets the copied indication', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:example-memory');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await renderMemoryPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export Memory' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(exportMemorySnapshot).toHaveBeenCalled());
    for (const label of ['JSON Schema v2.1', 'Executive Markdown Report', 'CSV Spreadsheet']) {
      fireEvent.click(within(dialog).getByRole('button', { name: label }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Download File' }));
      expect(createUrl).toHaveBeenLastCalledWith(expect.any(Blob));
      expect(revokeUrl).toHaveBeenLastCalledWith('blob:example-memory');
    }
    expect(click).toHaveBeenCalledTimes(3);
    vi.useFakeTimers();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value);
    expect(within(dialog).getByText('Copied to Clipboard')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('copies each rule class and clears the copied state through the real timer callback', async () => {
    await renderMemoryPage();
    selectMemoryTab(/Knowledge Ledger/);
    const copies = [...screen.getAllByRole('button', { name: 'Copy Rule' }), ...screen.getAllByRole('button', { name: 'Copy' })];
    vi.useFakeTimers();
    for (const button of copies) {
      fireEvent.click(button);
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      expect(JSON.parse(vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)![0]).repo).toMatch(/^(?:exampleorg\/example-api|reviewyeti-ai\/example-meta)$/);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('refreshes and purges successfully and displays the reloaded workspace', async () => {
    await renderMemoryPage();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMemoryStats).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Purge Expired' })).toBeEnabled());
    vi.mocked(fetchMemoryStats).mockResolvedValueOnce({ ...memoryResponse(), r2: { ...memoryResponse().r2, bucket: 'example-after-purge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Purge Expired' }));
    await waitFor(() => expect(purgeMemoryCache).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMemoryStats).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Purge Expired' })).toBeEnabled());
    selectMemoryTab(/Workspaces & R2 Cache/);
    expect(screen.getByText('example-after-purge')).toBeInTheDocument();
    // Reload begins by clearing transient notices; verify the final visible state at the lifecycle barrier.
    expect(screen.queryByText('Sample cache sweep completed')).not.toBeInTheDocument();
  });

  it('keeps neutral local export and safe cache notice when public APIs reject', async () => {
    vi.mocked(exportMemorySnapshot).mockRejectedValue(new Error('Sample export unavailable'));
    vi.mocked(purgeMemoryCache).mockRejectedValue(new Error('Sample purge unavailable'));
    await renderMemoryPage();
    fireEvent.click(screen.getByRole('button', { name: 'Purge Expired' }));
    await waitFor(() => expect(purgeMemoryCache).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMemoryStats).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Purge Expired' })).toBeEnabled();
    expect(screen.queryByText('Workspace cache swept. Ephemeral outlines purged successfully.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export Memory' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(JSON.parse((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).organization).toBe('exampleorg'));
    expect(JSON.parse((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).workspaces).toHaveLength(2);
  });

  it('retains empty fallback state when memory loading fails and can refresh afterward', async () => {
    vi.mocked(fetchMemoryStats).mockRejectedValueOnce(new Error('Sample network unavailable'));
    await renderMemoryPage();
    selectMemoryTab(/Knowledge Ledger/);
    expect(screen.queryByText('Quoted "boundary" rule')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Quoted "boundary" rule')).toBeInTheDocument();
  });
});
