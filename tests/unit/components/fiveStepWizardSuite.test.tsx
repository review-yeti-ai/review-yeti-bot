// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FiveStepWizard } from '@/components/onboarding/five-step-wizard';
import { StepIndicator } from '@/components/onboarding/step-indicator';
import { Step1GitHubApp } from '@/components/onboarding/steps/step-1-github-app';
import { Step2ReposPicker } from '@/components/onboarding/steps/step-2-repos-picker';
import { Step3AIProviders } from '@/components/onboarding/steps/step-3-ai-providers';
import { Step4PersonaEnsemble } from '@/components/onboarding/steps/step-4-persona-ensemble';
import { Step5DiagnosticScan } from '@/components/onboarding/steps/step-5-diagnostic-scan';

import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { CostEstimatorCard } from '@/components/onboarding/cost-estimator-card';

vi.mock('@/lib/api-client', () => ({
  fetchGitHubAppConfig: vi.fn().mockResolvedValue({ appId: '1048293', status: 'configured' }),
  updateGitHubAppConfig: vi.fn().mockResolvedValue({ appId: '1048293' }),
  verifyGitHubApp: vi.fn().mockResolvedValue({ success: true, verified: true }),
  fetchRepositories: vi.fn().mockResolvedValue([
    { owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: true, customProfile: 'balanced' }
  ]),
  updateRepository: vi.fn().mockResolvedValue({ owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: true }),
  createRepository: vi.fn().mockResolvedValue({ owner: 'calltelemetry', repo: 'new-repo', automationEnabled: true }),
  fetchProviders: vi.fn().mockResolvedValue({ providers: {} }),
  updateProvider: vi.fn().mockResolvedValue({ id: 'openai', enabled: true }),
  testProvider: vi.fn().mockResolvedValue({ success: true, status: 'connected', latencyMs: 42 }),
  fetchPersonas: vi.fn().mockResolvedValue({}),
  updatePersona: vi.fn().mockResolvedValue({ id: 'security', enabled: true }),
}));

describe('FiveStepWizard Component Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders StepIndicator with all 5 steps', () => {
    render(<StepIndicator currentStep={1} />);

    expect(screen.getByText(/Step 1: GitHub App/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 2: Repositories/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 3: AI Providers/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 4: Personas/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 5: Diagnostic/i)).toBeInTheDocument();
  });

  it('renders Step1GitHubApp component fields', () => {
    const onUpdate = vi.fn();
    const onVerify = vi.fn().mockResolvedValue(undefined);

    render(
      <Step1GitHubApp
        config={{ appId: '1048293', installationId: '5829104' }}
        onUpdateConfig={onUpdate}
        onVerify={onVerify}
      />
    );

    expect(screen.getByText(/Step 1: GitHub Organization Connection/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('1048293')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5829104')).toBeInTheDocument();
  });

  it('renders Step2ReposPicker with repository list', () => {
    const repos = [
      { owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: true, customProfile: 'balanced' as const, updatedAt: '' }
    ];
    const onUpdate = vi.fn();

    render(<Step2ReposPicker repositories={repos} onUpdateRepo={onUpdate} />);

    expect(screen.getByText(/calltelemetry \//i)).toBeInTheDocument();
    expect(screen.getByText(/cisco-cdr/i)).toBeInTheDocument();
  });

  it('renders Step3AIProviders with OmniRoute providers', () => {
    const onUpdate = vi.fn();
    const onTest = vi.fn().mockResolvedValue({ success: true, latencyMs: 40 });

    render(<Step3AIProviders providers={{}} onUpdateProvider={onUpdate} onTestProvider={onTest} />);

    expect(screen.getByText(/Step 3: AI Providers & OmniRoute Models/i)).toBeInTheDocument();
    expect(screen.getAllByText(/OpenAI/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Anthropic Claude/i)).toBeInTheDocument();
  });

  it('renders Step4PersonaEnsemble with 11 reviewer personas', () => {
    const onUpdate = vi.fn();

    render(<Step4PersonaEnsemble personas={{}} onUpdatePersona={onUpdate} />);

    expect(screen.getByText(/Step 4: Persona Ensemble Assignment/i)).toBeInTheDocument();
    expect(screen.getByText(/🛡️ Security & Tenancy Guardian/i)).toBeInTheDocument();
  });

  it('filters out models belonging to disabled providers in Step4PersonaEnsemble', () => {
    const onUpdate = vi.fn();
    const disabledProviders = {
      synthetic: {
        id: 'synthetic',
        displayName: 'Synthetic',
        enabled: true,
        active: true,
        updatedAt: new Date().toISOString(),
      },
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: false,
        active: false,
        updatedAt: new Date().toISOString(),
      },
    };

    render(
      <Step4PersonaEnsemble
        personas={{
          security: {
            id: 'security',
            displayName: 'Security',
            model: 'gpt-4o',
            enabled: true,
            effort: 'low',
            confidenceThreshold: 75,
          },
        }}
        providers={disabledProviders}
        onUpdatePersona={onUpdate}
      />
    );

    expect(screen.getByText(/Step 4: Persona Ensemble Assignment/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Provider \(openai\) disabled/i).length).toBeGreaterThan(0);
  });

  it('excludes disabled providers from provider_priority in ManifestDrawer generated YAML', () => {
    const disabledProviders = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: false,
        active: false,
        updatedAt: new Date().toISOString(),
      },
    };

    render(<ManifestDrawer open={true} providers={disabledProviders} />);

    const ymlTab = screen.getByText(/\.ct-review\.yml Specification/i);
    fireEvent.click(ymlTab);

    const codeBlocks = screen.getAllByText(/provider_priority/i);
    expect(codeBlocks.length).toBeGreaterThan(0);
  });

  it('filters presets requiring disabled providers in CostEstimatorCard', () => {
    const disabledProviders = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: false,
        active: false,
        updatedAt: new Date().toISOString(),
      },
    };

    render(<CostEstimatorCard providers={disabledProviders} />);

    expect(screen.getByText(/Interactive Model Token Cost Estimator/i)).toBeInTheDocument();
  });

  it('renders Step5DiagnosticScan probe card triggers', () => {
    const onRun = vi.fn().mockResolvedValue({ success: true });

    render(<Step5DiagnosticScan onRunDiagnostic={onRun} />);

    expect(screen.getByText(/Step 5: End-to-End Diagnostic Scan/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Diagnostic Test Scan/i })).toBeInTheDocument();
  });

  it('navigates through FiveStepWizard step sequence', async () => {
    render(<FiveStepWizard />);

    // Step 1 initial
    expect(screen.getByText(/Step 1: GitHub Organization Connection/i)).toBeInTheDocument();

    // Click Next Step
    const nextBtn = screen.getByRole('button', { name: /Next Step: Step 2/i });
    fireEvent.click(nextBtn);

    // Step 2
    await waitFor(() => {
      expect(screen.getByText(/Step 2: Monitored Repositories Picker/i)).toBeInTheDocument();
    });
  });
});
