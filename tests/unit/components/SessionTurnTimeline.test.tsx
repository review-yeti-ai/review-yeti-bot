// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionTurnTimeline } from '../../../src/components/dashboard/SessionTurnTimeline';
import { PersonaTurnStep } from '../../../src/types/dashboard';

const mockTurns: PersonaTurnStep[] = [
  {
    turn: 1,
    action: 'scan_secrets',
    input: { target: 'src/' },
    output: 'Zero hardcoded secrets detected.',
    timestamp: '2026-07-31T22:00:00Z',
    tokensBurned: 1200,
    latencyMs: 150,
  },
  {
    turn: 2,
    action: 'audit_sql_params',
    input: { filesCount: 5 },
    output: 'All SQL parameters sanitized.',
    timestamp: '2026-07-31T22:00:02Z',
    tokensBurned: 1800,
    latencyMs: 220,
  },
];

describe('SessionTurnTimeline Component', () => {
  it('renders turn index, action, input args, output, tokens, and latency for each step', () => {
    render(<SessionTurnTimeline turns={mockTurns} />);

    expect(screen.getByTestId('session-turn-timeline')).toBeInTheDocument();
    expect(screen.getByText('Turn #1')).toBeInTheDocument();
    expect(screen.getByText('Turn #2')).toBeInTheDocument();
    expect(screen.getByText('scan_secrets')).toBeInTheDocument();
    expect(screen.getByText('audit_sql_params')).toBeInTheDocument();
    expect(screen.getByText(/1,200 tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/150ms/i)).toBeInTheDocument();
    expect(screen.getByText(/Zero hardcoded secrets detected/i)).toBeInTheDocument();
  });

  it('renders fallback empty state when no turns are provided', () => {
    render(<SessionTurnTimeline turns={[]} />);
    expect(screen.getByTestId('session-turn-timeline-empty')).toBeInTheDocument();
    expect(screen.getByText(/No turn execution steps recorded for this session/i)).toBeInTheDocument();
  });
});
