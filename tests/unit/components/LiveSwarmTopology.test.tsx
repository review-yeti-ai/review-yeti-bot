// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  NodeHoverInspectionCard,
  TopologyNodeData,
} from '@/components/live/NodeHoverInspectionCard';
import { NodeDetailsDrawer } from '@/components/live/NodeDetailsDrawer';
import { LiveSwarmTopologyCanvas } from '@/components/live/LiveSwarmTopologyCanvas';
import { LiveDashboardView } from '@/components/live/LiveDashboardView';

const sampleNode: TopologyNodeData = {
  id: 'task_sec_boundary',
  title: 'Security Sentinel',
  subtitle: 'Subagent: SECURITY',
  type: 'swarm_agent',
  tier: 3,
  status: 'IN_FLIGHT',
  health: 99.5,
  latencyMs: 1400,
  metrics: {
    tokensPerSec: 142,
    turnsCount: 2,
    cpuMs: 18,
    memoryMb: 24.2,
    compactionRatio: 4.2,
    activeFiles: ['src/gateway/edgeCompactionEngine.ts'],
  },
  role: 'Secret redaction & edge boundary fences',
  provider: 'OpenRouter Gateway',
  model: 'anthropic/claude-3.5-sonnet',
  details: 'Specialized domain subagent executing bounded turn iterations.',
};

describe('NodeHoverInspectionCard Component', () => {
  it('renders node title, subtitle, status badge, and health SLA', () => {
    render(<NodeHoverInspectionCard node={sampleNode} />);

    expect(screen.getByText('Security Sentinel')).toBeDefined();
    expect(screen.getByText('Subagent: SECURITY')).toBeDefined();
    expect(screen.getByText('IN_FLIGHT')).toBeDefined();
    expect(screen.getByText('99.5% SLA')).toBeDefined();
  });

  it('renders live performance metrics: latency, velocity, and compaction', () => {
    render(<NodeHoverInspectionCard node={sampleNode} />);

    expect(screen.getByText('1400')).toBeDefined();
    expect(screen.getByText('142')).toBeDefined();
    expect(screen.getByText('4.2x')).toBeDefined();
    expect(screen.getByText('src/gateway/edgeCompactionEngine.ts')).toBeDefined();
  });

  it('triggers onInspectNode callback when inspect node button is clicked', () => {
    const handleInspect = vi.fn();
    render(<NodeHoverInspectionCard node={sampleNode} onInspectNode={handleInspect} />);

    const inspectBtn = screen.getByText('Inspect Node');
    fireEvent.click(inspectBtn);
    expect(handleInspect).toHaveBeenCalledWith('task_sec_boundary');
  });
});

describe('NodeDetailsDrawer Component', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <NodeDetailsDrawer node={sampleNode} isOpen={false} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders drawer header, health progress, and telemetry metrics when open', () => {
    render(
      <NodeDetailsDrawer node={sampleNode} isOpen={true} onClose={vi.fn()} />
    );

    expect(screen.getByTestId('node-details-drawer')).toBeDefined();
    expect(screen.getByText('Security Sentinel')).toBeDefined();
    expect(screen.getByText('Tier 3 Architecture')).toBeDefined();
    expect(screen.getByText('99.5% Operational')).toBeDefined();
    expect(screen.getByText('142 t/s')).toBeDefined();
    expect(screen.getByText('OpenRouter Gateway')).toBeDefined();
  });

  it('triggers onClose when close button is clicked', () => {
    const handleClose = vi.fn();
    render(
      <NodeDetailsDrawer node={sampleNode} isOpen={true} onClose={handleClose} />
    );

    const closeBtn = screen.getByTestId('node-drawer-close-btn');
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalled();
  });

  it('triggers onFilterByNode callback when filter button is clicked', () => {
    const handleFilter = vi.fn();
    render(
      <NodeDetailsDrawer
        node={sampleNode}
        isOpen={true}
        onClose={vi.fn()}
        onFilterByNode={handleFilter}
      />
    );

    const filterBtn = screen.getByText(/Filter Swarm by This Node/i);
    fireEvent.click(filterBtn);
    expect(handleFilter).toHaveBeenCalledWith('task_sec_boundary');
  });
});

