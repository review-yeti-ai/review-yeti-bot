// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { OnboardingWizard } from '@/components/github-app/onboarding-wizard';

describe('Onboarding Wizard Component Unit Tests', () => {
  it('renders initial inputs for GitHub App ID and Installation ID', () => {
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

  it('triggers onVerify callback when verify button is clicked', async () => {
    const handleVerify = vi.fn().mockResolvedValue(undefined);

    render(
      <OnboardingWizard
        config={{
          appId: '999111',
          installationId: '888222',
          webhookSecretConfigured: true,
          privateKeyConfigured: true,
          status: 'configured',
          updatedAt: new Date().toISOString(),
        }}
        onVerify={handleVerify}
      />
    );

    const verifyButton = screen.getByRole('button', { name: /verify credentials/i });
    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(handleVerify).toHaveBeenCalledWith({
        appId: '999111',
        installationId: '888222',
      });
    });

    expect(screen.getByText('JWT RSA Key Pair Verified')).toBeInTheDocument();
  });

  it('toggles policy requirements when buttons are clicked', () => {
    render(<OnboardingWizard />);

    const reqAllButton = screen.getAllByRole('button', { name: /enabled/i })[0];
    expect(reqAllButton).toBeInTheDocument();

    fireEvent.click(reqAllButton);
    expect(screen.getByRole('button', { name: /disabled/i })).toBeInTheDocument();
  });

  it('handles private key drag and drop zone', () => {
    render(<OnboardingWizard />);

    const dropzone = screen.getByText(/drag and drop private key file/i);
    expect(dropzone).toBeInTheDocument();

    fireEvent.click(dropzone);
    expect(screen.getByText(/RS256 Private Key Configured/i)).toBeInTheDocument();
  });
});
