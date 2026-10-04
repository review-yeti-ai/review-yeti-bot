// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewStageStepper } from '../../../src/components/live/review-stage-stepper';
import { LiveTurnTimeline } from '../../../src/components/live/live-turn-timeline';
import { SwarmTaskMatrix } from '../../../src/components/live/SwarmTaskMatrix';
import { LiveDashboardView } from '../../../src/components/live/LiveDashboardView';
import { StageState, TurnStepRecord } from '../../../src/types/live';

const live = vi.hoisted(() => ({ setJobId: vi.fn(), clearEvents: vi.fn(), fetchActiveJobs: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('jobId=fixture-job') }));
vi.mock('../../../src/lib/api-client', () => ({
  fetchPromptGuidance: async () => [], submitPromptGuidance: vi.fn(), dismissFinding: vi.fn(), adjustFindingSeverity: vi.fn(),
}));
vi.mock('../../../src/lib/useSSE', () => ({ useSSE: () => ({
  connectionStatus: 'connected', jobId: 'fixture-job', setJobId: live.setJobId,
  events: [], selectedPersona: 'all', setSelectedPersona: vi.fn(), filteredEvents: [], personaProgress: {},
  tokenMetrics: { promptTokens: 12, completionTokens: 3, totalTokens: 15, estimatedCostUSD: 0.001, astLookups: 0, suppressedNits: 0 },
  tokenHistory: [], clearEvents: live.clearEvents, reconnect: vi.fn(),
  activeJobs: [{ jobId: 'untrusted-job', repo: '<script>bad()</script>', title: '<img src=x onerror=bad()>', status: 'running' }],
  fetchActiveJobs: live.fetchActiveJobs, reasoning: [], toolExecutions: [], anchoredFindings: [],
  swarmTasks: [{ id: 'task-fixture', dimension: 'security', description: 'Inspect authentication boundaries', priority: 1,
    status: 'RUNNING', progress: 50, findingsCount: 0 }],
  contextCompaction: null, currentStage: 'execution', stageHistory: [], overallProgress: 50, turns: [], activeTurnByTask: {},
}) }));

