'use client';

import React from 'react';
import { Card, Badge, ProgressBar } from '@tremor/react';
import {
  Server,
  Database,
  Cpu,
  ShieldCheck,
  Zap,
  Activity,
  HardDrive,
  FileCode,
  Radio,
  Layers,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';

export type TopologyNodeType =
  | 'edge_ingress'
  | 'stateful_do'
  | 'storage_r2'
  | 'queue'
  | 'swarm_agent'
  | 'llm_provider'
  | 'arbiter';

export type TopologyNodeStatus =
  | 'HEALTHY'
  | 'IN_FLIGHT'
  | 'PENDING'
  | 'CACHED'
  | 'STANDBY'
  | 'DEGRADED';

export interface TopologyNodeData {
  id: string;
  title: string;
  subtitle: string;
  type: TopologyNodeType;
  tier: 1 | 2 | 3 | 4;
  status: TopologyNodeStatus;
  health: number;
  latencyMs: number;
  metrics: {
    cpuMs?: number;
    memoryMb?: number;
    tokensPerSec?: number;
    throughput?: string;
    cacheHitRate?: number;
    promptTokens?: number;
    completionTokens?: number;
    compactionRatio?: number;
    turnsCount?: number;
    activeFiles?: string[];
    astNodes?: number;
    errorRate?: number;
    totalRequests?: number;
  };
  provider?: string;
  model?: string;
  role?: string;
  details?: string;
}

interface NodeHoverInspectionCardProps {
  node: TopologyNodeData;
  position?: { x: number; y: number };
  onInspectNode?: (nodeId: string) => void;
  className?: string;
}

export function NodeHoverInspectionCard({
  node,
  position,
  onInspectNode,
  className = '',
}: NodeHoverInspectionCardProps) {
  const getStatusColor = (status: TopologyNodeStatus) => {
    switch (status) {
      case 'HEALTHY':
        return 'emerald';
      case 'IN_FLIGHT':
        return 'indigo';
      case 'CACHED':
        return 'cyan';
      case 'PENDING':
      case 'STANDBY':
        return 'amber';
      case 'DEGRADED':
        return 'rose';
      default:
        return 'slate';
    }
  };

  const getNodeIcon = (type: TopologyNodeType) => {
    switch (type) {
      case 'edge_ingress':
        return <Zap className="h-4 w-4 text-emerald-400" />;
      case 'stateful_do':
        return <Server className="h-4 w-4 text-violet-400" />;
      case 'storage_r2':
        return <HardDrive className="h-4 w-4 text-cyan-400" />;
      case 'queue':
        return <Layers className="h-4 w-4 text-amber-400" />;
      case 'swarm_agent':
        return <Cpu className="h-4 w-4 text-indigo-400" />;
      case 'llm_provider':
        return <Sparkles className="h-4 w-4 text-pink-400" />;
      case 'arbiter':
        return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
      default:
        return <Activity className="h-4 w-4 text-zinc-400" />;
    }
  };

  const stylePosition = position
    ? {
        left: `${position.x}px`,
        top: `${position.y}px`,
      }
    : undefined;

  return (
    <div
      style={stylePosition}
      className={`z-50 w-80 rounded-xl bg-[#090a0f]/95 backdrop-blur-xl border border-white/[0.12] p-4 text-zinc-100 shadow-2xl ring-1 ring-white/[0.05] transition-all animate-in fade-in zoom-in-95 duration-150 ${className}`}
      data-testid={`node-hover-card-${node.id}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] border border-white/[0.1] shadow-inner">
            {getNodeIcon(node.type)}
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-100 font-mono flex items-center gap-1.5">
              {node.title}
            </h4>
            <p className="text-[11px] text-zinc-400 font-mono truncate max-w-[160px]">
              {node.subtitle}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge size="xs" color={getStatusColor(node.status)} className="font-mono text-[10px] px-1.5 py-0.5">
            {node.status}
          </Badge>
          <span className="text-[10px] font-mono text-zinc-500">
            {node.health.toFixed(1)}% SLA
          </span>
        </div>
      </div>

      {/* Description / Role */}
      {node.details && (
        <p className="mt-2.5 text-[11px] text-zinc-300 leading-relaxed font-sans">
          {node.details}
        </p>
      )}

      {/* Live Telemetry Matrix */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Latency / RTT</span>
          <div className="mt-0.5 flex items-baseline gap-1 text-zinc-200 font-semibold">
            <span>{node.latencyMs}</span>
            <span className="text-[10px] text-zinc-500">ms</span>
          </div>
        </div>

        {node.metrics.tokensPerSec !== undefined ? (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Velocity</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-cyan-400 font-semibold">
              <span>{node.metrics.tokensPerSec}</span>
              <span className="text-[10px] text-zinc-500">tok/s</span>
            </div>
          </div>
        ) : node.metrics.throughput ? (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Throughput</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-emerald-400 font-semibold">
              <span>{node.metrics.throughput}</span>
            </div>
          </div>
        ) : node.metrics.cacheHitRate !== undefined ? (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Cache Hit Rate</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-emerald-400 font-semibold">
              <span>{node.metrics.cacheHitRate}%</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Health Score</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-emerald-400 font-semibold">
              <span>100%</span>
            </div>
          </div>
        )}

        {node.metrics.cpuMs !== undefined && (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">CPU Budget</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-zinc-200">
              <span className="font-semibold text-zinc-100">{node.metrics.cpuMs}</span>
              <span className="text-[10px] text-zinc-500">/ 50ms</span>
            </div>
          </div>
        )}

        {node.metrics.memoryMb !== undefined && (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Heap Memory</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-zinc-200">
              <span className="font-semibold text-zinc-100">{node.metrics.memoryMb}</span>
              <span className="text-[10px] text-zinc-500">MB</span>
            </div>
          </div>
        )}

        {node.metrics.compactionRatio !== undefined && (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Compaction</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-cyan-300 font-semibold">
              <span>{node.metrics.compactionRatio}x</span>
            </div>
          </div>
        )}

        {node.metrics.turnsCount !== undefined && (
          <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Turns Executed</span>
            <div className="mt-0.5 flex items-baseline gap-1 text-indigo-300 font-semibold">
              <span>{node.metrics.turnsCount}</span>
              <span className="text-[10px] text-zinc-500">turns</span>
            </div>
          </div>
        )}
      </div>

      {/* Scope / Assigned Files */}
      {node.metrics.activeFiles && node.metrics.activeFiles.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
            <span>Scoped AST Target</span>
            <span>{node.metrics.activeFiles.length} file(s)</span>
          </div>
          <div className="space-y-1">
            {node.metrics.activeFiles.map((file, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-300 bg-white/[0.03] px-2 py-0.5 rounded border border-white/[0.04] truncate"
              >
                <FileCode className="h-3 w-3 text-emerald-400 shrink-0" />
                <span className="truncate">{file}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action / Inspect Footer */}
      {onInspectNode && (
        <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-[10px] font-mono text-zinc-500">Click to pin details</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInspectNode(node.id);
            }}
            className="inline-flex items-center gap-1 text-[11px] font-mono font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <span>Inspect Node</span>
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

export default NodeHoverInspectionCard;
