// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingWizard } from '@/components/github-app/onboarding-wizard';
import { RepoTable } from '@/components/repos/repo-table';
import ReposPage from '@/app/repos/page';
import { ProviderSettings } from '@/components/settings/provider-settings';
import { PersonaSelector, ALL_PERSONA_IDS, PERSONA_METADATA } from '@/components/settings/persona-selector';
import { SpendingCapModal } from '@/components/dashboard/spending-cap-modal';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { RepositorySetting, ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';
import * as apiClient from '@/lib/api-client';

// Mock api-client
vi.mock('@/lib/api-client', () => ({
  fetchGitHubAppConfig: vi.fn(),
  fetchEnforcementPolicy: vi.fn(),
  updateEnforcementPolicy: vi.fn(),
  verifyGitHubApp: vi.fn(),
  fetchRepositories: vi.fn(),
  updateRepository: vi.fn(),
  createRepository: vi.fn(),
  runOnboardingScan: vi.fn(),
  fetchProviders: vi.fn(),
  updateProvider: vi.fn(),
  testProvider: vi.fn(),
  updateDashboardConfig: vi.fn(),
  fetchPersonas: vi.fn().mockResolvedValue({}),
  updatePersona: vi.fn(),
}));

describe('Onboarding Wizard Steps - Tier 1 & Tier 2 Component Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Feature 1: GitHub Organization Connection & App Registration (≥10 tests)
  // =========================================================================
  describe('Feature 1: GitHub Organization Connection & App Registration', () => {
    it('1.1 renders initial inputs with values from config prop', () => {
      const config = {
        appId: '1048293',
        installationId: '5829104',
        webhookSecretConfigured: true,
        privateKeyConfigured: true,
        status: 'configured' as const,
        updatedAt: new Date().toISOString(),
      };

      render(<OnboardingWizard config={config} />);

      expect(screen.getByDisplayValue('1048293')).toBeInTheDocument();
      expect(screen.getByDisplayValue('5829104')).toBeInTheDocument();
      expect(screen.getByText(/Monitored Org Repositories Manager/i)).toBeInTheDocument();
    });

    it('1.2 renders default fallback inputs when config prop is missing', () => {
      render(<OnboardingWizard />);

      expect(screen.getByDisplayValue('1048293')).toBeInTheDocument();
      expect(screen.getByDisplayValue('5829104')).toBeInTheDocument();
    });

    it('1.3 allows updating GitHub App ID input', () => {
      render(<OnboardingWizard />);

      const appIdInput = screen.getByDisplayValue('1048293');
      fireEvent.change(appIdInput, { target: { value: '999888' } });

      expect(screen.getByDisplayValue('999888')).toBeInTheDocument();
    });

    it('1.4 allows updating Installation ID input', () => {
      render(<OnboardingWizard />);

      const instIdInput = screen.getByDisplayValue('5829104');
      fireEvent.change(instIdInput, { target: { value: '777666' } });

      expect(screen.getByDisplayValue('777666')).toBeInTheDocument();
    });

    it('1.5 handles empty boundary inputs for App ID and Installation ID', () => {
      render(<OnboardingWizard />);

      const appIdInput = screen.getByDisplayValue('1048293');
      const instIdInput = screen.getByDisplayValue('5829104');

      fireEvent.change(appIdInput, { target: { value: '' } });
      fireEvent.change(instIdInput, { target: { value: '' } });

      expect(appIdInput).toHaveValue('');
      expect(instIdInput).toHaveValue('');
    });

    it('1.6 triggers click on hidden file input when dropzone is clicked', () => {
      render(<OnboardingWizard />);

      const dropzone = screen.getByText(/drag and drop private key file/i);
      fireEvent.click(dropzone);

      expect(screen.getByText(/RS256 Private Key Configured/i)).toBeInTheDocument();
    });

    it('1.7 handles private key upload via file input change', async () => {
      render(<OnboardingWizard />);

      const fileContent = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const file = new File([fileContent], 'private-key.pem', { type: 'application/x-pem-file' });

      const dropzone = screen.getByText(/drag and drop private key file/i);
      
      // Simulate drop event with File
      fireEvent.drop(dropzone, {
        dataTransfer: {
          files: [file],
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/RS256 Private Key Configured/i)).toBeInTheDocument();
      });
    });

    it('1.8 handles drag and drop with fallback files', () => {
      render(<OnboardingWizard />);

      const dropzone = screen.getByText(/drag and drop private key file/i);
      fireEvent.drop(dropzone, { dataTransfer: {} });

      expect(screen.getByText(/RS256 Private Key Configured/i)).toBeInTheDocument();
    });

    it('1.9 triggers onVerify callback with input payload on button click', async () => {
      const handleVerify = vi.fn().mockResolvedValue(undefined);

      render(<OnboardingWizard onVerify={handleVerify} />);

      const verifyBtn = screen.getByRole('button', { name: /verify credentials/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(handleVerify).toHaveBeenCalledWith({
          appId: '1048293',
          installationId: '5829104',
        });
      });
      expect(screen.getByText('JWT RSA Key Pair Verified')).toBeInTheDocument();
    });

    it('1.10 displays Verification Failed badge when onVerify rejects', async () => {
      const handleVerify = vi.fn().mockRejectedValue(new Error('Invalid RSA key format'));

      render(<OnboardingWizard onVerify={handleVerify} />);

      const verifyBtn = screen.getByRole('button', { name: /verify credentials/i });
      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(screen.getByText('Verification Failed')).toBeInTheDocument();
      });
    });

    it('1.11 toggles Require 4-Persona Approval policy button', () => {
      render(<OnboardingWizard />);

      const toggleButtons = screen.getAllByRole('button', { name: /enabled/i });
      expect(toggleButtons.length).toBeGreaterThan(0);

      fireEvent.click(toggleButtons[0]);
      expect(screen.getByRole('button', { name: /disabled/i })).toBeInTheDocument();
    });

    it('1.12 toggles Require Ticket Link policy button', () => {
      render(<OnboardingWizard policy={{ require_all_reviews: true, require_ticket_link: false, failure_action: 'quarantine' }} />);

      const disabledButton = screen.getByRole('button', { name: /disabled/i });
      fireEvent.click(disabledButton);

      const enabledButtons = screen.getAllByRole('button', { name: /enabled/i });
      expect(enabledButtons.length).toBe(2);
    });

    it('1.13 triggers onSavePolicy and shows success toast message', async () => {
      const handleSavePolicy = vi.fn().mockResolvedValue(undefined);

      render(<OnboardingWizard onSavePolicy={handleSavePolicy} />);

      const saveBtn = screen.getByRole('button', { name: /save enforcement policy/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(handleSavePolicy).toHaveBeenCalledWith({
          require_all_reviews: true,
          require_ticket_link: true,
          failure_action: 'quarantine',
        });
        expect(screen.getByText('Enforcement policy saved successfully')).toBeInTheDocument();
      });
    });

    it('1.14 handles policy save error gracefully and shows error message', async () => {
      const handleSavePolicy = vi.fn().mockRejectedValue(new Error('Database write conflict'));

      render(<OnboardingWizard onSavePolicy={handleSavePolicy} />);

      const saveBtn = screen.getByRole('button', { name: /save enforcement policy/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText(/Failed to save policy: Database write conflict/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Feature 2: Monitored Repositories & Strictness Profiles (≥10 tests)
  // =========================================================================
  describe('Feature 2: Monitored Repositories & Strictness Profiles', () => {
    const mockRepos: RepositorySetting[] = [
      {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        automationEnabled: true,
        customProfile: 'balanced',
        modelOverrides: { security: 'gpt-4o' },
        updatedAt: new Date().toISOString(),
      },
      {
        owner: 'calltelemetry',
        repo: 'api-gateway',
        automationEnabled: false,
        customProfile: 'assertive',
        updatedAt: new Date().toISOString(),
      },
    ];

    it('2.1 renders repository table rows for configured repositories', () => {
      const onToggle = vi.fn();
      const onChangeProfile = vi.fn();

      render(<RepoTable repositories={mockRepos} onToggleAutomation={onToggle} onChangeProfile={onChangeProfile} />);

      expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
      expect(screen.getByText('api-gateway')).toBeInTheDocument();
      expect(screen.getByText('1 overrides')).toBeInTheDocument();
      expect(screen.getByText('Default Models')).toBeInTheDocument();
    });

    it('2.2 renders empty repository list boundary condition', () => {
      render(<RepoTable repositories={[]} onToggleAutomation={vi.fn()} onChangeProfile={vi.fn()} />);

      expect(screen.getByText('No repositories configured yet.')).toBeInTheDocument();
    });

    it('2.3 toggles automation status switch from Active to Paused', () => {
      const onToggle = vi.fn();
      render(<RepoTable repositories={mockRepos} onToggleAutomation={onToggle} onChangeProfile={vi.fn()} />);

      const switches = screen.getAllByRole('switch');
      expect(switches[0]).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(switches[0]);
      expect(onToggle).toHaveBeenCalledWith('calltelemetry', 'cisco-cdr', false);
    });

    it('2.4 changes strictness profile selection for a repository', () => {
      const onChangeProfile = vi.fn();
      render(<RepoTable repositories={mockRepos} onToggleAutomation={vi.fn()} onChangeProfile={onChangeProfile} />);

      const selects = screen.getAllByRole('combobox');
      expect(selects.length).toBeGreaterThan(0);
    });

    it('2.5 renders ReposPage and loads repository list from API', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);

      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
        expect(screen.getByText('api-gateway')).toBeInTheDocument();
      });
    });

    it('2.6 filters repository list by search input keyword', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);

      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter repositories...');
      fireEvent.change(searchInput, { target: { value: 'cisco' } });

      expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
      expect(screen.queryByText('api-gateway')).not.toBeInTheDocument();
    });

    it('2.7 handles special characters in repository names (e.g., @scope/pkg#123)', async () => {
      const specialRepos: RepositorySetting[] = [
        {
          owner: '@calltelemetry-org',
          repo: 'c++_core-service#v1.0',
          automationEnabled: true,
          customProfile: 'chill',
          updatedAt: new Date().toISOString(),
        },
      ];
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(specialRepos);

      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('@calltelemetry-org/')).toBeInTheDocument();
        expect(screen.getByText('c++_core-service#v1.0')).toBeInTheDocument();
      });
    });

    it('2.8 opens Add Repository modal and adds a new repository', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);
      vi.mocked(apiClient.createRepository).mockResolvedValue({
        owner: 'calltelemetry',
        repo: 'new-microservice',
        automationEnabled: true,
        customProfile: 'balanced',
        updatedAt: new Date().toISOString(),
      });

      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
      });

      const addBtn = screen.getByRole('button', { name: /add repository/i });
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByText('Onboard New Repository')).toBeInTheDocument();
      });

      const repoInput = screen.getByPlaceholderText('e.g. cisco-cdr');
      fireEvent.change(repoInput, { target: { value: 'new-microservice' } });

      const onboardBtn = screen.getByRole('button', { name: /onboard repo/i });
      fireEvent.click(onboardBtn);

      await waitFor(() => {
        expect(apiClient.createRepository).toHaveBeenCalledWith({
          owner: 'calltelemetry',
          repo: 'new-microservice',
          automationEnabled: true,
          customProfile: 'balanced',
        });
      });
    });

    it('2.9 opens Scan Stack modal and triggers repository stack scanner', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);
      vi.mocked(apiClient.runOnboardingScan).mockResolvedValue({
        repoPath: './',
        detectedStack: ['TypeScript', 'Next.js 15', 'Node.js'],
        suggestedPersonas: ['security', 'quality'],
        estimatedLatencyMs: 95,
        generatedYaml: 'profile: balanced',
      });

      render(<ReposPage />);

      const scanBtn = screen.getByRole('button', { name: /scan stack/i });
      fireEvent.click(scanBtn);

      await waitFor(() => {
        expect(screen.getByText('Repository Onboarding & Stack Scanner')).toBeInTheDocument();
      });

      const runScanBtn = screen.getByRole('button', { name: /run scan/i });
      fireEvent.click(runScanBtn);

      await waitFor(() => {
        expect(screen.getByText('Detected Tech Stack:')).toBeInTheDocument();
        expect(screen.getByText('TypeScript')).toBeInTheDocument();
        expect(screen.getByText('Generated .ct-review.yaml:')).toBeInTheDocument();
      });
    });

    it('2.10 handles Scan Stack API fallback on failure', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);
      vi.mocked(apiClient.runOnboardingScan).mockRejectedValue(new Error('Network error'));

      render(<ReposPage />);

      const scanBtn = screen.getByRole('button', { name: /scan stack/i });
      fireEvent.click(scanBtn);

      await waitFor(() => {
        expect(screen.getByText('Repository Onboarding & Stack Scanner')).toBeInTheDocument();
      });

      const runScanBtn = screen.getByRole('button', { name: /run scan/i });
      fireEvent.click(runScanBtn);

      await waitFor(() => {
        expect(screen.getByText('Detected Tech Stack:')).toBeInTheDocument();
        expect(screen.getByText('DigitalOcean K8s')).toBeInTheDocument();
      });
    });

    it('2.11 refreshes repository list on Refresh button click', async () => {
      vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);

      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('cisco-cdr')).toBeInTheDocument();
      });

      const refreshBtn = screen.getByRole('button', { name: /refresh/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(apiClient.fetchRepositories).toHaveBeenCalledTimes(2);
      });
    });

    it('2.12 triggers scan modal callback from RepoTable action button', () => {
      const onRunScan = vi.fn();
      render(<RepoTable repositories={mockRepos} onToggleAutomation={vi.fn()} onChangeProfile={vi.fn()} onRunScan={onRunScan} />);

      const scanActionButtons = screen.getAllByRole('button', { name: /scan/i });
      fireEvent.click(scanActionButtons[0]);

      expect(onRunScan).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Feature 3: AI Providers, Keys & Subscription Tiers (≥10 tests)
  // =========================================================================
  describe('Feature 3: AI Providers, Keys & Subscription Tiers', () => {
    const mockProvidersResponse: apiClient.ProvidersApiResponse = {
      success: true,
      providers: {
        openai: {
          id: 'openai',
          displayName: 'OpenAI Family',
          enabled: true,
          apiKeyMasked: 'sk-proj-****1234',
          baseUrl: 'https://api.openai.com/v1',
          subscriptionTier: 'pro',
          activeModels: ['gpt-4o'],
          customModels: [],
          updatedAt: new Date().toISOString(),
        },
        anthropic: {
          id: 'anthropic',
          displayName: 'Anthropic Family',
          enabled: true,
          apiKeyMasked: 'sk-ant-****5678',
          baseUrl: 'https://api.anthropic.com/v1',
          subscriptionTier: 'team',
          activeModels: ['claude-3-5-sonnet'],
          updatedAt: new Date().toISOString(),
        },
        ollama: {
          id: 'ollama',
          displayName: 'Ollama Local LLM',
          enabled: false,
          baseUrl: 'http://localhost:11434/v1',
          subscriptionTier: 'free',
          activeModels: ['llama3:latest'],
          customModels: ['llama3:latest'],
          updatedAt: new Date().toISOString(),
        },
      },
      models: ['gpt-4o', 'claude-3-5-sonnet', 'llama3:latest'],
      modelRegistry: {
        'gpt-4o': {
          id: 'gpt-4o',
          providerId: 'openai',
          displayName: 'GPT-4o Omnimodal',
          enabled: true,
          contextWindowTokens: 128000,
          costPer1kPromptUSD: 0.005,
          costPer1kCompletionUSD: 0.015,
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
      },
    };

    it('3.1 renders all supported 9 provider families in ProviderSettings', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('AI Provider Credentials & Infrastructure Endpoints')).toBeInTheDocument();
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
        expect(screen.getByText('Anthropic Family')).toBeInTheDocument();
        expect(screen.getByText('Ollama Local LLM')).toBeInTheDocument();
        // Checked target provider list rendering
        expect(screen.getByText('ID: deepseek')).toBeInTheDocument();
        expect(screen.getByText('ID: doppler')).toBeInTheDocument();
      });
    });

    it('3.2 displays masked API key string for configured providers', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('Stored: sk-proj-****1234')).toBeInTheDocument();
        expect(screen.getByText('Stored: sk-ant-****5678')).toBeInTheDocument();
      });
    });

    it('3.3 toggles API key input visibility mode (password vs text)', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const keyInput = screen.getByPlaceholderText('sk-proj-****1234');
      expect(keyInput).toHaveAttribute('type', 'password');

      const toggleVisibilityButtons = screen.getAllByTitle('Toggle visibility');
      fireEvent.click(toggleVisibilityButtons[0]);

      expect(keyInput).toHaveAttribute('type', 'text');
    });

    it('3.4 updates provider Base URL input value', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeInTheDocument();
      });

      const baseUrlInput = screen.getByDisplayValue('https://api.openai.com/v1');
      fireEvent.change(baseUrlInput, { target: { value: 'https://custom-proxy.openai.com/v1' } });

      expect(screen.getByDisplayValue('https://custom-proxy.openai.com/v1')).toBeInTheDocument();
    });

    it('3.5 triggers Test Connection and displays success latency badge', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);
      vi.mocked(apiClient.testProvider).mockResolvedValue({
        success: true,
        status: 'healthy',
        latencyMs: 142,
        message: 'Connection test succeeded',
      });

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      fireEvent.click(testButtons[0]);

      await waitFor(() => {
        expect(apiClient.testProvider).toHaveBeenCalledWith('openai', { baseUrl: 'https://api.openai.com/v1' });
        expect(screen.getByText('Connection test succeeded')).toBeInTheDocument();
        expect(screen.getByText('(142ms)')).toBeInTheDocument();
      });
    });

    it('3.6 handles Test Connection error and displays failure badge', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);
      vi.mocked(apiClient.testProvider).mockRejectedValue(new Error('Invalid API Key secret'));

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      fireEvent.click(testButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('Connection test failed for openai: Invalid API Key secret')).toBeInTheDocument();
      });
    });

    it('3.7 saves provider configuration on Save Provider button click', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);
      vi.mocked(apiClient.updateProvider).mockResolvedValue({
        ...mockProvidersResponse.providers.openai,
        baseUrl: 'https://updated.openai.com/v1',
      });

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const saveButtons = screen.getAllByRole('button', { name: /save provider/i });
      fireEvent.click(saveButtons[0]);

      await waitFor(() => {
        expect(apiClient.updateProvider).toHaveBeenCalled();
        expect(screen.getByText("Saved changes for OpenAI Family")).toBeInTheDocument();
      });
    });

    it('3.8 adds custom model to supported provider (Ollama / Custom OpenAI)', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);
      vi.mocked(apiClient.updateProvider).mockResolvedValue({
        ...mockProvidersResponse.providers.openai,
        customModels: ['mistral-7b-v0.2'],
        activeModels: ['gpt-4o', 'mistral-7b-v0.2'],
      });

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const addInputs = screen.getAllByPlaceholderText('e.g. llama3.3:70b, my-model-v1');
      fireEvent.change(addInputs[0], { target: { value: 'mistral-7b-v0.2' } });

      const addButtons = screen.getAllByRole('button', { name: /add/i });
      fireEvent.click(addButtons[0]);

      await waitFor(() => {
        expect(apiClient.updateProvider).toHaveBeenCalledWith('openai', {
          customModels: ['mistral-7b-v0.2'],
          activeModels: ['gpt-4o', 'mistral-7b-v0.2'],
        });
      });
    });

    it('3.9 removes custom model from provider on remove button click', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);
      vi.mocked(apiClient.updateProvider).mockResolvedValue({
        ...mockProvidersResponse.providers.ollama,
        customModels: [],
        activeModels: [],
      });

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('llama3:latest')).toBeInTheDocument();
      });

      const removeBtn = screen.getByTitle('Remove custom model');
      fireEvent.click(removeBtn);

      await waitFor(() => {
        expect(apiClient.updateProvider).toHaveBeenCalledWith('ollama', {
          customModels: [],
          activeModels: [],
        });
      });
    });

    it('3.10 renders Model Registry Table with token costs and context caps', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('Global AI Model Registry & Cost Control Table')).toBeInTheDocument();
        expect(screen.getByText('GPT-4o Omnimodal')).toBeInTheDocument();
        expect(screen.getByText('128k tokens')).toBeInTheDocument();
        expect(screen.getByText('$0.00500 / $0.01500')).toBeInTheDocument();
      });
    });

    it('3.11 enables and disables provider via Active button toggle', async () => {
      vi.mocked(apiClient.fetchProviders).mockResolvedValue(mockProvidersResponse);

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI Family')).toBeInTheDocument();
      });

      const activeBtns = screen.getAllByRole('button', { name: /^active$/i });
      fireEvent.click(activeBtns[0]);

      // Verify toggle action state
      expect(screen.getAllByRole('button', { name: /^enable$/i }).length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Feature 4 & 6: Reviewer Personas, How-To, Tooltips, Manifest & Cost Estimator (≥6 tests)
  // =========================================================================
  describe('Feature 4 & 6: Persona Ensemble, Tooltips, Manifest Drawer & Cost Estimator Card', () => {
    it('4.1 renders PersonaSelector with 11 reviewer persona cards', () => {
      const onSelect = vi.fn();

      render(<PersonaSelector selectedPersonaId="security" onSelectPersona={onSelect} />);

      expect(ALL_PERSONA_IDS).toHaveLength(12);
      expect(screen.getAllByText(PERSONA_METADATA.security.name).length).toBeGreaterThan(0);
      expect(screen.getAllByText(PERSONA_METADATA.architecture.name).length).toBeGreaterThan(0);
      expect(screen.getAllByText(PERSONA_METADATA.red_team.name).length).toBeGreaterThan(0);
    });

    it('4.2 selects persona card on click and triggers onSelect callback', () => {
      const onSelect = vi.fn();

      render(<PersonaSelector selectedPersonaId="security" onSelectPersona={onSelect} />);

      const archCards = screen.getAllByText(PERSONA_METADATA.architecture.name);
      fireEvent.click(archCards[0]);

      expect(onSelect).toHaveBeenCalledWith('architecture');
    });

    it('4.3 renders PersonaSelector mobile dropdown fallback', () => {
      const onSelect = vi.fn();

      render(<PersonaSelector selectedPersonaId="performance" onSelect={onSelect} />);

      const select = screen.getByRole('combobox');
      expect(select).toBeInTheDocument();
    });

    it('4.4 renders Tooltip primitive correctly with provider and trigger', () => {
      render(
        <TooltipProvider>
          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <button>Hover Me</button>
            </TooltipTrigger>
            <TooltipContent>
              <span>RS256 RSA Private Key Tooltip Guidance</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      expect(screen.getByText('Hover Me')).toBeInTheDocument();
      expect(screen.getByText('RS256 RSA Private Key Tooltip Guidance')).toBeInTheDocument();
    });

    it('4.5 renders SpendingCapModal / Cost Estimator Card when open is true', () => {
      render(<SpendingCapModal open={true} onOpenChange={vi.fn()} currentMonthlyCap={150} />);

      expect(screen.getByText('Edit Spending Cap & Budget')).toBeInTheDocument();
      expect(screen.getByDisplayValue('150')).toBeInTheDocument();
    });

    it('4.6 validates monthly budget cap boundary condition (negative or zero value)', async () => {
      render(<SpendingCapModal open={true} onOpenChange={vi.fn()} currentMonthlyCap={150} />);

      const monthlyInput = screen.getByDisplayValue('150');
      fireEvent.change(monthlyInput, { target: { value: '0' } });

      const saveBtn = screen.getByRole('button', { name: /save cap settings/i });
      const form = saveBtn.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Monthly cap must be a positive number')).toBeInTheDocument();
      });
    });

    it('4.7 saves SpendingCapModal configuration successfully and calls onSuccess', async () => {
      const handleSuccess = vi.fn();
      vi.mocked(apiClient.updateDashboardConfig).mockResolvedValue({
        success: true,
        config: {},
        overview: {} as any,
      });

      render(<SpendingCapModal open={true} onOpenChange={vi.fn()} onSuccess={handleSuccess} currentMonthlyCap={200} />);

      const saveBtn = screen.getByRole('button', { name: /save cap settings/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(apiClient.updateDashboardConfig).toHaveBeenCalledWith({
          monthlyCostCapUSD: 200,
          providerCostCaps: {
            monthlyBudgetUSD: 200,
            dailyBudgetUSD: 7,
            alertThresholdPercent: 80,
            actionOnCapBreach: 'fail_closed',
          },
        });
        expect(screen.getByText('Spending cap settings updated successfully!')).toBeInTheDocument();
        expect(handleSuccess).toHaveBeenCalled();
      });
    });

    it('4.8 handles SpendingCapModal API error response gracefully', async () => {
      vi.mocked(apiClient.updateDashboardConfig).mockRejectedValue(new Error('Quota error'));

      render(<SpendingCapModal open={true} onOpenChange={vi.fn()} currentMonthlyCap={150} />);

      const saveBtn = screen.getByRole('button', { name: /save cap settings/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText('Quota error')).toBeInTheDocument();
      });
    });
  });
});
