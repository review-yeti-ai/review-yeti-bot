// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RepoMemoryPivotPlatform } from '@/components/analytics/RepoMemoryPivotPlatform';

describe('RepoMemoryPivotPlatform Component Suite', () => {
  it('renders the interactive pivot control bar with all repository tabs', () => {
    render(<RepoMemoryPivotPlatform initialRepo="all" initialWindow="7d" />);

    // Check title and badges
    expect(screen.getByText('Repository Memory & Cache Pivot')).toBeInTheDocument();
    expect(screen.getByText('Multi-Dimensional Matrix')).toBeInTheDocument();

    // Check repository pivot buttons
    expect(screen.getByText(/All Repositories \(3\)/)).toBeInTheDocument();
    expect(screen.getByText('review-yeti-bot')).toBeInTheDocument();
    expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
    expect(screen.getByText('ct-meta')).toBeInTheDocument();

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
    expect(within(tbody).getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
    expect(within(tbody).getByText('reviewyeti-ai/ct-meta')).toBeInTheDocument();

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

    // Click 'cisco-cdr' button
    const ciscoBtn = screen.getByText('cisco-cdr');
    fireEvent.click(ciscoBtn);

    // Only cisco-cdr should remain in the filtered matrix table
    const tbody = screen.getByTestId('repo-matrix-tbody');
    expect(within(tbody).getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/review-yeti-bot')).not.toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/ct-meta')).not.toBeInTheDocument();

    // Reset back to All Repositories
    const allBtn = screen.getByText(/All Repositories \(3\)/);
    fireEvent.click(allBtn);

    expect(within(tbody).getByText('reviewyeti-ai/review-yeti-bot')).toBeInTheDocument();
    expect(within(tbody).getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
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
    expect(within(tbody).getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/review-yeti-bot')).not.toBeInTheDocument();
    expect(within(tbody).queryByText('reviewyeti-ai/ct-meta')).not.toBeInTheDocument();

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(within(tbody).getByText('reviewyeti-ai/review-yeti-bot')).toBeInTheDocument();
  });
});
