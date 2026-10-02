'use client';

import React from 'react';
import { Card, Badge, ProgressBar } from '@tremor/react';
import {
  X,
  Server,
  Database,
  Cpu,
  ShieldCheck,
  Zap,
  Activity,
  HardDrive,
  FileCode,
  Layers,
  Sparkles,
  CheckCircle2,
  ExternalLink,
  Terminal,
  Filter,
} from 'lucide-react';
import { TopologyNodeData, TopologyNodeType, TopologyNodeStatus } from './NodeHoverInspectionCard';

interface NodeDetailsDrawerProps {
  node: TopologyNodeData | null;
  isOpen: boolean;
  onClose: () => void;
  onFilterByNode?: (nodeId: string) => void;
}

export function NodeDetailsDrawer({
  node,
  isOpen,
  onClose,
  onFilterByNode,
}: NodeDetailsDrawerProps) {
  if (!isOpen || !node) return null;

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
        return <Zap className="h-5 w-5 text-emerald-400" />;
      case 'stateful_do':
        return <Server className="h-5 w-5 text-violet-400" />;
      case 'storage_r2':
        return <HardDrive className="h-5 w-5 text-cyan-400" />;
      case 'queue':
        return <Layers className="h-5 w-5 text-amber-400" />;
      case 'swarm_agent':
        return <Cpu className="h-5 w-5 text-indigo-400" />;
      case 'llm_provider':
        return <Sparkles className="h-5 w-5 text-pink-400" />;
      case 'arbiter':
        return <ShieldCheck className="h-5 w-5 text-emerald-400" />;
      default:
        return <Activity className="h-5 w-5 text-zinc-400" />;
    }
  };

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-[#07080b]/98 backdrop-blur-2xl border-l border-white/[0.1] shadow-2xl transition-all animate-in slide-in-from-right duration-200"
      data-testid="node-details-drawer"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4 bg-[#0a0b10]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.05] border border-white/[0.08] shadow-inner">
            {getNodeIcon(node.type)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100 font-mono">
                {node.title}
              </h3>
              <Badge size="xs" color={getStatusColor(node.status)} className="font-mono text-[10px]">
                {node.status}
              </Badge>
            </div>
            <p className="text-xs text-zinc-400 font-mono mt-0.5">{node.subtitle}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          data-testid="node-drawer-close-btn"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Body Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5 text-zinc-300">
        {/* Architectural Tier Banner */}
        <div className="rounded-xl border border-white/[0.08] bg-[#0c0d14] p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-500 uppercase tracking-wider text-[10px]">Architectural Tier</span>
            <span className="text-indigo-400 font-medium">Tier {node.tier} Architecture</span>
          </div>
          <p className="text-xs text-zinc-300 leading-relaxed font-sans">
            {node.details || 'Active component in the Review Yeti distributed edge and swarm orchestration pipeline.'}
          </p>
        </div>

        {/* Real-Time Health & SLA */}
        <div className="rounded-xl border border-white/[0.08] bg-[#0c0d14] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-semibold">
              Live System Health & SLA
            </span>
            <span className="text-xs font-mono font-semibold text-emerald-400">
              {node.health.toFixed(1)}% Operational
            </span>
          </div>
          <ProgressBar value={node.health} color="emerald" className="h-2" />
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 pt-1">
            <span>Uptime: 99.99%</span>
            <span>Edge Mesh Node: {node.id}</span>
          </div>
        </div>

        {/* Live Metrics Grid */}
        <div className="space-y-2">
          <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-semibold">
            Telemetry Performance Metrics
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                Latency / Edge RTT
              </span>
              <div className="text-lg font-mono font-bold text-zinc-100 flex items-baseline gap-1">
                <span>{node.latencyMs}</span>
                <span className="text-xs font-normal text-zinc-500">ms</span>
              </div>
            </div>

            <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                Velocity / Throughput
              </span>
              <div className="text-lg font-mono font-bold text-cyan-400 flex items-baseline gap-1">
                <span>
                  {node.metrics.tokensPerSec !== undefined
                    ? `${node.metrics.tokensPerSec} t/s`
                    : node.metrics.throughput || (node.metrics.cacheHitRate !== undefined ? `${node.metrics.cacheHitRate}%` : 'Normal')}
                </span>
              </div>
            </div>

            {node.metrics.cpuMs !== undefined && (
              <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  CPU Execution Time
                </span>
                <div className="text-base font-mono font-semibold text-zinc-200">
                  {node.metrics.cpuMs}ms <span className="text-xs text-zinc-500">/ 50ms</span>
                </div>
              </div>
            )}

            {node.metrics.memoryMb !== undefined && (
              <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  Memory Heap
                </span>
                <div className="text-base font-mono font-semibold text-zinc-200">
                  {node.metrics.memoryMb} MB <span className="text-xs text-zinc-500">/ 128MB</span>
                </div>
              </div>
            )}

            {node.metrics.compactionRatio !== undefined && (
              <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  Context Compaction
                </span>
                <div className="text-base font-mono font-semibold text-cyan-300">
                  {node.metrics.compactionRatio}x Ratio
                </div>
              </div>
            )}

            {node.metrics.turnsCount !== undefined && (
              <div className="rounded-xl bg-[#0c0d14] border border-white/[0.06] p-3 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  Execution Turns
                </span>
                <div className="text-base font-mono font-semibold text-indigo-300">
                  {node.metrics.turnsCount} turns
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Scoped AST Targets */}
        {node.metrics.activeFiles && node.metrics.activeFiles.length > 0 && (
          <div className="rounded-xl border border-white/[0.08] bg-[#0c0d14] p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="uppercase tracking-wider text-zinc-400 font-semibold">
                Scoped File Invariants
              </span>
              <span className="text-zinc-500">{node.metrics.activeFiles.length} file(s)</span>
            </div>
            <div className="space-y-1.5">
              {node.metrics.activeFiles.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 text-xs font-mono text-zinc-200 bg-white/[0.02] px-2.5 py-1.5 rounded-lg border border-white/[0.04]"
                >
                  <FileCode className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{file}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Configuration & Diagnostics Details */}
        <div className="rounded-xl border border-white/[0.08] bg-[#0c0d14] p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="uppercase tracking-wider text-zinc-400 font-semibold">
              Node Metadata & Configuration
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">ID: {node.id}</span>
          </div>
          <div className="space-y-1.5 text-xs font-mono">
            {node.provider && (
              <div className="flex items-center justify-between py-1 border-b border-white/[0.04]">
                <span className="text-zinc-500">Provider</span>
                <span className="text-zinc-200">{node.provider}</span>
              </div>
            )}
            {node.model && (
              <div className="flex items-center justify-between py-1 border-b border-white/[0.04]">
                <span className="text-zinc-500">Model Engine</span>
                <span className="text-zinc-200">{node.model}</span>
              </div>
            )}
            {node.role && (
              <div className="flex items-center justify-between py-1 border-b border-white/[0.04]">
                <span className="text-zinc-500">Specialized Role</span>
                <span className="text-zinc-200">{node.role}</span>
              </div>
            )}
            <div className="flex items-center justify-between py-1">
              <span className="text-zinc-500">Deployment Type</span>
              <span className="text-zinc-200 capitalize">{node.type.replace('_', ' ')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Controls */}
      <div className="border-t border-white/[0.08] p-4 bg-[#0a0b10] flex items-center justify-between gap-3">
        {onFilterByNode ? (
          <button
            type="button"
            onClick={() => {
              onFilterByNode(node.id);
              onClose();
            }}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-mono font-medium transition-all shadow-md shadow-indigo-600/20"
          >
            <Filter className="h-3.5 w-3.5" />
            <span>Filter Swarm by This Node</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-zinc-300 hover:text-white text-xs font-mono transition-colors border border-white/[0.06]"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export default NodeDetailsDrawer;
