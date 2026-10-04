// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FiveStepWizard } from '@/components/onboarding/five-step-wizard';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { Step1GitHubApp } from '@/components/onboarding/steps/step-1-github-app';
import { Step2ReposPicker } from '@/components/onboarding/steps/step-2-repos-picker';
import { Step3AIProviders } from '@/components/onboarding/steps/step-3-ai-providers';
import * as apiClient from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  fetchGitHubAppConfig: vi.fn(), updateGitHubAppConfig: vi.fn().mockResolvedValue({}),
  verifyGitHubApp: vi.fn().mockResolvedValue({ success: true }),
  fetchRepositories: vi.fn(), updateRepository: vi.fn().mockResolvedValue({}), createRepository: vi.fn().mockResolvedValue({}),
  fetchProviders: vi.fn(), updateProvider: vi.fn().mockResolvedValue({}), testProvider: vi.fn().mockResolvedValue({ success: true }),
  fetchPersonas: vi.fn(), updatePersona: vi.fn().mockResolvedValue({}), runDiagnosticScan: vi.fn(),
}));

const unconfigured = { appId: '', installationId: '', webhookSecretConfigured: false, privateKeyConfigured: false, status: 'unconfigured' as const, updatedAt: '' };

function readManifest(): Record<string, any> {
  const code = [...document.querySelectorAll('pre code')].find((node) => node.textContent?.trim().startsWith('{'));
  return JSON.parse(code?.textContent || '{}');
}

