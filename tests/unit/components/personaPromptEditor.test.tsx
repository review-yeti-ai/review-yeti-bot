// @vitest-environment jsdom
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PromptEditor } from '@/components/settings/prompt-editor';
import { PersonaSelector } from '@/components/settings/persona-selector';

describe('Persona Prompt Editor & Selector Component Unit Tests', () => {
  it('renders PromptEditor with initial value, title, and token statistics', () => {
    const handleSave = vi.fn();
    const handleReset = vi.fn();
    const handleChange = vi.fn();

    render(
      <PromptEditor
        value="System prompt: Perform OWASP security analysis."
        defaultValue="System prompt: Perform OWASP security analysis."
        onChange={handleChange}
        onSave={handleSave}
        onReset={handleReset}
        title="Security Persona Prompt"
      />
    );

    expect(screen.getByText('Security Persona Prompt')).toBeInTheDocument();
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByDisplayValue('System prompt: Perform OWASP security analysis.')).toBeInTheDocument();
  });

  it('triggers onChange when user edits the text area and displays unsaved state', () => {
    let textValue = 'Original prompt';
    const handleChange = vi.fn((val: string) => { textValue = val; });
    const handleSave = vi.fn();
    const handleReset = vi.fn();

    const { rerender } = render(
      <PromptEditor
        value={textValue}
        defaultValue="Original prompt"
        onChange={handleChange}
        onSave={handleSave}
        onReset={handleReset}
      />
    );

    const textarea = screen.getByPlaceholderText(/enter system prompt/i);
    fireEvent.change(textarea, { target: { value: 'Updated security prompt' } });
    expect(handleChange).toHaveBeenCalledWith('Updated security prompt');

    rerender(
      <PromptEditor
        value="Updated security prompt"
        defaultValue="Original prompt"
        onChange={handleChange}
        onSave={handleSave}
        onReset={handleReset}
      />
    );

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: /save prompt/i });
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    expect(handleSave).toHaveBeenCalledTimes(1);
  });

  it('triggers onReset callback when reset button is clicked', () => {
    const handleReset = vi.fn();
    render(
      <PromptEditor
        value="Modified prompt"
        defaultValue="Original prompt"
        onChange={() => {}}
        onSave={() => {}}
        onReset={handleReset}
      />
    );

    const resetButton = screen.getByRole('button', { name: /reset/i });
    expect(resetButton).not.toBeDisabled();
    fireEvent.click(resetButton);
    expect(handleReset).toHaveBeenCalledTimes(1);
  });

  it('renders PersonaSelector and fires onSelect persona callback', () => {
    const personas = {
      security: {
        id: 'security', displayName: 'Security Guardian', enabled: true,
        model: 'grok-cli/grok-4.5', effort: 'medium' as const, confidenceThreshold: 0.7,
      },
      architecture: {
        id: 'architecture', displayName: 'Architecture Advisor', enabled: true,
        model: 'grok-cli/grok-4.5', effort: 'medium' as const, confidenceThreshold: 0.7,
      },
    };
    const handleSelect = vi.fn();

    render(
      <PersonaSelector
        personas={personas}
        selectedPersonaId="security"
        onSelect={handleSelect}
      />
    );

    expect(screen.getAllByText('Security Guardian').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Architecture Advisor').length).toBeGreaterThan(0);

    const archButton = screen.getAllByText('Architecture Advisor')[0];
    fireEvent.click(archButton);
    expect(handleSelect).toHaveBeenCalledWith('architecture');
  });
});
