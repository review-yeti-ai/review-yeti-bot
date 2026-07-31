'use client';

import * as React from 'react';
import { PersonaSetting } from '@/types/dashboard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ShieldCheck,
  Building2,
  Zap,
  CheckCircle2,
  Database,
  Plug,
  Flame,
  Container,
  FileText,
  Coins,
  Target,
  Workflow,
  Settings2,
  Cpu,
  Gauge,
  Sliders,
  RotateCw,
} from 'lucide-react';

export const ALL_PERSONA_IDS = [
  'security',
  'architecture',
  'performance',
  'quality',
  'database',
  'api_contract',
  'reliability',
  'devops',
  'docs_compliance',
  'finops',
  'red_team',
  'review_flowchart',
] as const;

export type PersonaId = (typeof ALL_PERSONA_IDS)[number];

export const PERSONA_METADATA: Record<
  PersonaId,
  { name: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  security: { name: '🛡️ Security & Tenancy Guardian', icon: ShieldCheck, color: 'text-red-400' },
  architecture: { name: '🏛️ System Architecture & Design', icon: Building2, color: 'text-indigo-400' },
  performance: { name: '⚡ Performance & Scalability', icon: Zap, color: 'text-amber-400' },
  quality: { name: '✨ Code Quality & Style', icon: CheckCircle2, color: 'text-emerald-400' },
  database: { name: '🗄️ Database & Persistence', icon: Database, color: 'text-blue-400' },
  api_contract: { name: '🔌 API Contract & Integration', icon: Plug, color: 'text-purple-400' },
  reliability: { name: '💥 Reliability & Resilience (SRE)', icon: Flame, color: 'text-orange-400' },
  devops: { name: '🐳 DevOps & Containers', icon: Container, color: 'text-cyan-400' },
  docs_compliance: { name: '📝 Documentation & Compliance', icon: FileText, color: 'text-teal-400' },
  finops: { name: '💰 FinOps & Token Budget', icon: Coins, color: 'text-yellow-400' },
  red_team: { name: '🎯 Red Team & Skeptic', icon: Target, color: 'text-rose-400' },
  review_flowchart: { name: '📊 Review Flowchart & Architecture', icon: Workflow, color: 'text-sky-400' },
};

interface PersonaSelectorProps {
  selectedPersonaId: string;
  onSelectPersona?: (id: string) => void;
  onSelect?: (id: string) => void;
  onConfigurePersona?: (id: string) => void;
  onToggleActive?: (id: string, active: boolean) => void;
  personas?: Record<string, PersonaSetting>;
}

