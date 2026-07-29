// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalFeed } from '../../src/components/live/terminal-feed';
import { PersonaTabs, formatPersonaName } from '../../src/components/live/persona-tabs';
import { PersonaProgressGrid, getStatusBadgeVariant } from '../../src/components/live/persona-progress-grid';
import { StreamingMetricsCharts } from '../../src/components/live/streaming-metrics-charts';
import { ActiveJobsSidebar } from '../../src/components/live/active-jobs-sidebar';
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
});

describe('Live Terminal UI Components Unit Suite', () => {
  describe('formatPersonaName & getStatusBadgeVariant', () => {
    it('formats persona keys into clean titles', () => {
      expect(formatPersonaName('all')).toBe('All Personas');
      expect(formatPersonaName('api_contract')).toBe('API Contract');
      expect(formatPersonaName('docs_compliance')).toBe('Docs Compliance');
      expect(formatPersonaName('red_team')).toBe('Red Team');
      expect(formatPersonaName('security')).toBe('Security');
    });

    it('returns appropriate badge variants for persona status', () => {
      expect(getStatusBadgeVariant('COMPLETED')).toBe('success');
      expect(getStatusBadgeVariant('IN PROGRESS')).toBe('default');
      expect(getStatusBadgeVariant('FAILED')).toBe('destructive');
      expect(getStatusBadgeVariant('PENDING')).toBe('secondary');
    });
  });

  describe('TerminalFeed Component', () => {
    const mockEvents: LiveStreamEvent[] = [
      {
        jobId: 'job-1',
        timestamp: '2026-07-27T09:00:00Z',
        type: 'persona:start',
        persona: 'security',
        data: { message: 'Security scan initialized' },
      },
      {
        jobId: 'job-1',
        timestamp: '2026-07-27T09:00:01Z',
        type: 'persona:chunk',
        persona: 'security',
        data: { isError: true, stream: 'stderr', chunk: 'ERROR: Null pointer exception detected' },
      },
    ];

    it('renders 1-indexed line numbers and stdout/stderr log lines', () => {
      render(<TerminalFeed events={mockEvents} selectedPersona="security" />);

      expect(screen.getByText('Terminal Feed')).toBeDefined();
      expect(screen.getByText('Security scan initialized')).toBeDefined();
      expect(screen.getByText('ERROR: Null pointer exception detected')).toBeDefined();

      // Check 1-indexed line numbers
      expect(screen.getByText('1')).toBeDefined();
      expect(screen.getByText('2')).toBeDefined();
    });

    it('filters terminal log lines using search query input', () => {
      render(<TerminalFeed events={mockEvents} />);

      const searchInput = screen.getByPlaceholderText('Search terminal output...');
      fireEvent.change(searchInput, { target: { value: 'Null pointer' } });

      expect(screen.getByText('ERROR: Null pointer exception detected')).toBeDefined();
      expect(screen.queryByText('Security scan initialized')).toBeNull();
    });

    it('calls onClear callback when clear button is clicked', () => {
      const handleClear = vi.fn();
      render(<TerminalFeed events={mockEvents} onClear={handleClear} />);

      const clearBtn = screen.getByText('Clear');
      fireEvent.click(clearBtn);

      expect(handleClear).toHaveBeenCalledTimes(1);
    });
  });

  describe('PersonaTabs Component', () => {
    it('renders all 11 persona tabs + All Personas view with event badges', () => {
      const handleSelect = vi.fn();
      render(
        <PersonaTabs
          selectedPersona="all"
          onSelectPersona={handleSelect}
          events={[
            { jobId: 'j1', timestamp: 't', type: 'persona:start', persona: 'security', data: {} },
            { jobId: 'j1', timestamp: 't', type: 'persona:start', persona: 'security', data: {} },
            { jobId: 'j1', timestamp: 't', type: 'persona:start', persona: 'red_team', data: {} },
          ]}
        />
      );

      expect(screen.getByText('All Personas')).toBeDefined();
      expect(screen.getByText('Security')).toBeDefined();
      expect(screen.getByText('Red Team')).toBeDefined();
      expect(screen.getByText('Docs Compliance')).toBeDefined();

      // Event counts badge
      expect(screen.getByText('3')).toBeDefined();
    });

    it('triggers onSelectPersona callback on tab click or selection', () => {
      const handleSelect = vi.fn();
      render(<PersonaTabs selectedPersona="all" onSelectPersona={handleSelect} />);

      const securityTab = screen.getByRole('tab', { name: /Security/i });
      fireEvent.keyDown(securityTab, { key: 'Enter', code: 'Enter' });
      fireEvent.click(securityTab);

      expect(handleSelect).toHaveBeenCalledWith('security');
    });
  });

  describe('PersonaProgressGrid Component', () => {
    it('renders execution progress bars and status badges for all 11 personas', () => {
      const mockProgress: Record<string, PersonaProgressState> = {
        security: {
          persona: 'security',
          status: 'COMPLETED',
          progress: 100,
          findingsCount: 4,
          lastMessage: 'Found 4 security vulnerabilities',
        },
        performance: {
          persona: 'performance',
          status: 'IN PROGRESS',
          progress: 45,
          lastMessage: 'Analyzing N+1 queries...',
        },
      };

      render(<PersonaProgressGrid personaProgress={mockProgress} />);

      expect(screen.getByText('COMPLETED')).toBeDefined();
      expect(screen.getByText('IN PROGRESS')).toBeDefined();
      expect(screen.getByText('100%')).toBeDefined();
      expect(screen.getByText('45%')).toBeDefined();
      expect(screen.getByText('4 findings')).toBeDefined();
    });
  });

  describe('StreamingMetricsCharts Component', () => {
    it('renders real-time token metrics stat cards', () => {
      const mockMetrics = {
        promptTokens: 1250,
        completionTokens: 320,
        totalTokens: 1570,
        estimatedCostUSD: 0.0154,
        tokensPerSec: 42.5,
        latencyMs: 380,
        astNodes: 124,
        nitsFound: 2,
      };

      render(<StreamingMetricsCharts metrics={mockMetrics} history={[]} />);

      expect(screen.getByText('1,250')).toBeDefined();
      expect(screen.getByText('320')).toBeDefined();
      expect(screen.getByText('1,570')).toBeDefined();
      expect(screen.getByText('$0.0154')).toBeDefined();
      expect(screen.getByText('42.5 t/s')).toBeDefined();
      expect(screen.getByText('380 ms')).toBeDefined();
      expect(screen.getByText('124')).toBeDefined();
      expect(screen.getByText('2')).toBeDefined();
    });
  });

  describe('ActiveJobsSidebar Component', () => {
    const mockJobs: LiveJobSummary[] = [
      {
        jobId: 'job_cisco_pr42',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        title: 'Add OAuth2 Token Support',
        status: 'active',
        personaProgress: {},
        tokenMetrics: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCostUSD: 0.001,
          tokensPerSec: 20,
          latencyMs: 200,
          astNodes: 10,
          nitsFound: 0,
        },
        startTime: new Date().toISOString(),
        eventCount: 48,
        lastEventTime: new Date().toISOString(),
      },
    ];

    it('renders active jobs list with repo name, PR title, and status badge', () => {
      const handleSelectJob = vi.fn();
      render(
        <ActiveJobsSidebar
          currentJobId="job_cisco_pr42"
          onSelectJob={handleSelectJob}
          activeJobs={mockJobs}
        />
      );

      expect(screen.getByText('Add OAuth2 Token Support')).toBeDefined();
      expect(screen.getByText('calltelemetry/cisco-cdr')).toBeDefined();
      expect(screen.getByText('ACTIVE')).toBeDefined();
      expect(screen.getByText('48 events')).toBeDefined();
    });

    it('calls onSelectJob when a job item is clicked', () => {
      const handleSelectJob = vi.fn();
      render(
        <ActiveJobsSidebar
          currentJobId="other_job"
          onSelectJob={handleSelectJob}
          activeJobs={mockJobs}
        />
      );

      const jobItem = screen.getByText('Add OAuth2 Token Support');
      fireEvent.click(jobItem);

      expect(handleSelectJob).toHaveBeenCalledWith('job_cisco_pr42');
    });
  });
});
