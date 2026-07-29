// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ModelRemappingDialog } from '@/components/settings/model-remapping-dialog';
import { PersonaSetting } from '@/types/dashboard';

describe('ModelRemappingDialog Component Unit Tests', () => {
  const mockImpactedPersonas: PersonaSetting[] = [
    {
      id: 'security',
      displayName: '🛡️ Security & Tenancy Guardian',
      model: 'claude-3-5-sonnet',
      effort: 'high',
      confidenceThreshold: 85,
      enabled: true,
    },
    {
      id: 'quality',
      displayName: '✨ Code Quality & Style',
      model: 'claude-3-5-sonnet',
      effort: 'medium',
      confidenceThreshold: 70,
      enabled: true,
    },
  ];

  const mockAvailableModels = ['gpt-4o', 'deepseek-v3', 'glm-5.2'];

  it('renders dialog with impacted personas list when open is true', () => {
    render(
      <ModelRemappingDialog
        open={true}
        onOpenChange={vi.fn()}
        impactedPersonas={mockImpactedPersonas}
        availableModels={mockAvailableModels}
        disablingTargetName="Anthropic Claude"
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-remapping-dialog')).toBeDefined();
    expect(screen.getByText(/Impacted Personas & Model Remapping/i)).toBeDefined();
    expect(screen.getByText(/Disabling/i)).toBeDefined();
    expect(screen.getByText('Anthropic Claude')).toBeDefined();

    expect(screen.getByText('🛡️ Security & Tenancy Guardian')).toBeDefined();
    expect(screen.getByText('✨ Code Quality & Style')).toBeDefined();
  });

  it('calls onOpenChange(false) when Cancel button is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <ModelRemappingDialog
        open={true}
        onOpenChange={onOpenChange}
        impactedPersonas={mockImpactedPersonas}
        availableModels={mockAvailableModels}
        disablingTargetName="Anthropic Claude"
        onConfirm={vi.fn()}
      />
    );

    const cancelBtn = screen.getByTestId('remap-cancel-btn');
    fireEvent.click(cancelBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onConfirm with remapped models dictionary when Remap & Disable is clicked', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <ModelRemappingDialog
        open={true}
        onOpenChange={onOpenChange}
        impactedPersonas={mockImpactedPersonas}
        availableModels={mockAvailableModels}
        disablingTargetName="Anthropic Claude"
        onConfirm={onConfirm}
      />
    );

    const confirmBtn = screen.getByTestId('remap-confirm-btn');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });

    const callArg = onConfirm.mock.calls[0][0];
    expect(callArg.security).toBeDefined();
    expect(callArg.quality).toBeDefined();
    expect(mockAvailableModels).toContain(callArg.security);
    expect(mockAvailableModels).toContain(callArg.quality);
  });

  it('renders warning message when no alternative active models are available', () => {
    render(
      <ModelRemappingDialog
        open={true}
        onOpenChange={vi.fn()}
        impactedPersonas={mockImpactedPersonas}
        availableModels={[]}
        disablingTargetName="Anthropic Claude"
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText(/No alternative active models are available/i)).toBeDefined();
    const confirmBtn = screen.getByTestId('remap-confirm-btn');
    expect(confirmBtn.getAttribute('disabled')).not.toBeNull();
  });
});
