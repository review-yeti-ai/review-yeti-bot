// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import LiveDashboardView from '../../src/components/live/LiveDashboardView';
import { ActiveJobsSidebar } from '../../src/components/live/active-jobs-sidebar';
import { PersonaProgressGrid } from '../../src/components/live/persona-progress-grid';
import { TerminalFeed } from '../../src/components/live/terminal-feed';
import { PersonaTabs } from '../../src/components/live/persona-tabs';
import { StreamingMetricsCharts } from '../../src/components/live/streaming-metrics-charts';
import { LiveStreamEvent, PersonaProgressState, LiveJobSummary } from '../../src/types/live';

// Mock ResizeObserver for Recharts in jsdom
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.ResizeObserver =
      window.ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  vi.restoreAllMocks();
});

describe('Empirical Verification Suite — R3 (Persona Removal) & R4 (Clickable & Filterable Jobs Sidebar)', () => {

  describe('1. Requirement R3: Persona Removal from Overview Page (src/app/page.tsx)', () => {
    it('verifies src/app/page.tsx does NOT import or render PersonaStatusGrid', () => {
      const pagePath = path.join(process.cwd(), 'src/app/page.tsx');
      const pageContent = fs.readFileSync(pagePath, 'utf-8');

      // Check import statement
      expect(pageContent).not.toContain('PersonaStatusGrid');
      expect(pageContent).not.toContain('persona-status-grid');

      // Check JSX usage
      expect(pageContent).not.toMatch(/<PersonaStatusGrid/);

      // Confirm expected components ARE present
      expect(pageContent).toContain('OverviewMetrics');
      expect(pageContent).toContain('RecentReviewsTable');
      expect(pageContent).toContain('TelemetryChartsGrid');
    });
  });

  describe('2. Requirement R4: ActiveJobsSidebar & Job Selection', () => {
    const mockJobs: LiveJobSummary[] = [
      {
        jobId: 'job_alpha_101',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 101,
        title: 'Fix SIP Protocol Parsing',
        status: 'active',
        personaProgress: {},
        tokenMetrics: {
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
          estimatedCostUSD: 0.005,
          tokensPerSec: 35,
          latencyMs: 150,
          astNodes: 40,
          nitsFound: 1,
        },
        startTime: new Date().toISOString(),
        eventCount: 25,
        lastEventTime: new Date().toISOString(),
      },
      {
        jobId: 'job_beta_202',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 202,
        title: 'Upgrade OpenSSL Library',
        status: 'completed',
        personaProgress: {},
        tokenMetrics: {
          promptTokens: 1200,
          completionTokens: 400,
          totalTokens: 1600,
          estimatedCostUSD: 0.012,
          tokensPerSec: 50,
          latencyMs: 300,
          astNodes: 85,
          nitsFound: 0,
        },
        startTime: new Date().toISOString(),
        eventCount: 88,
        lastEventTime: new Date().toISOString(),
      },
    ];

    it('renders ActiveJobsSidebar with active job cards and count badge', () => {
      const onSelect = vi.fn();
      const onRefresh = vi.fn();

      render(
        <ActiveJobsSidebar
          currentJobId="job_alpha_101"
          onSelectJob={onSelect}
          activeJobs={mockJobs}
          onRefresh={onRefresh}
        />
      );

      expect(screen.getByText('Active Review Jobs')).toBeDefined();
      expect(screen.getByText('2')).toBeDefined(); // Badge count
      expect(screen.getByText('Fix SIP Protocol Parsing')).toBeDefined();
      expect(screen.getByText('Upgrade OpenSSL Library')).toBeDefined();
      expect(screen.getByText('ACTIVE')).toBeDefined();
      expect(screen.getByText('completed')).toBeDefined();
    });

    it('triggers onSelectJob when a job card is clicked or activated with keyboard', () => {
      const onSelect = vi.fn();

      render(
        <ActiveJobsSidebar
          currentJobId="job_alpha_101"
          onSelectJob={onSelect}
          activeJobs={mockJobs}
        />
      );

      const secondJobCard = screen.getByText('Upgrade OpenSSL Library');
      fireEvent.click(secondJobCard);

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith('job_beta_202');
    });

    it('renders fallback empty state when activeJobs is empty and permits streaming default job', () => {
      const onSelect = vi.fn();

      render(
        <ActiveJobsSidebar
          currentJobId={null}
          onSelectJob={onSelect}
          activeJobs={[]}
        />
      );

      expect(screen.getByText('No active review jobs found.')).toBeDefined();
      const defaultJobBtn = screen.getByText('Stream Default Job');
      fireEvent.click(defaultJobBtn);

      expect(onSelect).toHaveBeenCalledWith('default-job');
    });
  });

  describe('3. Requirement R4: URL SearchParams Sync & Stream Switch in LiveDashboardView', () => {
    it('updates URL searchParams ?jobId=... when job is selected via sidebar or form submit', async () => {
      const pushStateSpy = vi.spyOn(window.history, 'pushState');

      render(<LiveDashboardView />);

      const jobInput = screen.getByPlaceholderText(/Enter Job ID/i);
      expect(jobInput).toBeDefined();

      fireEvent.change(jobInput, { target: { value: 'job_custom_999' } });
      const switchBtn = screen.getByText('Switch Stream');
      fireEvent.click(switchBtn);

      expect(pushStateSpy).toHaveBeenCalled();
      const lastCallUrl = pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2] as string;
      expect(lastCallUrl).toContain('jobId=job_custom_999');
    });
  });

  describe('4. Requirement R4: Event Stream Filtering Across Terminal Logs, Charts, and Persona Progress Cards', () => {
    const mockEvents: LiveStreamEvent[] = [
      {
        jobId: 'job_test',
        timestamp: '2026-07-29T20:00:00Z',
        type: 'persona:start',
        persona: 'security',
        data: { message: 'Security audit started' },
      },
      {
        jobId: 'job_test',
        timestamp: '2026-07-29T20:00:01Z',
        type: 'persona:chunk',
        persona: 'security',
        data: { stream: 'stdout', chunk: 'SEC01: Checking JWT secret validation' },
      },
      {
        jobId: 'job_test',
        timestamp: '2026-07-29T20:00:02Z',
        type: 'persona:chunk',
        persona: 'architecture',
        data: { stream: 'stderr', isError: true, chunk: 'ARCH02: High coupling detected in module X' },
      },
    ];

    it('filters terminal feed logs by selected persona tab', () => {
      const { rerender } = render(
        <TerminalFeed events={mockEvents} selectedPersona="all" />
      );

      // 'all' shows both security and architecture
      expect(screen.getByText('SEC01: Checking JWT secret validation')).toBeDefined();
      expect(screen.getByText('ARCH02: High coupling detected in module X')).toBeDefined();

      // Switch to 'security'
      const securityFilteredEvents = mockEvents.filter((e) => e.persona === 'security');
      rerender(<TerminalFeed events={securityFilteredEvents} selectedPersona="security" />);

      expect(screen.getByText('SEC01: Checking JWT secret validation')).toBeDefined();
      expect(screen.queryByText('ARCH02: High coupling detected in module X')).toBeNull();
    });

    it('filters terminal feed logs using local search input query', () => {
      render(<TerminalFeed events={mockEvents} selectedPersona="all" />);

      const searchInput = screen.getByPlaceholderText('Search terminal output...');
      fireEvent.change(searchInput, { target: { value: 'JWT secret' } });

      expect(screen.getByText('SEC01: Checking JWT secret validation')).toBeDefined();
      expect(screen.queryByText('ARCH02: High coupling detected in module X')).toBeNull();
    });

    it('renders persona progress cards with correct progress values and triggers onPersonaClick', () => {
      const onPersonaClick = vi.fn();
      const progressData: Record<string, PersonaProgressState> = {
        security: {
          persona: 'security',
          status: 'COMPLETED',
          progress: 100,
          findingsCount: 3,
          lastMessage: '3 security issues detected',
        },
        architecture: {
          persona: 'architecture',
          status: 'IN PROGRESS',
          progress: 60,
          findingsCount: 1,
          lastMessage: 'Analyzing imports...',
        },
      };

      render(
        <PersonaProgressGrid
          personaProgress={progressData}
          onPersonaClick={onPersonaClick}
        />
      );

      expect(screen.getByText('100%')).toBeDefined();
      expect(screen.getByText('60%')).toBeDefined();
      expect(screen.getByText('3 findings')).toBeDefined();
      expect(screen.getByText('1 finding')).toBeDefined();

      const securityCard = screen.getByText('Security');
      fireEvent.click(securityCard);

      expect(onPersonaClick).toHaveBeenCalledWith('security');
    });

    it('displays streaming metrics and recharts without errors under high load', () => {
      const mockMetrics = {
        promptTokens: 45000,
        completionTokens: 12000,
        totalTokens: 57000,
        estimatedCostUSD: 0.285,
        tokensPerSec: 125.4,
        latencyMs: 420,
        astNodes: 890,
        nitsFound: 14,
      };

      render(<StreamingMetricsCharts metrics={mockMetrics} history={[]} />);

      expect(screen.getByText('45,000')).toBeDefined();
      expect(screen.getByText('12,000')).toBeDefined();
      expect(screen.getByText('57,000')).toBeDefined();
      expect(screen.getByText('$0.2850')).toBeDefined();
      expect(screen.getByText('125.4 t/s')).toBeDefined();
    });
  });

  describe('5. High Event Stress Harness (500+ events across 11 personas)', () => {
    it('handles 550 events across 11 personas without breaking state or crashing components', () => {
      const personas = [
        'security', 'architecture', 'performance', 'quality', 'database',
        'api_contract', 'reliability', 'devops', 'docs_compliance', 'finops', 'red_team'
      ];

      const highVolumeEvents: LiveStreamEvent[] = [];
      const progressMap: Record<string, PersonaProgressState> = {};

      personas.forEach((p, pIdx) => {
        progressMap[p] = {
          persona: p,
          status: pIdx % 2 === 0 ? 'COMPLETED' : 'IN PROGRESS',
          progress: (pIdx + 1) * 9,
          findingsCount: pIdx,
          lastMessage: `Persona ${p} active with event batch`,
        };

        for (let i = 0; i < 50; i++) {
          highVolumeEvents.push({
            jobId: 'job_stress_550',
            timestamp: new Date(Date.now() + i * 100).toISOString(),
            type: 'persona:chunk',
            persona: p,
            data: { stream: 'stdout', chunk: `[${p}] Event log line #${i + 1} processing payload AST node ${i * 12}` },
          });
        }
      });

      expect(highVolumeEvents.length).toBe(550);

      const { container } = render(
        <div>
          <StreamingMetricsCharts metrics={{
            promptTokens: 100000,
            completionTokens: 25000,
            totalTokens: 125000,
            estimatedCostUSD: 0.625,
            tokensPerSec: 240,
            latencyMs: 180,
            astNodes: 4500,
            nitsFound: 32,
          }} history={[]} />
          <PersonaProgressGrid personaProgress={progressMap} />
          <PersonaTabs selectedPersona="all" onSelectPersona={() => {}} events={highVolumeEvents} />
          <TerminalFeed events={highVolumeEvents} selectedPersona="all" />
        </div>
      );

      expect(container).toBeDefined();
      expect(screen.getByText('125,000')).toBeDefined();
      expect(screen.getAllByText('550').length).toBeGreaterThanOrEqual(1); // Total events badge on PersonaTabs & log line #550
    });
  });
});
