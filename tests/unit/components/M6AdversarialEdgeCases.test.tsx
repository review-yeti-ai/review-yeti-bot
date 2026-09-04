// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TurnProgressBar } from '../../../src/components/dashboard/TurnProgressBar';
import { SessionTurnTimeline } from '../../../src/components/dashboard/SessionTurnTimeline';
import { FindingsDeltaCard, FindingsDeltaBadge } from '../../../src/components/dashboard/FindingsDeltaCard';
import { PersonaTurnStep, FindingsDeltaSummary } from '../../../src/types/dashboard';
import { timeBudgetMs } from '../../support/timeBudget';

describe('M6 Adversarial Edge Case Testing Suite', () => {

  describe('TurnProgressBar Component Edge Cases', () => {
    it('handles 0 turns gracefully', () => {
      render(<TurnProgressBar currentTurn={0} maxTurns={20} />);
      expect(screen.getByTestId('turn-progress-bar')).toBeInTheDocument();
      expect(screen.getByText('0 / 20 turns')).toBeInTheDocument();
      expect(screen.getByText(/Turn Budget Execution \(0%\)/i)).toBeInTheDocument();
    });

    it('handles 0 maxTurns by falling back to default maxTurns 20', () => {
      render(<TurnProgressBar currentTurn={5} maxTurns={0} />);
      expect(screen.getByText('5 / 20 turns')).toBeInTheDocument();
    });

    it('handles negative maxTurns by falling back to default maxTurns 20', () => {
      render(<TurnProgressBar currentTurn={5} maxTurns={-10} />);
      expect(screen.getByText('5 / 20 turns')).toBeInTheDocument();
    });

    it('handles budget overflow (1000 turns out of 20 maxTurns)', () => {
      render(<TurnProgressBar currentTurn={1000} maxTurns={20} showWarning={true} />);
      expect(screen.getByText('1000 / 20 turns')).toBeInTheDocument();
      expect(screen.getByTestId('turn-budget-warning')).toBeInTheDocument();
      expect(screen.getByText(/Warning: Agent approaching turn budget limit \(1000\/20 turns used\)/i)).toBeInTheDocument();
    });

    it('handles compact mode under budget overflow', () => {
      render(<TurnProgressBar currentTurn={50} maxTurns={20} compact={true} showWarning={true} />);
      expect(screen.getByText('50 / 20')).toBeInTheDocument();
      expect(screen.getByTestId('turn-budget-warning')).toBeInTheDocument();
      expect(screen.getByText(/Turn budget warning \(50\/20\)/i)).toBeInTheDocument();
    });

    it('handles completely missing / undefined props without crashing', () => {
      render(<TurnProgressBar />);
      expect(screen.getByTestId('turn-progress-bar')).toBeInTheDocument();
      expect(screen.getByText('0 / 20 turns')).toBeInTheDocument();
    });

    it('handles NaN turn inputs without throwing RangeError', () => {
      render(<TurnProgressBar currentTurn={NaN} maxTurns={NaN} />);
      expect(screen.getByTestId('turn-progress-bar')).toBeInTheDocument();
      expect(screen.getByText(/Turn Budget Execution \(NaN%\)/i)).toBeInTheDocument();
    });

    it('handles floating point turn counts properly', () => {
      render(<TurnProgressBar currentTurn={15.75} maxTurns={20} />);
      expect(screen.getByText('15.75 / 20 turns')).toBeInTheDocument();
      expect(screen.getByText(/Turn Budget Execution \(79%\)/i)).toBeInTheDocument();
    });

    it('respects currentTurn precedence over turnsCount', () => {
      render(<TurnProgressBar currentTurn={12} turnsCount={5} maxTurns={20} />);
      expect(screen.getByText('12 / 20 turns')).toBeInTheDocument();
    });
  });

  describe('SessionTurnTimeline Component Edge Cases', () => {
    it('renders empty fallback for 0 turns array', () => {
      render(<SessionTurnTimeline turns={[]} />);
      expect(screen.getByTestId('session-turn-timeline-empty')).toBeInTheDocument();
    });

    it('renders empty fallback when turns prop is undefined', () => {
      render(<SessionTurnTimeline turns={undefined} />);
      expect(screen.getByTestId('session-turn-timeline-empty')).toBeInTheDocument();
    });

    it('renders 1000 turns without performance crash', () => {
      const massiveTurns: PersonaTurnStep[] = Array.from({ length: 1000 }, (_, i) => ({
        turn: i + 1,
        action: `action_${i + 1}`,
        tokensBurned: 100 + i,
        latencyMs: 10 + i,
      }));

      const startTime = performance.now();
      render(<SessionTurnTimeline turns={massiveTurns} />);
      const renderTime = performance.now() - startTime;

      expect(screen.getByTestId('session-turn-timeline')).toBeInTheDocument();
      expect(screen.getByText('1000 steps executed')).toBeInTheDocument();
      expect(screen.getByTestId('turn-timeline-step-1000')).toBeInTheDocument();
      expect(renderTime).toBeLessThan(timeBudgetMs(2000)); // Must render in under 2s
    });

    it('handles steps with completely missing metadata', () => {
      const emptySteps: PersonaTurnStep[] = [{} as PersonaTurnStep];
      render(<SessionTurnTimeline turns={emptySteps} />);
      expect(screen.getByTestId('turn-timeline-step-1')).toBeInTheDocument();
      expect(screen.getByText('Turn #1')).toBeInTheDocument();
      expect(screen.getByText('tool_execution')).toBeInTheDocument();
    });

    it('handles explicit null input and output values', () => {
      const nullStep: PersonaTurnStep[] = [
        {
          turn: 1,
          action: 'null_check',
          input: null as any,
          output: null as any,
        },
      ];
      render(<SessionTurnTimeline turns={nullStep} />);
      expect(screen.getByTestId('turn-timeline-step-1')).toBeInTheDocument();
      const snippets = screen.getAllByText('null');
      expect(snippets.length).toBeGreaterThanOrEqual(1);
    });

    it('handles 0 tokensBurned and 0 latencyMs correctly', () => {
      const zeroMetricsStep: PersonaTurnStep[] = [
        {
          turn: 1,
          action: 'instant_step',
          tokensBurned: 0,
          latencyMs: 0,
        },
      ];
      render(<SessionTurnTimeline turns={zeroMetricsStep} />);
      expect(screen.getByText(/0 tokens/i)).toBeInTheDocument();
      expect(screen.getByText(/0ms/i)).toBeInTheDocument();
    });

    it('handles complex nested objects and huge strings in input/output', () => {
      const complexStep: PersonaTurnStep[] = [
        {
          turn: 1,
          action: 'deep_inspect',
          input: { nested: { array: [1, 2, { key: 'value' }] } },
          output: 'A'.repeat(10000),
        },
      ];
      render(<SessionTurnTimeline turns={complexStep} />);
      expect(screen.getByTestId('turn-timeline-step-1')).toBeInTheDocument();
      expect(screen.getByText(new RegExp('A'.repeat(50)))).toBeInTheDocument();
    });
  });

  describe('FindingsDeltaCard & FindingsDeltaBadge Edge Cases', () => {
    it('handles completely missing / undefined findingsDelta prop', () => {
      render(<FindingsDeltaCard findingsDelta={undefined} />);
      expect(screen.getByTestId('findings-delta-card')).toBeInTheDocument();
      expect(screen.getByTestId('resolved-findings').textContent).toBe('0');
      expect(screen.getByTestId('new-findings').textContent).toBe('0');
      expect(screen.getByTestId('persistent-findings').textContent).toBe('0');
      expect(screen.getByTestId('findings-summary').textContent).toBe('0 ➔ 0');
      expect(screen.getByText('Net Change: 0')).toBeInTheDocument();
    });

    it('handles negative netChange (improvements)', () => {
      const negativeDelta: FindingsDeltaSummary = {
        initialFindings: 20,
        latestFindings: 5,
        resolvedFindings: 15,
        newFindings: 0,
        persistentFindings: 5,
        netChange: -15,
      };
      render(<FindingsDeltaCard findingsDelta={negativeDelta} />);
      expect(screen.getByTestId('findings-summary').textContent).toBe('20 ➔ 5');
      expect(screen.getByText('Net Change: -15')).toBeInTheDocument();
      const badge = screen.getByTestId('findings-delta-badge');
      expect(badge.textContent).toContain('Δ -15');
      expect(badge.textContent).toContain('15 res');
    });

    it('handles positive netChange / increase in findings', () => {
      const positiveDelta: FindingsDeltaSummary = {
        initialFindings: 2,
        latestFindings: 10,
        resolvedFindings: 0,
        newFindings: 8,
        persistentFindings: 2,
        netChange: 8,
      };
      render(<FindingsDeltaCard findingsDelta={positiveDelta} />);
      expect(screen.getByTestId('findings-summary').textContent).toBe('2 ➔ 10');
      expect(screen.getByText('Net Change: +8')).toBeInTheDocument();
      const badge = screen.getByTestId('findings-delta-badge');
      expect(badge.textContent).toContain('Δ +8');
      expect(badge.textContent).toContain('8 new, 0 res');
    });

    it('handles zero netChange with mixed resolved and new findings', () => {
      const netZeroDelta: FindingsDeltaSummary = {
        initialFindings: 5,
        latestFindings: 5,
        resolvedFindings: 3,
        newFindings: 3,
        persistentFindings: 2,
        netChange: 0,
      };
      render(<FindingsDeltaCard findingsDelta={netZeroDelta} />);
      expect(screen.getByTestId('findings-summary').textContent).toBe('5 ➔ 5');
      expect(screen.getByText('Net Change: 0')).toBeInTheDocument();
      const badge = screen.getByTestId('findings-delta-badge');
      expect(badge.textContent).toContain('Δ 0');
      expect(badge.textContent).toContain('3 res, 3 new');
    });

    it('handles negative count inputs gracefully without crash', () => {
      const anomalyDelta: FindingsDeltaSummary = {
        initialFindings: -5,
        latestFindings: -10,
        resolvedFindings: -2,
        newFindings: -1,
        persistentFindings: 0,
        netChange: -5,
      };
      render(<FindingsDeltaCard findingsDelta={anomalyDelta} />);
      expect(screen.getByTestId('findings-summary').textContent).toBe('-5 ➔ -10');
      expect(screen.getByText('Net Change: -5')).toBeInTheDocument();
    });

    it('handles large scale metric values (millions)', () => {
      const hugeDelta: FindingsDeltaSummary = {
        initialFindings: 1000000,
        latestFindings: 500000,
        resolvedFindings: 500000,
        newFindings: 0,
        persistentFindings: 500000,
        netChange: -500000,
      };
      render(<FindingsDeltaCard findingsDelta={hugeDelta} />);
      expect(screen.getByTestId('findings-summary').textContent).toBe('1000000 ➔ 500000');
      expect(screen.getByText('Net Change: -500000')).toBeInTheDocument();
    });

    it('renders FindingsDeltaBadge with showDetails = false', () => {
      const delta: FindingsDeltaSummary = {
        initialFindings: 10,
        latestFindings: 2,
        resolvedFindings: 8,
        newFindings: 0,
        persistentFindings: 2,
        netChange: -8,
      };
      render(<FindingsDeltaBadge findingsDelta={delta} showDetails={false} />);
      const badge = screen.getByTestId('findings-delta-badge');
      expect(badge.textContent).toBe('Δ -8');
    });

    it('renders null when findingsDelta is undefined for FindingsDeltaBadge', () => {
      const { container } = render(<FindingsDeltaBadge findingsDelta={undefined} />);
      expect(container.firstChild).toBeNull();
    });
  });

});
