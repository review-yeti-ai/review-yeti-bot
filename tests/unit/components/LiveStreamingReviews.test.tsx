// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewStageStepper } from '../../../src/components/live/review-stage-stepper';
import { LiveTurnTimeline } from '../../../src/components/live/live-turn-timeline';
import { SwarmTaskMatrix } from '../../../src/components/live/SwarmTaskMatrix';
import { StageState, TurnStepRecord } from '../../../src/types/live';

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
          activeTurnByTask={activeTurns}
        />
      );

      const turnBadge = screen.getByTestId('task-turn-badge-task_sec_boundary');
      expect(turnBadge).toBeInTheDocument();
      expect(turnBadge).toHaveTextContent('T3/20');
    });
  });
});
