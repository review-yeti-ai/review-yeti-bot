// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingsDeltaCard, FindingsDeltaBadge } from '../../../src/components/dashboard/FindingsDeltaCard';
import { FindingsDeltaSummary } from '../../../src/types/dashboard';

const mockDelta: FindingsDeltaSummary = {
  initialFindings: 5,
  latestFindings: 2,
  resolvedFindings: 3,
  newFindings: 0,
  persistentFindings: 2,
  netChange: -3,
};

describe('FindingsDeltaCard & FindingsDeltaBadge Components', () => {
  it('renders KPI summary cards for resolved, new, persistent, and net change findings', () => {
    render(<FindingsDeltaCard findingsDelta={mockDelta} />);

    expect(screen.getByTestId('findings-delta-card')).toBeInTheDocument();
    expect(screen.getByTestId('resolved-findings').textContent).toBe('3');
    expect(screen.getByTestId('new-findings').textContent).toBe('0');
    expect(screen.getByTestId('persistent-findings').textContent).toBe('2');
    expect(screen.getByTestId('findings-summary').textContent).toBe('5 ➔ 2');
  });

  it('renders FindingsDeltaBadge with correct delta display', () => {
    render(<FindingsDeltaBadge findingsDelta={mockDelta} />);

    const badge = screen.getByTestId('findings-delta-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('Δ -3');
    expect(badge.textContent).toContain('3 res');
  });
});
