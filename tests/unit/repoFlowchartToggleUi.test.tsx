// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RepoTable } from '../../src/components/repos/repo-table';
import { RepositorySetting } from '../../src/types/dashboard';

const mockRepos: RepositorySetting[] = [
  {
    owner: 'calltelemetry',
    repo: 'cisco-cdr',
    automationEnabled: true,
    generateArchitecturalFlowchart: true,
    customProfile: 'balanced',
    updatedAt: new Date().toISOString(),
  },
  {
    owner: 'calltelemetry',
    repo: 'ct-meta',
    automationEnabled: false,
    generateArchitecturalFlowchart: false,
    customProfile: 'assertive',
    updatedAt: new Date().toISOString(),
  },
];

describe('Repository Settings UI - Generate Architectural Sequence & Flowchart Diagrams Toggle', () => {
  it('renders repository table with "Generate Architectural Sequence & Flowchart Diagrams" toggle switch for each repo', () => {
    render(
      <RepoTable
        repositories={mockRepos}
        onToggleAutomation={vi.fn()}
        onToggleFlowchart={vi.fn()}
        onChangeProfile={vi.fn()}
      />
    );

    expect(screen.getAllByText(/calltelemetry/).length).toBeGreaterThan(0);
    expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
    expect(screen.getByText('ct-meta')).toBeInTheDocument();

    const toggles = screen.getAllByRole('switch', {
      name: /Generate Architectural Sequence & Flowchart Diagrams/i,
    });
    expect(toggles.length).toBe(2);

    expect(toggles[0]).toHaveAttribute('aria-checked', 'true');
    expect(toggles[1]).toHaveAttribute('aria-checked', 'false');

    expect(screen.getByText('Diagrams On')).toBeInTheDocument();
    expect(screen.getByText('Diagrams Off')).toBeInTheDocument();
  });

  it('calls onToggleFlowchart with next state when table row flowchart toggle switch is clicked', () => {
    const onToggleFlowchart = vi.fn();
    render(
      <RepoTable
        repositories={mockRepos}
        onToggleAutomation={vi.fn()}
        onToggleFlowchart={onToggleFlowchart}
        onChangeProfile={vi.fn()}
      />
    );

    const firstToggle = screen.getByTestId('repo-flowchart-toggle-calltelemetry-cisco-cdr');
    expect(firstToggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(firstToggle);

    expect(onToggleFlowchart).toHaveBeenCalledTimes(1);
    expect(onToggleFlowchart).toHaveBeenCalledWith('calltelemetry', 'cisco-cdr', false);
  });

  it('opens repository settings modal when Settings button is clicked and displays flowchart toggle', () => {
    const onToggleFlowchart = vi.fn();
    render(
      <RepoTable
        repositories={mockRepos}
        onToggleAutomation={vi.fn()}
        onToggleFlowchart={onToggleFlowchart}
        onChangeProfile={vi.fn()}
      />
    );

    const settingsBtn = screen.getByTestId('repo-settings-btn-calltelemetry-cisco-cdr');
    fireEvent.click(settingsBtn);

    expect(screen.getByText(/Repository Settings — calltelemetry\/cisco-cdr/i)).toBeInTheDocument();
    expect(screen.getByText('Generate Architectural Sequence & Flowchart Diagrams')).toBeInTheDocument();

    const modalToggle = screen.getByTestId('modal-repo-flowchart-toggle');
    expect(modalToggle).toBeInTheDocument();
    expect(modalToggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(modalToggle);

    expect(onToggleFlowchart).toHaveBeenCalledWith('calltelemetry', 'cisco-cdr', false);
  });
});
