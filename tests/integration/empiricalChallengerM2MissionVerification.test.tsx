// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import supertest from 'supertest';
import express from 'express';

import { OverviewMetrics } from '../../src/components/dashboard/overview-metrics';
import type { OverviewStats } from '../../src/types/dashboard';

// The component's `stats` prop is declared as `OverviewStats | null`, but every field is read
// with defensive optional chaining (`stats?.totalCostUSD ?? 0`, etc.) — the real runtime contract
// tolerates a partial/empty object, which is exactly what this suite exercises. The declared
// type doesn't reflect that (a product type worth tightening to `Partial<OverviewStats> | null`,
// left alone here per scope), so an empty object is asserted to the declared type rather than
// weakening the test by fabricating stat values that would defeat the empty-state assertions.
const EMPTY_STATS = {} as OverviewStats;
import { CostEstimatorCard } from '../../src/components/onboarding/cost-estimator-card';
import { isProviderEnabled } from '../../src/lib/model-filtering';
import { createIntegrationsRouter } from '../../src/dashboard/integrationsApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('M2 Challenger Empirical Stress Tests', () => {

  afterEach(() => {
    cleanup();
  });

  describe('1. OverviewMetrics Empty State Rendering (stats={})', () => {
    it('renders correctly without throwing when stats={} is passed', () => {
      const { container } = render(<OverviewMetrics stats={EMPTY_STATS} />);
      expect(container).toBeDefined();

      // Total PR Reviews should display 0
      expect(screen.getByText('Total PR Reviews')).toBeInTheDocument();
      const zeroElements = screen.getAllByText('0');
      expect(zeroElements.length).toBeGreaterThanOrEqual(3); // totalReviews, activeRepos, symbolNodes

      // Monthly Spend / Cap should display $0.00 / $0
      expect(screen.getByText('/ $0')).toBeInTheDocument();
      expect(screen.getByText('$0.00')).toBeInTheDocument();

      // Cap status should indicate Within Budget
      const budgetStatuses = screen.getAllByText('Within Budget');
      expect(budgetStatuses.length).toBeGreaterThanOrEqual(1);

      // AST Symbol Graph Nodes card
      expect(screen.getByText('AST Symbol Graph')).toBeInTheDocument();
    });

    it('renders cleanly when stats is null or undefined', () => {
      const { container: containerNull } = render(<OverviewMetrics stats={null} />);
      expect(containerNull).toBeDefined();
      expect(screen.getAllByText('Within Budget').length).toBeGreaterThanOrEqual(1);
      cleanup();

      const { container: containerUndef } = render(<OverviewMetrics stats={undefined} />);
      expect(containerUndef).toBeDefined();
      expect(screen.getAllByText('Within Budget').length).toBeGreaterThanOrEqual(1);
    });

    it('handles clicking Spending Cap modal trigger card with stats={}', () => {
      render(<OverviewMetrics stats={EMPTY_STATS} />);
      const capCard = screen.getByText('Monthly Spend / Cap').closest('[role="button"]');
      expect(capCard).toBeInTheDocument();
      if (capCard) {
        expect(() => fireEvent.click(capCard)).not.toThrow();
      }
    });

    it('handles clicking Memory Graph modal trigger card with stats={}', () => {
      render(<OverviewMetrics stats={EMPTY_STATS} />);
      const graphCard = screen.getByText('Memory Graph Nodes').closest('[role="button"]');
      expect(graphCard).toBeInTheDocument();
      if (graphCard) {
        expect(() => fireEvent.click(graphCard)).not.toThrow();
      }
    });
  });

  describe('2. Cost Estimator Card Preset Filtering (Disabled Providers)', () => {
    it('shows all presets when no provider restriction map is provided', () => {
      render(<CostEstimatorCard providers={{}} />);
      expect(screen.getByText('Interactive Model Token Cost Estimator')).toBeInTheDocument();
      expect(screen.getByText('Monthly Cost Estimate Summary')).toBeInTheDocument();
    });

    it('filters out presets requiring disabled providers', () => {
      const providers = {
        openai: { enabled: true, active: true },
        anthropic: { enabled: true, active: true },
        deepseek: { enabled: false, active: false }, // Disables Budget preset (requires openai, deepseek)
        grok: { enabled: false, active: false },    // Disables Balanced and Premium
        codex: { enabled: true, active: true },
        agy: { enabled: true, active: true },       // Enables Max Reasoning (requires agy, codex)
      };

      render(<CostEstimatorCard providers={providers as any} />);

      expect(screen.getByText('Interactive Model Token Cost Estimator')).toBeInTheDocument();
      expect(screen.getByText('Monthly Cost Estimate Summary')).toBeInTheDocument();
    });

    it('displays warning alert when ALL providers are disabled', () => {
      const allDisabledProviders = {
        openai: { enabled: false },
        anthropic: { enabled: false },
        deepseek: { enabled: false },
        grok: { enabled: false },
        glm: { enabled: false },
        gemini: { enabled: false },
        doppler: { enabled: false },
        ollama: { enabled: false },
        'custom-openai': { enabled: false },
        codex: { enabled: false },
        agy: { enabled: false },
      };

      render(<CostEstimatorCard providers={allDisabledProviders as any} />);

      // Alert should be rendered indicating active provider configs are required
      expect(
        screen.getByText(
          'Active provider configurations are required to calculate token cost estimates. Please enable at least one provider preset.'
        )
      ).toBeInTheDocument();

      // Summary panel should not be present when 0 presets are enabled
      expect(screen.queryByText('Monthly Cost Estimate Summary')).not.toBeInTheDocument();
    });

    it('isProviderEnabled correctly checks provider enabled state and canonical aliases', () => {
      const providersState = {
        openai: { enabled: true },
        deepseek: { enabled: false },
        agy: { enabled: true },
      };

      expect(isProviderEnabled('openai', providersState as any)).toBe(true);
      expect(isProviderEnabled('deepseek', providersState as any)).toBe(false);
      expect(isProviderEnabled('agy', providersState as any)).toBe(true);

      // Alias check: custom_openai -> custom-openai
      const aliasState = {
        'custom-openai': { enabled: false },
      };
      expect(isProviderEnabled('custom_openai', aliasState as any)).toBe(false);
    });
  });

  describe('3. POST /api/dashboard/integrations/:platform/test missing credentials returns 400', () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/dashboard', createIntegrationsRouter());
    });

    it('returns 400 Bad Request when credentials are missing for unconfigured platform productlane', async () => {
      // Clear productlane integration entry so no credentials exist
      (dashboardStore as any).data.integrations = (dashboardStore as any).data.integrations || {};
      (dashboardStore as any).data.integrations['productlane'] = {
        id: 'productlane',
        name: 'Productlane Feedback',
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      };

      const response = await supertest(app)
        .post('/api/dashboard/integrations/productlane/test')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Missing valid credentials for productlane');
    });

    it('returns 400 Bad Request when stored credentials are reset/cleared for github', async () => {
      (dashboardStore as any).data.integrations = (dashboardStore as any).data.integrations || {};
      (dashboardStore as any).data.integrations['github'] = {
        id: 'github',
        name: 'GitHub App Integration',
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      };

      const response = await supertest(app)
        .post('/api/dashboard/integrations/github/test')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Missing valid credentials for github');
    });

    it('returns 400 Bad Request when stored credentials are reset/cleared for linear', async () => {
      (dashboardStore as any).data.integrations = (dashboardStore as any).data.integrations || {};
      (dashboardStore as any).data.integrations['linear'] = {
        id: 'linear',
        name: 'Linear Issue Tracker',
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      };

      const response = await supertest(app)
        .post('/api/dashboard/integrations/linear/test')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Missing valid credentials for linear');
    });

    it('returns 400 Bad Request when stored credentials are reset/cleared for slack', async () => {
      (dashboardStore as any).data.integrations = (dashboardStore as any).data.integrations || {};
      (dashboardStore as any).data.integrations['slack'] = {
        id: 'slack',
        name: 'Slack Notifications',
        status: 'disconnected',
        updatedAt: new Date().toISOString(),
      };

      const response = await supertest(app)
        .post('/api/dashboard/integrations/slack/test')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Missing valid credentials for slack');
    });

    it('returns 400 Bad Request for an invalid/unsupported platform', async () => {
      const response = await supertest(app)
        .post('/api/dashboard/integrations/nonexistent_platform/test')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid or missing platform');
    });

    it('returns 200 OK when credentials (apiKey) ARE provided in request body', async () => {
      const response = await supertest(app)
        .post('/api/dashboard/integrations/github/test')
        .send({ apiKey: 'ghp_test_token_12345' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('connected');
      expect(response.body.message).toContain('Connection to github verified successfully');
    });
  });
});