describe('LiveSwarmTopologyCanvas Component', () => {
  it('renders topology canvas with global telemetry HUD strip', () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    expect(screen.getByTestId('live-swarm-topology-canvas')).toBeDefined();
    expect(screen.getByText(/LIVE SWARM & INFRASTRUCTURE TOPOLOGY/i)).toBeDefined();
    expect(screen.getByText('384 tok/s')).toBeDefined();
    expect(screen.getByText('14.2ms')).toBeDefined();
  });

  it('renders nodes across all 4 architectural tiers by default', () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    expect(screen.getByText('GitHub Dispatcher')).toBeDefined();
    expect(screen.getByText('Edge Orchestrator')).toBeDefined();
    expect(screen.getByText('RepoGate DO')).toBeDefined();
    expect(screen.getByText('R2 Symbol Storage')).toBeDefined();
    expect(screen.getByText('Security Sentinel')).toBeDefined();
    expect(screen.getByText('Claude 3.5 Sonnet')).toBeDefined();
  });

  it('filters nodes when tier filter buttons are clicked', () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    // Click Swarm Agents only filter
    const agentsFilterBtn = screen.getByTestId('filter-tier-agents');
    fireEvent.click(agentsFilterBtn);

    expect(screen.getByText('Security Sentinel')).toBeDefined();
    expect(screen.queryByText('GitHub Dispatcher')).toBeNull();

    // Click Infrastructure only filter
    const infraFilterBtn = screen.getByTestId('filter-tier-infra');
    fireEvent.click(infraFilterBtn);

    expect(screen.getByText('GitHub Dispatcher')).toBeDefined();
    expect(screen.getByText('RepoGate DO')).toBeDefined();
    expect(screen.queryByText('Security Sentinel')).toBeNull();
  });

  it('shows hover inspection card on mouse enter and hides on mouse leave', async () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    const edgeNode = screen.getByTestId('topology-node-cf_edge_orchestrator');
    fireEvent.mouseEnter(edgeNode);

    await waitFor(() => {
      expect(screen.getByTestId('node-hover-card-cf_edge_orchestrator')).toBeDefined();
    });

    fireEvent.mouseLeave(edgeNode);

    await waitFor(() => {
      expect(screen.queryByTestId('node-hover-card-cf_edge_orchestrator')).toBeNull();
    });
  });

  it('opens details drawer when node is clicked', async () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    const r2Node = screen.getByTestId('topology-node-r2_ast_cache');
    fireEvent.click(r2Node);

    await waitFor(() => {
      expect(screen.getByTestId('node-details-drawer')).toBeDefined();
      expect(screen.getByTestId('node-drawer-close-btn')).toBeDefined();
      expect(screen.getByText('Tier 2 Architecture')).toBeDefined();
    });
  });

  it('toggles stream animation on and off', () => {
    render(<LiveSwarmTopologyCanvas jobId="test_pr_1282" />);

    const toggleBtn = screen.getByTestId('toggle-topology-animations-btn');
    expect(screen.getByText('Live Pulse')).toBeDefined();

    fireEvent.click(toggleBtn);
    expect(screen.getByText('Paused')).toBeDefined();

    fireEvent.click(toggleBtn);
    expect(screen.getByText('Live Pulse')).toBeDefined();
  });
});

describe('LiveDashboardView Swarm & Infra Mesh Tab Integration', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/live/diff')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            jobId: 'job-test-123',
            files: [],
            findings: [],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, jobs: [] }),
      });
    });
  });

  it('renders Swarm & Infra Mesh tab trigger and switches view to topology canvas', async () => {
    render(<LiveDashboardView />);

    const meshTab = screen.getByTestId('swarm-mesh-tab-trigger');
    expect(meshTab).toBeDefined();

    fireEvent.pointerDown(meshTab, { button: 0, ctrlKey: false });
    fireEvent.keyDown(meshTab, { key: 'Enter', code: 'Enter' });
    fireEvent.click(meshTab);

    await waitFor(() => {
      expect(screen.getByTestId('live-swarm-topology-canvas')).toBeDefined();
    });
  });

  it('toggles live topology preview from HUD strip button', async () => {
    render(<LiveDashboardView />);

    const previewToggle = screen.getByTestId('toggle-topology-preview-btn');
    expect(screen.getByText('Show Topology Mesh ▾')).toBeDefined();

    fireEvent.click(previewToggle);

    await waitFor(() => {
      expect(screen.getByText('Hide Topology Mesh ▴')).toBeDefined();
      expect(screen.getByTestId('live-swarm-topology-canvas')).toBeDefined();
    });
  });
});
