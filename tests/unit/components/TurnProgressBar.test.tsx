// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TurnProgressBar } from '../../../src/components/dashboard/TurnProgressBar';

describe('TurnProgressBar Component', () => {
  it('renders turn count and progress bar relative to maxTurns', () => {
    render(<TurnProgressBar currentTurn={5} maxTurns={20} />);
    expect(screen.getByTestId('turn-progress-bar')).toBeInTheDocument();
    expect(screen.getByText('5 / 20 turns')).toBeInTheDocument();
  });

  it('displays warning indicator when turn budget is high (>80%)', () => {
    render(<TurnProgressBar currentTurn={18} maxTurns={20} showWarning={true} />);
    expect(screen.getByTestId('turn-budget-warning')).toBeInTheDocument();
    expect(screen.getByText(/Warning: Agent approaching turn budget limit/i)).toBeInTheDocument();
  });

  it('renders compact mode properly', () => {
    render(<TurnProgressBar currentTurn={10} maxTurns={20} compact={true} />);
    expect(screen.getByTestId('turn-progress-bar')).toBeInTheDocument();
    expect(screen.getByText('10 / 20')).toBeInTheDocument();
  });
});