describe('Live Streaming Reviews - UI Component Suite', () => {
  const mockStages: StageState[] = [
    {
      stage: 'admission',
      label: '1. Ingress Gate',
      description: 'Validate payload & acquire RepoGate lease',
      status: 'completed',
      progress: 100,
      durationMs: 450,
    },
    {
      stage: 'compaction',
      label: '2. Context Compaction',
      description: 'Compact unified diff into AST outlines',
      status: 'completed',
      progress: 100,
      durationMs: 1200,
    },
    {
      stage: 'planning',
      label: '3. Swarm Planning',
      description: 'Decompose PR into scoped subagent tasks',
      status: 'running',
      progress: 50,
    },
    {
      stage: 'execution',
      label: '4. Subagent Turns',
      description: 'Execute isolated turns and tool calls',
      status: 'pending',
      progress: 0,
    },
    {
      stage: 'arbitration',
      label: '5. Arbitration',
      description: 'Deduplicate findings and evaluate consensus',
      status: 'pending',
      progress: 0,
    },
    {
      stage: 'publication',
      label: '6. Publish & Attest',
      description: 'Persist review to D1 & emit check-run',
      status: 'pending',
      progress: 0,
    },
  ];

  const mockTurns: TurnStepRecord[] = [
    {
      id: 'turn_1',
      jobId: 'job_test_1',
      personaId: 'security',
      taskId: 'task_sec',
      turn: 1,
      maxTurns: 20,
      action: 'planning',
      tool: 'ast_lookup',
      input: { path: 'src/secret.ts' },
      output: { clean: true },
      tokensBurned: 1420,
      latencyMs: 310,
      timestamp: new Date().toISOString(),
    },
    {
      id: 'turn_2',
      jobId: 'job_test_1',
      personaId: 'architecture',
      taskId: 'task_arch',
      turn: 2,
      maxTurns: 20,
      action: 'tool_call',
      tool: 'diff_inspect',
      input: { hunkBounds: [10, 20] },
      output: { outlineNodes: 5 },
      tokensBurned: 2840,
      latencyMs: 540,
      timestamp: new Date().toISOString(),
    },
  ];

  describe('ReviewStageStepper Component', () => {
    it('renders the 6 pipeline stages and overall progress percentage', () => {
      render(
        <ReviewStageStepper
          currentStage="planning"
          stages={mockStages}
          overallProgress={45}
        />
      );

      expect(screen.getByTestId('review-stage-stepper')).toBeInTheDocument();
      expect(screen.getByText('45%')).toBeInTheDocument();
      expect(screen.getByText(/ACTIVE STAGE: PLANNING/i)).toBeInTheDocument();

      expect(screen.getByTestId('stage-step-admission')).toBeInTheDocument();
      expect(screen.getByTestId('stage-step-compaction')).toBeInTheDocument();
      expect(screen.getByTestId('stage-step-planning')).toBeInTheDocument();
      expect(screen.getByTestId('stage-step-execution')).toBeInTheDocument();
      expect(screen.getByTestId('stage-step-arbitration')).toBeInTheDocument();
      expect(screen.getByTestId('stage-step-publication')).toBeInTheDocument();
    });

    it('highlights running stage and displays completed durations', () => {
      render(
        <ReviewStageStepper
          currentStage="planning"
          stages={mockStages}
          overallProgress={45}
        />
      );

      expect(screen.getByText('450ms')).toBeInTheDocument();
      expect(screen.getByText('1.2s')).toBeInTheDocument();
      expect(screen.getByText('In Flight')).toBeInTheDocument();
    });
  });

  describe('LiveTurnTimeline Component', () => {
    it('renders turn execution steps with tool inputs, outputs, and token counts', () => {
      render(<LiveTurnTimeline turns={mockTurns} />);

      expect(screen.getByTestId('live-turn-timeline-container')).toBeInTheDocument();
      expect(screen.getByTestId('turn-timeline-step-1')).toBeInTheDocument();
      expect(screen.getByTestId('turn-timeline-step-2')).toBeInTheDocument();

      expect(screen.getByText(/1,420 tok/i)).toBeInTheDocument();
      expect(screen.getByText(/2,840 tok/i)).toBeInTheDocument();
      expect(screen.getByText('310ms')).toBeInTheDocument();
      expect(screen.getByText('540ms')).toBeInTheDocument();
      expect(screen.getByText(/ast_lookup/i)).toBeInTheDocument();
      expect(screen.getByText(/diff_inspect/i)).toBeInTheDocument();
    });

    it('filters turns by persona when filter chip is clicked', () => {
      render(<LiveTurnTimeline turns={mockTurns} />);

      const securityChip = screen.getByRole('button', { name: /security/i });
      fireEvent.click(securityChip);

      expect(screen.getByTestId('turn-timeline-step-1')).toBeInTheDocument();
      expect(screen.queryByTestId('turn-timeline-step-2')).not.toBeInTheDocument();
    });

    it('displays empty state when no turns match filter', () => {
      render(<LiveTurnTimeline turns={mockTurns} selectedTaskId="non_existent" />);
      expect(screen.getByTestId('turn-timeline-empty')).toBeInTheDocument();
    });
  });

  describe('SwarmTaskMatrix Turn Pills', () => {
    it('renders turn badges on task cards when activeTurnByTask is provided', () => {
      const activeTurns = {
        task_sec_boundary: { current: 3, max: 20 },
      };

      render(
        <SwarmTaskMatrix
          tasks={[{
            id: 'task_sec_boundary',
            dimension: 'security',
            description: 'Enforce security floor: secret redaction, credential scanning, and edge boundary fences',
            paths: ['src/gateway/edgeCompactionEngine.ts'],
            priority: 1,
            status: 'COMPLETED',
            progress: 100,
            findingsCount: 0,
          }]}
          activeTurnByTask={activeTurns}
        />
      );

      const turnBadge = screen.getByTestId('task-turn-badge-task_sec_boundary');
      expect(turnBadge).toBeInTheDocument();
      expect(turnBadge).toHaveTextContent('T3/20');
    });

    it.each([undefined, []])('keeps standby state for absent or empty tasks (%j)', (tasks) => {
      render(<SwarmTaskMatrix tasks={tasks} activeTurnByTask={{ task_sec_boundary: { current: 3, max: 20 } }} />);

      expect(screen.getByText('Swarm Standby — 0 Tasks In Flight')).toBeInTheDocument();
      expect(screen.getByText('0/0 Done')).toBeInTheDocument();
      expect(screen.getByText('Idle')).toBeInTheDocument();
      expect(screen.queryByTestId('task-turn-badge-task_sec_boundary')).not.toBeInTheDocument();
    });
  });
});


describe('Hydrated live swarm user flows', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/live?jobId=fixture-job');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, files: [], findings: [] }) })));
  });

  it('submits a custom job, clears prior events, and preserves its encoded deep link', async () => {
    render(<LiveDashboardView />);
    const input = screen.getByPlaceholderText(/Enter Job ID/);
    fireEvent.change(input, { target: { value: '  task with <literal>&payload  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(live.setJobId).toHaveBeenCalledWith('task with <literal>&payload');
    expect(live.clearEvents).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get('jobId')).toBe('task with <literal>&payload');
    expect(screen.getByText('task-fixture')).toBeInTheDocument();
  });

  it('selects an active job by keyboard while rendering untrusted labels as text', () => {
    const { container } = render(<LiveDashboardView />);
    const label = screen.getByText('<img src=x onerror=bad()>');
    expect(container.querySelector('img[src="x"], script')).toBeNull();
    fireEvent.keyDown(label.closest('[role="button"]')!, { key: 'Enter' });
    expect(live.setJobId).toHaveBeenCalledWith('untrusted-job');
    expect(new URL(window.location.href).searchParams.get('jobId')).toBe('untrusted-job');
  });
});