describe('public onboarding defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.fetchGitHubAppConfig).mockResolvedValue(unconfigured);
    vi.mocked(apiClient.fetchRepositories).mockResolvedValue([]);
    vi.mocked(apiClient.fetchProviders).mockResolvedValue({ providers: {} } as any);
    vi.mocked(apiClient.fetchPersonas).mockResolvedValue({});
  });

  it('never invents credentials or repositories before or after loading an empty store', async () => {
    render(<FiveStepWizard />);
    expect(screen.getByPlaceholderText('e.g. 1048293')).toHaveValue('');
    expect(screen.getByPlaceholderText('e.g. 5829104')).toHaveValue('');
    expect(screen.getByPlaceholderText('whsec_...')).toHaveValue('');
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync Store/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Next Step: Step 2/i }));
    expect(screen.getByText('0 / 0 Active')).toBeInTheDocument();
    expect(screen.getByText(/No repositories found/i)).toBeInTheDocument();
    expect(apiClient.updateGitHubAppConfig).not.toHaveBeenCalled();
    expect(apiClient.createRepository).not.toHaveBeenCalled();
  });

  it('preserves fetched operator credentials and explicitly configured repositories', async () => {
    vi.mocked(apiClient.fetchGitHubAppConfig).mockResolvedValue({ ...unconfigured, appId: '9001', installationId: '9002', status: 'configured', privateKeyConfigured: true });
    vi.mocked(apiClient.fetchRepositories).mockResolvedValue([{ owner: 'operator-org', repo: 'configured-service', automationEnabled: true, customProfile: 'balanced', updatedAt: '' }]);
    render(<FiveStepWizard />);
    await waitFor(() => expect(screen.getByPlaceholderText('e.g. 1048293')).toHaveValue('9001'));
    expect(screen.getByPlaceholderText('e.g. 5829104')).toHaveValue('9002');
    fireEvent.click(screen.getByRole('button', { name: /Next Step: Step 2/i }));
    expect(screen.getByText('configured-service')).toBeInTheDocument();
  });

  it.each([
    ['GitHub App configuration', apiClient.fetchGitHubAppConfig],
    ['repositories', apiClient.fetchRepositories],
    ['AI providers', apiClient.fetchProviders],
    ['personas', apiClient.fetchPersonas],
  ] as const)('reports only the failed %s loader without substituting sample credentials', async (name, loader) => {
    vi.mocked(loader).mockRejectedValue(new Error('unavailable'));
    render(<FiveStepWizard />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`Could not load ${name}. Sync Store`));
    const alert = screen.getByRole('alert');
    for (const other of ['GitHub App configuration', 'repositories', 'AI providers', 'personas']) {
      if (other !== name) expect(alert).not.toHaveTextContent(other);
    }
    expect(screen.getByPlaceholderText('e.g. 1048293')).toHaveValue('');
    expect(screen.getByPlaceholderText('whsec_...')).toHaveValue('');
  });

  it('does not report a load error for successfully loaded empty settings', async () => {
    render(<FiveStepWizard />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync Store/i })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. 1048293')).toHaveValue('');
  });

  it.each(['service', 'a/b/c', 'a/', '/b', ' / '])('rejects malformed repository input %j', (value) => {
    const addRepo = vi.fn();
    render(<Step2ReposPicker repositories={[]} onUpdateRepo={vi.fn()} onAddRepo={addRepo} />);
    const input = screen.getByPlaceholderText('org/repository-name');
    const add = screen.getByRole('button', { name: /Add Repo/i });
    fireEvent.change(input, { target: { value } });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(addRepo).not.toHaveBeenCalled();
  });

  it.each(['operator-org/service', ' operator-org / service '])('trims valid repository input %j and clears it after adding', (value) => {
    const addRepo = vi.fn();
    render(<Step2ReposPicker repositories={[]} onUpdateRepo={vi.fn()} onAddRepo={addRepo} />);
    const input = screen.getByPlaceholderText('org/repository-name');
    const add = screen.getByRole('button', { name: /Add Repo/i });
    fireEvent.change(input, { target: { value } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(addRepo).toHaveBeenCalledTimes(1);
    expect(addRepo).toHaveBeenCalledWith('operator-org', 'service');
    expect(input).toHaveValue('');
  });

  it('honors a configured webhook even when its secret is not yet configured', () => {
    render(<Step1GitHubApp config={{ ...unconfigured, webhookUrl: 'https://operator.example.com/hooks/github' } as any} onUpdateConfig={vi.fn()} onVerify={vi.fn()} />);
    expect(screen.getByDisplayValue('https://operator.example.com/hooks/github')).toBeInTheDocument();
  });

  it('derives callbacks from the supplied webhook origin, independent of organization name', () => {
    render(<ManifestDrawer open orgName="operator-org" webhookUrl="https://operator.example.com/custom/hooks/github" providers={{}} personas={{}} />);
    expect(readManifest().redirect_url).toBe('https://operator.example.com/api/github/manifest-callback');
    expect(readManifest().callback_urls).toEqual(['https://operator.example.com/api/github/manifest-callback']);
    fireEvent.change(screen.getByPlaceholderText('your-github-org'), { target: { value: 'another-org' } });
    expect(readManifest().redirect_url).toBe('https://operator.example.com/api/github/manifest-callback');
    fireEvent.change(screen.getByLabelText('Deployment Webhook URL'), { target: { value: 'https://second.example.com/hooks' } });
    expect(readManifest().redirect_url).toBe('https://second.example.com/api/github/manifest-callback');
  });

  it('loads the actual configured webhook instead of creating a tenant domain', async () => {
    vi.mocked(apiClient.fetchGitHubAppConfig).mockResolvedValue({ ...unconfigured, webhookUrl: 'https://configured.example.com/api/webhooks/github' } as any);
    render(<ManifestDrawer open providers={{}} personas={{}} />);
    await waitFor(() => expect(readManifest().redirect_url).toBe('https://configured.example.com/api/github/manifest-callback'));
    expect(screen.getByPlaceholderText('your-github-org')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Create GitHub App on GitHub/i })).toBeDisabled();
  });

  it('refuses an invalid deployment URL and makes config loading failure visible', async () => {
    vi.mocked(apiClient.fetchGitHubAppConfig).mockRejectedValue(new Error('unavailable'));
    render(<ManifestDrawer open orgName="operator-org" providers={{}} personas={{}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load the configured webhook URL'));
    fireEvent.change(screen.getByLabelText('Deployment Webhook URL'), { target: { value: 'not a URL' } });
    expect(screen.getByRole('button', { name: /Create GitHub App on GitHub/i })).toBeDisabled();
    expect(readManifest()).not.toHaveProperty('redirect_url');
  });

  it('requires operator URLs for custom gateways and does not test fabricated endpoints', () => {
    const testProvider = vi.fn();
    render(<Step3AIProviders providers={{}} onUpdateProvider={vi.fn()} onTestProvider={testProvider} />);
    for (const id of ['custom-openai', 'codex', 'agy']) {
      const card = screen.getByTestId(`provider-card-${id}`);
      expect(within(card).getByPlaceholderText('Enter your provider base URL')).toHaveValue('');
      expect(within(card).getByRole('button', { name: /Test Connection/i })).toBeDisabled();
      fireEvent.click(within(card).getByRole('button', { name: /Test Connection/i }));
    }
    expect(testProvider).not.toHaveBeenCalled();
  });

  it('preserves an explicitly configured custom provider endpoint', async () => {
    const testProvider = vi.fn().mockResolvedValue({ success: true });
    render(<Step3AIProviders providers={{ codex: { id: 'codex', displayName: 'Codex', enabled: true, baseUrl: 'https://configured-ai.example.com/v1', activeModels: [], updatedAt: '' } }} onUpdateProvider={vi.fn()} onTestProvider={testProvider} />);
    const card = screen.getByTestId('provider-card-codex');
    expect(within(card).getByPlaceholderText('Enter your provider base URL')).toHaveValue('https://configured-ai.example.com/v1');
    fireEvent.click(within(card).getByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(testProvider).toHaveBeenCalledWith('codex'));
  });

  it('keeps built-in connection tests enabled after a partial API-key update', async () => {
    const testProvider = vi.fn().mockResolvedValue({ success: true });
    render(<Step3AIProviders providers={{ openai: { id: 'openai', displayName: 'OpenAI', enabled: true, apiKeyRaw: 'test-only-key', activeModels: [], updatedAt: '' } }} onUpdateProvider={vi.fn()} onTestProvider={testProvider} />);
    const card = screen.getByTestId('provider-card-openai');
    const testButton = within(card).getByRole('button', { name: /Test Connection/i });
    expect(testButton).toBeEnabled();
    fireEvent.click(testButton);
    await waitFor(() => expect(testProvider).toHaveBeenCalledWith('openai'));
  });
});
