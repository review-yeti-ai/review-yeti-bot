// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { fetchGitHubAppConfig } from '@/lib/api-client';
import type { GitHubAppConfig } from '@/types/dashboard';

vi.mock('@/lib/api-client', () => ({
  fetchGitHubAppConfig: vi.fn(),
  fetchProviders: vi.fn().mockResolvedValue({ providers: {} }),
  fetchPersonas: vi.fn().mockResolvedValue({}),
}));

interface RenderedManifest {
  hook_attributes: { url: string };
  redirect_url?: string;
  callback_urls?: string[];
}

const validWebhook = 'https://operator.example.com/deployment/hooks/github';
function configuration(webhookUrl?: string): GitHubAppConfig & { webhookUrl?: string } {
  return { appId: '', status: 'unconfigured', privateKeyConfigured: false, webhookSecretConfigured: false, updatedAt: '', webhookUrl };
}

function readManifest(): RenderedManifest {
  const code = screen.getByRole('dialog').querySelector('pre code');
  expect(code).not.toBeNull();
  return JSON.parse(code?.textContent || '{}');
}

function createButton() {
  return screen.getByRole('button', { name: 'Create GitHub App on GitHub' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('ManifestDrawer callback and submission contract', () => {
  let submitForm: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchGitHubAppConfig).mockResolvedValue(configuration());
    // Observe the browser submission seam without making a request or opening a window.
    submitForm = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { label: 'HTTPS', webhook: 'https://operator.example.com:8443/custom/hooks?route=github', callback: 'https://operator.example.com:8443/api/github/manifest-callback' },
    { label: 'HTTP', webhook: 'http://localhost:8080/custom/hooks#github', callback: 'http://localhost:8080/api/github/manifest-callback' },
  ])('exports a $label callback on the actual webhook origin', ({ webhook, callback }) => {
    render(<ManifestDrawer open orgName="operator-org" webhookUrl={webhook} providers={{}} personas={{}} />);
    expect(readManifest().hook_attributes.url).toBe(webhook);
    expect(readManifest().redirect_url).toBe(callback);
    expect(readManifest().callback_urls).toEqual([callback]);
    expect(createButton()).toBeEnabled();
    expect(fetchGitHubAppConfig).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'FTP scheme', value: 'ftp://operator.example.com/hooks' },
    { label: 'JavaScript scheme', value: 'javascript:alert(1)' },
    { label: 'data scheme', value: 'data:text/plain,manifest' },
    { label: 'username', value: 'https://user@operator.example.com/hooks' },
    { label: 'password', value: 'https://:test-password@operator.example.com/hooks' },
    { label: 'username and password', value: 'https://user:test-password@operator.example.com/hooks' },
    { label: 'unparsable host', value: 'https://[' },
    { label: 'unparsable text', value: 'not a URL' },
    { label: 'blank', value: '' },
    { label: 'whitespace', value: '   ' },
  ])('rejects $label without exporting callbacks or submitting a form', ({ value }) => {
    render(<ManifestDrawer open orgName="operator-org" webhookUrl={validWebhook} providers={{}} personas={{}} />);
    fireEvent.change(screen.getByLabelText('Deployment Webhook URL'), { target: { value } });
    const manifest = readManifest();
    expect(manifest.hook_attributes.url).toBe(value);
    expect(manifest).not.toHaveProperty('redirect_url');
    expect(manifest).not.toHaveProperty('callback_urls');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid HTTP(S) deployment webhook URL');
    expect(createButton()).toBeDisabled();
    fireEvent.click(createButton());
    expect(submitForm).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'unparsable supplied URL', webhook: 'https://[' },
    { label: 'blank supplied URL', webhook: '' },
  ])('keeps $label invalid during initial configuration resolution', ({ webhook }) => {
    render(<ManifestDrawer open orgName="operator-org" webhookUrl={webhook} providers={{}} personas={{}} />);
    expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue(webhook);
    expect(readManifest()).not.toHaveProperty('redirect_url');
    expect(createButton()).toBeDisabled();
    fireEvent.click(createButton());
    expect(submitForm).not.toHaveBeenCalled();
  });

  it('hydrates the stored configured URL after an asynchronous response', async () => {
    const pending = deferred<GitHubAppConfig>();
    vi.mocked(fetchGitHubAppConfig).mockReturnValue(pending.promise);
    render(<ManifestDrawer open orgName="operator-org" providers={{}} personas={{}} />);
    expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue(`${window.location.origin}/api/webhooks/github`);
    await act(async () => {
      pending.resolve(configuration('https://stored.example.com/deployment/hooks'));
      await pending.promise;
    });
    expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue('https://stored.example.com/deployment/hooks');
    expect(readManifest().redirect_url).toBe('https://stored.example.com/api/github/manifest-callback');
  });

  it('does not overwrite a user-edited URL when stored configuration arrives later', async () => {
    const pending = deferred<GitHubAppConfig>();
    vi.mocked(fetchGitHubAppConfig).mockReturnValue(pending.promise);
    render(<ManifestDrawer open orgName="operator-org" providers={{}} personas={{}} />);
    fireEvent.change(screen.getByLabelText('Deployment Webhook URL'), { target: { value: 'https://edited.example.com/operator/hooks' } });
    await act(async () => {
      pending.resolve(configuration('https://stored.example.com/deployment/hooks'));
      await pending.promise;
    });
    expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue('https://edited.example.com/operator/hooks');
    expect(readManifest().hook_attributes.url).toBe('https://edited.example.com/operator/hooks');
    expect(readManifest().redirect_url).toBe('https://edited.example.com/api/github/manifest-callback');
  });

  it('resolves a configured relative webhook against this deployment', async () => {
    vi.mocked(fetchGitHubAppConfig).mockResolvedValue(configuration('/configured/github-hook'));
    render(<ManifestDrawer open orgName="operator-org" providers={{}} personas={{}} />);
    await waitFor(() => expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue(`${window.location.origin}/configured/github-hook`));
    expect(readManifest().redirect_url).toBe(`${window.location.origin}/api/github/manifest-callback`);
  });

  it('shows hydration failure and preserves an explicitly entered webhook URL', async () => {
    const pending = deferred<GitHubAppConfig>();
    vi.mocked(fetchGitHubAppConfig).mockReturnValue(pending.promise);
    render(<ManifestDrawer open orgName="operator-org" providers={{}} personas={{}} />);
    fireEvent.change(screen.getByLabelText('Deployment Webhook URL'), { target: { value: 'https://edited.example.com/operator/hooks' } });
    await act(async () => {
      pending.reject(new Error('unavailable'));
      await pending.promise.catch(() => {});
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the configured webhook URL');
    expect(screen.getByLabelText('Deployment Webhook URL')).toHaveValue('https://edited.example.com/operator/hooks');
    expect(readManifest().redirect_url).toBe('https://edited.example.com/api/github/manifest-callback');
  });

  it.each([
    { label: 'absent', org: undefined },
    { label: 'empty', org: '' },
    { label: 'whitespace', org: '   ' },
  ])('does not submit for a $label organization, even with a valid callback', ({ org }) => {
    render(<ManifestDrawer open orgName={org} webhookUrl={validWebhook} providers={{}} personas={{}} />);
    expect(readManifest().redirect_url).toBe('https://operator.example.com/api/github/manifest-callback');
    expect(createButton()).toBeDisabled();
    fireEvent.click(createButton());
    expect(submitForm).not.toHaveBeenCalled();
    expect(document.querySelector('form[action*="settings/apps/new"]')).toBeNull();
  });

  it('submits the displayed valid manifest to the explicitly configured organization', () => {
    let submitted: { method: string; action: string; target: string; manifest: RenderedManifest } | undefined;
    submitForm.mockImplementation(function (this: HTMLFormElement) {
      submitted = { method: this.method, action: this.action, target: this.target,
        manifest: JSON.parse((this.elements.namedItem('manifest') as HTMLInputElement).value) };
    });
    render(<ManifestDrawer open orgName=" operator-org " webhookUrl={validWebhook} providers={{}} personas={{}} />);
    const displayed = readManifest();
    fireEvent.click(createButton());
    expect(submitForm).toHaveBeenCalledOnce();
    expect(submitted).toEqual({ method: 'post', action: 'https://github.com/organizations/operator-org/settings/apps/new', target: '_blank', manifest: displayed });
    expect(document.querySelector('form[action*="settings/apps/new"]')).toBeNull();
  });
});
