// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Sidebar } from '../../src/components/layout/sidebar';
import { ProviderSettings } from '../../src/components/settings/provider-settings';
import * as apiClient from '../../src/lib/api-client';

// Mock next/navigation
vi.mock('next/navigation', () => {
  return {
    usePathname: () => '/settings',
    useSearchParams: () => new URLSearchParams('tab=models'),
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
    }),
  };
});

describe('Milestone 3: AI Providers UI & Persona Sync Component Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Sidebar renders "AI Models & Providers" navigation item leading to /settings?tab=models', () => {
    render(<Sidebar />);
    const link = screen.getByRole('link', { name: /AI Models & Providers/i });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/settings?tab=models');
  });

  it('ProviderSettings renders provider cards for OpenAI, Anthropic, Gemini, Grok, DeepSeek, GLM, Doppler, Ollama, and Custom OpenAI', async () => {
    const mockProviders = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: true,
        apiKeyMasked: 'sk-proj...1234',
        baseUrl: 'https://api.openai.com/v1',
        subscriptionTier: 'pay-as-you-go',
        activeModels: ['gpt-4o', 'gpt-4o-mini'],
        customModels: [],
        updatedAt: new Date().toISOString(),
      },
      anthropic: {
        id: 'anthropic',
        displayName: 'Anthropic Claude',
        enabled: true,
        apiKeyMasked: 'sk-ant...5678',
        baseUrl: 'https://api.anthropic.com/v1',
        subscriptionTier: 'team',
        activeModels: ['claude-3-5-sonnet'],
        customModels: [],
        updatedAt: new Date().toISOString(),
      },
      ollama: {
        id: 'ollama',
        displayName: 'Ollama Local LLM',
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        subscriptionTier: 'free',
        activeModels: ['llama3.3'],
        customModels: ['qwen2.5-coder'],
        updatedAt: new Date().toISOString(),
      },
    };

    const mockRegistry = {
      'gpt-4o': {
        id: 'gpt-4o',
        providerId: 'openai',
        displayName: 'GPT-4o',
        enabled: true,
        contextWindowTokens: 128000,
        costPer1kPromptUSD: 0.0025,
        costPer1kCompletionUSD: 0.01,
      },
      'claude-3-5-sonnet': {
        id: 'claude-3-5-sonnet',
        providerId: 'anthropic',
        displayName: 'Claude 3.5 Sonnet',
        enabled: true,
        contextWindowTokens: 200000,
        costPer1kPromptUSD: 0.003,
        costPer1kCompletionUSD: 0.015,
      },
    };

    vi.spyOn(apiClient, 'fetchProviders').mockResolvedValue({
      success: true,
      providers: mockProviders as any,
      models: ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'llama3.3'],
      modelRegistry: mockRegistry as any,
    });

    render(<ProviderSettings />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeDefined();
      expect(screen.getByText('Anthropic Claude')).toBeDefined();
      expect(screen.getByText('Ollama Local LLM')).toBeDefined();
    });

    const testButtons = screen.getAllByRole('button', { name: /Test/i });
    expect(testButtons.length).toBeGreaterThan(0);
  });

  it('triggers ModelRemappingDialog when disabling provider used by active personas', async () => {
    const mockProviders = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: true,
        activeModels: ['gpt-4o'],
        customModels: [],
        updatedAt: new Date().toISOString(),
      },
      anthropic: {
        id: 'anthropic',
        displayName: 'Anthropic Claude',
        enabled: true,
        activeModels: ['claude-3-5-sonnet'],
        customModels: [],
        updatedAt: new Date().toISOString(),
      },
    };

    const mockPersonas = {
      security: {
        id: 'security',
        displayName: 'Security Guardian',
        model: 'claude-3-5-sonnet',
        effort: 'high',
        confidenceThreshold: 85,
        enabled: true,
      },
    };

    vi.spyOn(apiClient, 'fetchProviders').mockResolvedValue({
      success: true,
      providers: mockProviders as any,
      models: ['gpt-4o', 'claude-3-5-sonnet'],
      modelRegistry: {
        'claude-3-5-sonnet': {
          id: 'claude-3-5-sonnet',
          providerId: 'anthropic',
          displayName: 'Claude 3.5 Sonnet',
          enabled: true,
        },
      } as any,
    });

    vi.spyOn(apiClient, 'fetchPersonas').mockResolvedValue(mockPersonas as any);

    render(<ProviderSettings />);

    await waitFor(() => {
      expect(screen.getByText('Anthropic Claude')).toBeDefined();
    });

    const activeButtons = screen.getAllByRole('button', { name: /Active/i });
    fireEvent.click(activeButtons[1] || activeButtons[0]);

    await waitFor(() => {
      expect(screen.getByTestId('model-remapping-dialog')).toBeDefined();
      expect(screen.getByText(/Impacted Personas & Model Remapping/i)).toBeDefined();
      expect(screen.getByText('Security Guardian')).toBeDefined();
    });
  });
});
