'use client';

import * as React from 'react';
import { PersonaSetting } from '@/types/dashboard';
import { Badge } from '@/components/ui/badge';
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
  personas?: Record<string, PersonaSetting>;
}

export function PersonaSelector({ selectedPersonaId, onSelectPersona, onSelect, personas }: PersonaSelectorProps) {
  const handleSelect = onSelectPersona || onSelect || (() => {});
  return (
    <div className="space-y-4">
      {/* Dropdown for mobile or quick select */}
      <div className="md:hidden">
        <Select value={selectedPersonaId} onValueChange={handleSelect}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select persona..." />
          </SelectTrigger>
          <SelectContent>
            {ALL_PERSONA_IDS.map((id) => {
              const meta = PERSONA_METADATA[id];
              const pData = personas?.[id];
              const isEnabled = pData ? pData.enabled : true;
              return (
                <SelectItem key={id} value={id}>
                  <div className="flex items-center justify-between w-full gap-2">
                    <span>{pData?.displayName || meta.name}</span>
                    {!isEnabled && <Badge variant="outline" className="text-[10px]">Disabled</Badge>}
                  </div>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Grid of persona pill cards for desktop */}
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {ALL_PERSONA_IDS.map((id) => {
          const meta = PERSONA_METADATA[id];
          const Icon = meta.icon;
          const pData = personas?.[id];
          const isSelected = selectedPersonaId === id;
          const isEnabled = pData ? pData.enabled : true;
          const isRequired = pData?.required;

          return (
            <button
              key={id}
              type="button"
              onClick={() => handleSelect(id)}
              className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                isSelected
                  ? 'border-indigo-500/80 bg-indigo-500/10 shadow-sm'
                  : 'border-border/60 bg-card/40 hover:bg-card hover:border-border'
              } ${!isEnabled ? 'opacity-50' : ''}`}
            >
              <div className={`p-2 rounded-md bg-background/80 ${meta.color}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold truncate text-foreground">
                    {pData?.displayName || meta.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <Badge variant={isEnabled ? 'success' : 'secondary'} className="text-[10px] py-0 px-1">
                    {isEnabled ? 'Active' : 'Disabled'}
                  </Badge>
                  {isRequired && (
                    <Badge variant="outline" className="text-[10px] py-0 px-1 border-indigo-400/40 text-indigo-300">
                      Required
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