export function PersonaSelector({
  selectedPersonaId,
  onSelectPersona,
  onSelect,
  onConfigurePersona,
  onToggleActive,
  personas,
}: PersonaSelectorProps) {
  const handleSelect = (id: string) => {
    if (onSelectPersona) onSelectPersona(id);
    if (onSelect) onSelect(id);
  };

  const handleConfigure = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    handleSelect(id);
    if (onConfigurePersona) onConfigurePersona(id);
  };

  const getEffortVariant = (effort?: string) => {
    switch (effort) {
      case 'high':
      case 'xhigh':
      case 'max':
        return 'destructive';
      case 'medium':
        return 'secondary';
      case 'low':
      default:
        return 'outline';
    }
  };

  return (
    <div className="space-y-4">
      {/* Mobile Select Dropdown */}
      <div className="md:hidden">
        <Select value={selectedPersonaId} onValueChange={handleSelect}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select persona..." />
          </SelectTrigger>
          <SelectContent>
            {ALL_PERSONA_IDS.map((id) => {
              const meta = PERSONA_METADATA[id];
              const pData = personas?.[id];
              const isEnabled = pData ? pData.enabled !== false : true;
              return (
                <SelectItem key={id} value={id}>
                  <div className="flex items-center justify-between w-full gap-2">
                    <span>{pData?.displayName || meta.name}</span>
                    {!isEnabled && (
                      <Badge variant="outline" className="text-[10px]">
                        Disabled
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Grid of Interactive Persona Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {ALL_PERSONA_IDS.map((id) => {
          const meta = PERSONA_METADATA[id];
          const Icon = meta.icon;
          const pData = personas?.[id];
          const isSelected = selectedPersonaId === id;
          const isEnabled = pData ? pData.enabled !== false : true;
          const isRequired = pData?.required;
          const modelName = pData?.model || 'claude-haiku-4.5';
          const effortLevel = pData?.effort || 'low';
          const maxTurns = pData?.maxTurns ?? 20;
          const confidence = pData?.confidenceThreshold ?? 80;
          const promptPreview =
            pData?.customPrompt ||
            pData?.systemPrompt ||
            pData?.charter ||
            `builtin:${id}`;

          return (
            <div
              key={id}
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(id);
                }
              }}
              aria-label={pData?.displayName || meta.name}
              className={`group relative flex flex-col justify-between p-4 rounded-xl border text-left transition-all duration-200 cursor-pointer shadow-sm ${
                isSelected
                  ? 'border-indigo-500/90 bg-indigo-500/10 ring-1 ring-indigo-500/40 shadow-indigo-500/5'
                  : 'border-border/70 bg-card/60 hover:bg-card hover:border-border hover:shadow-md'
              } ${!isEnabled ? 'opacity-70 bg-card/30' : ''}`}
            >
              {/* Card Top Row: Icon, Title, and Active Switch */}
              <div className="flex items-start justify-between gap-3 w-full">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2.5 rounded-lg bg-background/90 border border-border/40 ${meta.color} shrink-0`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold tracking-tight text-foreground line-clamp-1">
                      {pData?.displayName || meta.name}
                    </h4>
                    <span className="text-[11px] font-mono text-muted-foreground block">ID: {id}</span>
                  </div>
                </div>

                {/* Fast Toggle Switch on Card */}
                <div
                  className="flex items-center gap-1.5 shrink-0 pt-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Switch
                    id={`switch-${id}`}
                    checked={isEnabled}
                    onCheckedChange={(checked) => {
                      if (onToggleActive) {
                        onToggleActive(id, checked);
                      }
                    }}
                    aria-label={`Toggle active state for ${pData?.displayName || meta.name}`}
                  />
                </div>
              </div>

              {/* Status Badges Row */}
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                <Badge variant={isEnabled ? 'success' : 'secondary'} className="text-[10px] py-0.5 px-2">
                  {isEnabled ? 'Active' : 'Disabled'}
                </Badge>
                {isRequired ? (
                  <Badge variant="outline" className="text-[10px] py-0.5 px-2 border-indigo-400/40 text-indigo-300">
                    Required
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] py-0.5 px-2 text-muted-foreground">
                    Optional
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px] py-0.5 px-2 font-mono border-border/80 text-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3 text-indigo-400" />
                  {modelName}
                </Badge>
                <Badge variant={getEffortVariant(effortLevel)} className="text-[10px] py-0.5 px-2 capitalize flex items-center gap-1">
                  <Gauge className="h-3 w-3" />
                  {effortLevel}
                </Badge>
                <Badge variant="outline" className="text-[10px] py-0.5 px-2 font-mono border-border/80 text-foreground flex items-center gap-1">
                  <RotateCw className="h-3 w-3 text-indigo-400" />
                  {maxTurns} Turns
                </Badge>
              </div>

              {/* Confidence Threshold & Preview */}
              <div className="mt-3 space-y-2 w-full">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 font-medium text-foreground">
                    <Sliders className="h-3 w-3 text-purple-400" /> Confidence Threshold:
                  </span>
                  <span className="font-mono font-bold text-indigo-300">{confidence}%</span>
                </div>
                <div className="w-full bg-muted/60 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-indigo-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, confidence))}%` }}
                  />
                </div>

                {/* 2-line Preview Snippet of Prompt */}
                <p className="text-[11px] font-mono text-muted-foreground bg-background/60 p-2 rounded-md border border-border/40 line-clamp-2 leading-relaxed">
                  {promptPreview}
                </p>
              </div>

              {/* Configure Button Action */}
              <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-end w-full">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(e) => handleConfigure(id, e)}
                  className="w-full text-xs font-semibold gap-1.5 border-indigo-500/30 hover:border-indigo-500/70 hover:bg-indigo-500/10 text-indigo-200"
                >
                  <Settings2 className="h-3.5 w-3.5 text-indigo-400" />
                  Configure Persona &amp; Prompt
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
