// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopyButton } from '@/components/ui/copy-button';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { HowToGuideCard } from '@/components/onboarding/how-to-guide-card';
import { CostEstimatorCard, SpendingCapModal } from '@/components/onboarding/cost-estimator-card';

// JSDOM Mocks for Radix UI Primitives & Web APIs
if (typeof window !== 'undefined') {
  window.PointerEvent = window.PointerEvent || class PointerEvent extends Event {};
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function () {};
  window.HTMLElement.prototype.hasPointerCapture = window.HTMLElement.prototype.hasPointerCapture || function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = window.HTMLElement.prototype.releasePointerCapture || function () {};
}

// Mock clipboard API
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

describe('Milestone 3: How-To Guides, Tooltips, Manifest Generator & Drawers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CopyButton Component', () => {
    it('renders default Copy label and copies text on click', async () => {
      render(<CopyButton value="test-copy-text" label="Copy Secret" />);

      const btn = screen.getByRole('button', { name: /copy secret/i });
      expect(btn).toBeDefined();

      fireEvent.click(btn);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('test-copy-text');
        expect(screen.getByText('Copied!')).toBeDefined();
      });
    });

    it('customizes copied label and calls onCopy callback', async () => {
      const onCopyMock = vi.fn();
      render(
        <CopyButton
          value="custom-val"
          label="Copy Token"
          copiedLabel="Token Copied!"
          onCopy={onCopyMock}
        />
      );

      const btn = screen.getByRole('button', { name: /copy token/i });
      fireEvent.click(btn);

      await waitFor(() => {
        expect(screen.getByText('Token Copied!')).toBeDefined();
        expect(onCopyMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('ManifestDrawer Component', () => {
    it('renders manifest drawer when open and displays JSON & YAML tabs', () => {
      render(<ManifestDrawer open={true} orgName="testorg" appName="my-test-app" />);

      expect(screen.getByText(/GitHub App Manifest & YAML Generator/i)).toBeDefined();
      expect(screen.getAllByText(/manifest.json/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/.ct-review.yml Specification/i)).toBeDefined();
    });

    it('allows changing organization name in drawer input', () => {
      render(<ManifestDrawer open={true} orgName="custom-org" appName="custom-app" />);

      const inputs = screen.getAllByRole('textbox');
      const orgInput = inputs[0] as HTMLInputElement;
      expect(orgInput).toBeDefined();
      expect(orgInput.value).toBe('custom-org');

      fireEvent.change(orgInput, { target: { value: 'acme-corp' } });
      expect(orgInput.value).toBe('acme-corp');
    });
  });

  describe('HowToGuideCard Component', () => {
    it('renders guide tabs header and initial GitHub App registration guide', () => {
      render(<HowToGuideCard />);

      expect(screen.getByText(/Onboarding How-To Guides & Documentation/i)).toBeDefined();
      expect(screen.getByText(/1. GitHub App Registration/i)).toBeDefined();
      expect(screen.getByText(/2. Finding API Keys & Org IDs/i)).toBeDefined();
      expect(screen.getByText(/3. OmniRoute & Spending Caps/i)).toBeDefined();
      expect(screen.getByText(/How to Register a GitHub App for your Organization/i)).toBeDefined();
    });
  });

  describe('CostEstimatorCard & SpendingCapModal Component', () => {
    it('renders cost estimator with default calculation', () => {
      render(<CostEstimatorCard />);

      expect(screen.getByText(/Interactive Model Token Cost Estimator/i)).toBeDefined();
      expect(screen.getByText(/Monthly Cost Estimate Summary/i)).toBeDefined();
      expect(screen.getByText(/Estimated Monthly Pull Requests:/i)).toBeDefined();
    });

    it('opens SpendingCapModal when Configure Spending Cap button is clicked', async () => {
      render(<CostEstimatorCard />);

      const capBtn = screen.getByRole('button', { name: /Configure Spending Cap/i });
      fireEvent.click(capBtn);

      await waitFor(() => {
        expect(screen.getByText(/Configure Organization Spending Cap/i)).toBeDefined();
        expect(screen.getByText(/Monthly Budget Limit \(\$ USD\)/i)).toBeDefined();
      });
    });

    it('saves updated spending cap in SpendingCapModal', async () => {
      const handleSave = vi.fn();
      render(
        <SpendingCapModal
          open={true}
          onOpenChange={() => {}}
          settings={{
            monthlyCapUsd: 150,
            alertThresholdPercent: 80,
            overflowAction: 'throttle_non_critical',
          }}
          onSaveSettings={handleSave}
        />
      );

      const saveBtn = screen.getByRole('button', { name: /Save Spending Cap/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(handleSave).toHaveBeenCalledWith({
          monthlyCapUsd: 150,
          alertThresholdPercent: 80,
          overflowAction: 'throttle_non_critical',
        });
      });
    });
  });
});
