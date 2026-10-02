// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RepoTable } from '../../src/components/repos/repo-table';
import { RepositorySetting } from '../../src/types/dashboard';

const mockRepos: RepositorySetting[] = [
  {
    owner: 'exampleorg',
    repo: 'example-api',
    automationEnabled: true,
    generateArchitecturalFlowchart: true,
    customProfile: 'balanced',
    updatedAt: new Date().toISOString(),
  },
  {
    owner: 'exampleorg',
    repo: 'example-meta',
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

    expect(screen.getAllByText(/exampleorg/).length).toBeGreaterThan(0);
    expect(screen.getByText('example-api')).toBeInTheDocument();
    expect(screen.getByText('example-meta')).toBeInTheDocument();

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

    const firstToggle = screen.getByTestId('repo-flowchart-toggle-exampleorg-example-api');
    expect(firstToggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(firstToggle);

    expect(onToggleFlowchart).toHaveBeenCalledTimes(1);
    expect(onToggleFlowchart).toHaveBeenCalledWith('exampleorg', 'example-api', false);
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

    const settingsBtn = screen.getByTestId('repo-settings-btn-exampleorg-example-api');
    fireEvent.click(settingsBtn);

    expect(screen.getByText(/Repository Settings — exampleorg\/example-api/i)).toBeInTheDocument();
    expect(screen.getByText('Generate Architectural Sequence & Flowchart Diagrams')).toBeInTheDocument();

    const modalToggle = screen.getByTestId('modal-repo-flowchart-toggle');
    expect(modalToggle).toBeInTheDocument();
    expect(modalToggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(modalToggle);

    expect(onToggleFlowchart).toHaveBeenCalledWith('exampleorg', 'example-api', false);
  });
});
