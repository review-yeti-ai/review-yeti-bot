'use client';

import * as React from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  Position,
  MarkerType,
  Handle,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ReviewJob, PersonaLogEntry } from '@/types/dashboard';

/* ────────────────────────────────────────────
 * Custom Node Components — with explicit handles
 * ──────────────────────────────────────────── */

function WebhookNode({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="px-5 py-3 rounded-xl border-2 border-indigo-500/60 bg-gradient-to-br from-indigo-950 to-slate-900 shadow-lg shadow-indigo-500/10 min-w-[200px] text-center relative">
      <div className="text-[10px] font-mono uppercase tracking-widest text-indigo-400/80 mb-1">
        GitHub Webhook
      </div>
      <div className="text-sm font-semibold text-white leading-tight">
        {String(data.repo || '')} #{String(data.prNumber || '')}
      </div>
      {data.title ? (
        <div className="text-[11px] text-slate-400 mt-1 max-w-[220px] truncate">
          {String(data.title)}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} style={{ background: '#818cf8', width: 8, height: 8, border: '2px solid #312e81' }} />
    </div>
  );
}

function EngineNode({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="px-5 py-3 rounded-xl border-2 border-violet-500/50 bg-gradient-to-br from-violet-950 to-slate-900 shadow-lg shadow-violet-500/10 min-w-[200px] text-center relative">
      <Handle type="target" position={Position.Top} style={{ background: '#8b5cf6', width: 8, height: 8, border: '2px solid #2e1065' }} />
      <div className="text-[10px] font-mono uppercase tracking-widest text-violet-400/80 mb-1">
        Review Engine
      </div>
      <div className="text-sm font-semibold text-white">
        🧠 Pi.dev Panel Engine
      </div>
      <div className="text-[11px] text-slate-400 mt-1">
        {String(data.personaCount || 0)} persona{Number(data.personaCount) !== 1 ? 's' : ''} dispatched
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#8b5cf6', width: 8, height: 8, border: '2px solid #2e1065' }} />
    </div>
  );
}

function PersonaNode({ data }: { data: Record<string, unknown> }) {
  const decision = String(data.decision || 'SHIP');
  const isNack = decision === 'NACK' || decision === 'FIX_FIRST' || decision === 'BLOCK';
  const borderColor = isNack ? 'border-red-500/60' : 'border-emerald-500/50';
  const bgGradient = isNack
    ? 'from-red-950/80 to-slate-900'
    : 'from-emerald-950/60 to-slate-900';
  const badgeColor = isNack
    ? 'bg-red-500/20 text-red-400 border-red-500/30'
    : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
  const handleColor = isNack ? '#f87171' : '#34d399';

  return (
    <div className={`px-4 py-3 rounded-lg border ${borderColor} bg-gradient-to-br ${bgGradient} shadow-md min-w-[180px] relative`}>
      <Handle type="target" position={Position.Top} style={{ background: handleColor, width: 7, height: 7, border: `2px solid ${isNack ? '#450a0a' : '#052e16'}` }} />
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <span className="text-xs font-semibold text-white truncate max-w-[140px]">
          {String(data.displayName || data.persona || '')}
        </span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${badgeColor}`}>
          {decision}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono">
        <span className="truncate max-w-[100px]">{String(data.model || '')}</span>
        {data.confidence != null ? (
          <span>{Math.round(Number(data.confidence) * 100)}%</span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-1">
        {data.latencyMs != null ? (
          <span>⏱ {Number(data.latencyMs).toLocaleString()}ms</span>
        ) : null}
        {data.turnsCount != null && Number(data.turnsCount) > 0 ? (
          <span>🔄 {String(data.turnsCount)} turns</span>
        ) : null}
        {data.totalTokens != null && Number(data.totalTokens) > 0 ? (
          <span>📊 {Number(data.totalTokens).toLocaleString()} tok</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: handleColor, width: 7, height: 7, border: `2px solid ${isNack ? '#450a0a' : '#052e16'}` }} />
    </div>
  );
}

function ModeratorNode({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="px-5 py-3 rounded-xl border-2 border-amber-500/50 bg-gradient-to-br from-amber-950/60 to-slate-900 shadow-lg shadow-amber-500/10 min-w-[200px] text-center relative">
      <Handle type="target" position={Position.Top} style={{ background: '#f59e0b', width: 8, height: 8, border: '2px solid #451a03' }} />
      <div className="text-[10px] font-mono uppercase tracking-widest text-amber-400/80 mb-1">
        Moderator
      </div>
      <div className="text-sm font-semibold text-white">
        ⚖️ Findings Reconciliation
      </div>
      <div className="text-[11px] text-slate-400 mt-1">
        {String(data.findingsCount || 0)} finding{Number(data.findingsCount) !== 1 ? 's' : ''} reconciled
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#f59e0b', width: 8, height: 8, border: '2px solid #451a03' }} />
    </div>
  );
}

function ArbiterNode({ data }: { data: Record<string, unknown> }) {
  const verdict = String(data.verdict || 'SHIP');
  const isShip = verdict === 'SHIP';
  const borderColor = isShip ? 'border-emerald-500/60' : 'border-red-500/60';
  const bgGradient = isShip
    ? 'from-emerald-950/80 to-slate-900'
    : 'from-red-950/80 to-slate-900';
  const badgeColor = isShip
    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
    : 'bg-red-500/20 text-red-400 border-red-500/30';
  const glowColor = isShip ? 'shadow-emerald-500/20' : 'shadow-red-500/20';

  return (
    <div className={`px-5 py-4 rounded-xl border-2 ${borderColor} bg-gradient-to-br ${bgGradient} shadow-lg ${glowColor} min-w-[220px] text-center relative`}>
      <Handle type="target" position={Position.Top} style={{ background: isShip ? '#34d399' : '#f87171', width: 8, height: 8, border: `2px solid ${isShip ? '#052e16' : '#450a0a'}` }} />
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">
        Final Verdict
      </div>
      <div className="flex items-center justify-center gap-2">
        <span className="text-lg">{isShip ? '✅' : '🚫'}</span>
        <span className={`text-base font-bold px-3 py-1 rounded-lg border ${badgeColor}`}>
          {verdict}
        </span>
      </div>
      {data.rationale ? (
        <div className="text-[11px] text-slate-400 mt-2 max-w-[240px] leading-relaxed">
          {String(data.rationale).slice(0, 100)}{String(data.rationale).length > 100 ? '…' : ''}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  webhook: WebhookNode,
  engine: EngineNode,
  persona: PersonaNode,
  moderator: ModeratorNode,
  arbiter: ArbiterNode,
};

/* ────────────────────────────────────────────
 * Layout Builder — clean top-to-bottom flow
 * ──────────────────────────────────────────── */

/** Shared edge defaults for clean directed flows */
const EDGE_DEFAULTS = {
  type: 'smoothstep' as const,
  pathOptions: { borderRadius: 16 },
};

function buildFlowData(
  job: ReviewJob,
  personaLogs: PersonaLogEntry[],
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const COL_WIDTH = 230;
  const ROW_GAP = 100;
  const PERSONA_ROW_Y = 240;
  const PERSONA_NODE_H = 100;

  const personaCount = Math.max(personaLogs.length, 1);
  const totalPersonaWidth = personaCount * COL_WIDTH;
  const centerX = totalPersonaWidth / 2;
  const NODE_W_HALF = 110; // approx half the width of the centered nodes

  // ── Row 0: Webhook ──
  nodes.push({
    id: 'webhook',
    type: 'webhook',
    position: { x: centerX - NODE_W_HALF, y: 0 },
    data: { repo: job.repo, prNumber: job.prNumber, title: job.title },
  });

  // ── Row 1: Engine ──
  nodes.push({
    id: 'engine',
    type: 'engine',
    position: { x: centerX - NODE_W_HALF, y: ROW_GAP },
    data: { personaCount: personaLogs.length },
  });

  // Webhook → Engine
  edges.push({
    ...EDGE_DEFAULTS,
    id: 'e-webhook-engine',
    source: 'webhook',
    target: 'engine',
    animated: true,
    label: 'PR event',
    labelStyle: { fill: '#818cf8', fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#0f0d2e', fillOpacity: 0.9 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    style: { stroke: '#818cf8', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8', width: 16, height: 16 },
  });

  // ── Row 2: Persona lanes ──
  if (personaLogs.length > 0) {
    personaLogs.forEach((log, idx) => {
      const nodeId = `persona-${idx}`;
      const x = idx * COL_WIDTH + (COL_WIDTH - 180) / 2;

      nodes.push({
        id: nodeId,
        type: 'persona',
        position: { x, y: PERSONA_ROW_Y },
        data: {
          persona: log.persona,
          displayName: log.displayName || log.persona,
          model: log.model || 'unknown',
          decision: log.decision,
          confidence: log.confidence,
          latencyMs: log.latencyMs,
          turnsCount: log.turnsCount,
          totalTokens: log.totalTokens,
        },
      });

      // Engine → Persona (fan-out)
      edges.push({
        ...EDGE_DEFAULTS,
        id: `e-engine-${nodeId}`,
        source: 'engine',
        target: nodeId,
        animated: false,
        label: idx === 0 ? 'dispatch' : undefined,
        labelStyle: { fill: '#a5b4fc', fontSize: 9, fontWeight: 500 },
        labelBgStyle: { fill: '#0f0d2e', fillOpacity: 0.9 },
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 4,
        style: { stroke: '#6366f1', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 14, height: 14 },
      });
    });
  } else {
    nodes.push({
      id: 'persona-disabled',
      type: 'persona',
      position: { x: centerX - 90, y: PERSONA_ROW_Y },
      data: {
        displayName: 'All Personas Disabled',
        model: '—',
        decision: 'SHIP',
        confidence: 1,
      },
    });
    edges.push({
      ...EDGE_DEFAULTS,
      id: 'e-engine-disabled',
      source: 'engine',
      target: 'persona-disabled',
      animated: false,
      style: { stroke: '#475569', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#475569', width: 14, height: 14 },
    });
  }

  // ── Row 3: Moderator ──
  const moderatorY = PERSONA_ROW_Y + PERSONA_NODE_H + ROW_GAP;
  const totalFindings = personaLogs.reduce((acc, l) => acc + (l.findingsCount || (l.nits?.length) || 0), 0);

  nodes.push({
    id: 'moderator',
    type: 'moderator',
    position: { x: centerX - NODE_W_HALF, y: moderatorY },
    data: { findingsCount: totalFindings },
  });

  // Persona → Moderator (fan-in)
  if (personaLogs.length > 0) {
    personaLogs.forEach((log, idx) => {
      const findings = log.findingsCount || log.nits?.length || 0;
      edges.push({
        ...EDGE_DEFAULTS,
        id: `e-persona-${idx}-moderator`,
        source: `persona-${idx}`,
        target: 'moderator',
        animated: false,
        label: idx === 0 ? `findings` : undefined,
        labelStyle: { fill: '#fbbf24', fontSize: 9, fontWeight: 500 },
        labelBgStyle: { fill: '#1c1108', fillOpacity: 0.9 },
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 4,
        style: {
          stroke: findings > 0 ? '#f59e0b' : '#6b7280',
          strokeWidth: findings > 0 ? 2 : 1.5,
          strokeDasharray: findings === 0 ? '5 3' : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: findings > 0 ? '#f59e0b' : '#6b7280', width: 14, height: 14 },
      });
    });
  } else {
    edges.push({
      ...EDGE_DEFAULTS,
      id: 'e-disabled-moderator',
      source: 'persona-disabled',
      target: 'moderator',
      animated: false,
      style: { stroke: '#475569', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#475569', width: 14, height: 14 },
    });
  }

  // ── Row 4: Arbiter ──
  const arbiterY = moderatorY + ROW_GAP;
  const isShip = (job.verdict || 'SHIP') === 'SHIP';

  nodes.push({
    id: 'arbiter',
    type: 'arbiter',
    position: { x: centerX - NODE_W_HALF - 10, y: arbiterY },
    data: {
      verdict: job.verdict || 'SHIP',
      rationale: personaLogs.length === 0
        ? 'All reviewer personas disabled in repository settings.'
        : undefined,
    },
  });

  // Moderator → Arbiter
  edges.push({
    ...EDGE_DEFAULTS,
    id: 'e-moderator-arbiter',
    source: 'moderator',
    target: 'arbiter',
    animated: true,
    label: isShip ? '✓ verdict' : '✗ verdict',
    labelStyle: { fill: isShip ? '#34d399' : '#f87171', fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: isShip ? '#052e16' : '#1c0404', fillOpacity: 0.9 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    style: {
      stroke: isShip ? '#34d399' : '#f87171',
      strokeWidth: 2.5,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: isShip ? '#34d399' : '#f87171',
      width: 18,
      height: 18,
    },
  });

  return { nodes, edges };
}

/* ────────────────────────────────────────────
 * Main Component
 * ──────────────────────────────────────────── */

interface PipelineFlowViewerProps {
  job: ReviewJob;
  personaLogs: PersonaLogEntry[];
}

export function PipelineFlowViewer({ job, personaLogs }: PipelineFlowViewerProps) {
  const { nodes, edges } = React.useMemo(
    () => buildFlowData(job, personaLogs),
    [job, personaLogs],
  );

  const personaCount = personaLogs.length || 1;
  const containerHeight = Math.max(560, 480 + (personaCount > 4 ? 60 : 0));

  return (
    <div
      className="rounded-lg border border-border bg-card/60 overflow-hidden"
      style={{ height: containerHeight }}
      data-testid="pipeline-flow-viewer"
    >
      <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border text-xs">
        <div className="flex items-center gap-2 font-mono font-medium text-muted-foreground">
          <span>Agent Pipeline Workflow</span>
        </div>
        <span className="text-[10px] bg-violet-500/10 text-violet-400 px-2 py-0.5 rounded border border-violet-500/20">
          Interactive Flow Diagram
        </span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, minZoom: 0.4, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={true}
        minZoom={0.3}
        maxZoom={1.5}
        style={{ background: 'transparent' }}
      >
        <Background
          color="#1e1b4b"
          gap={24}
          size={1}
          style={{ opacity: 0.3 }}
        />
        <Controls
          showInteractive={false}
          className="!bg-slate-900/80 !border-border !shadow-lg"
        />
      </ReactFlow>
    </div>
  );
}
