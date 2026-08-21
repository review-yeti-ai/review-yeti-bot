'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, Sparkles, Shield, Cpu, Sliders, CheckCircle2, HelpCircle } from 'lucide-react';
import { PersonaSetting, ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import {
  isModelEnabled,
  getEnabledModelOptions,
  getProviderIdForModel,
  getFallbackModelForPersona,
} from '@/lib/model-filtering';
import { AlertTriangle } from 'lucide-react';

export const PERSONA_ENSEMBLE_DEFINITIONS = [
  { id: 'security', name: '🛡️ Security & Tenancy Guardian', defaultModel: 'synthetic/hf:zai-org/GLM-5.2', provider: 'synthetic' },
  { id: 'architecture', name: '🏛️ System Architecture & Design', defaultModel: 'synthetic/hf:openai/gpt-oss-120b', provider: 'synthetic' },
  { id: 'performance', name: '⚡ Performance & Scalability', defaultModel: 'synthetic/hf:zai-org/GLM-4.7-Flash', provider: 'synthetic' },
  { id: 'quality', name: '✨ Code Quality & Style', defaultModel: 'synthetic/hf:Qwen/Qwen3.6-27B', provider: 'synthetic' },
  { id: 'database', name: '🗄️ Database & Persistence', defaultModel: 'synthetic/hf:zai-org/GLM-4.7-Flash', provider: 'synthetic' },
  { id: 'api_contract', name: '🔌 API Contract & Integration', defaultModel: 'synthetic/hf:Qwen/Qwen3.6-27B', provider: 'synthetic' },
  { id: 'documentation', name: '📝 Documentation & Compliance', defaultModel: 'synthetic/hf:zai-org/GLM-4.7-Flash', provider: 'synthetic' },
  { id: 'linear_sync', name: '📌 Linear Sync & Issue Tracking', defaultModel: 'synthetic/hf:zai-org/GLM-4.7-Flash', provider: 'synthetic' },
  { id: 'ux_product', name: '🎨 UX & Product Consistency', defaultModel: 'synthetic/hf:Qwen/Qwen3.6-27B', provider: 'synthetic' },
  { id: 'devops', name: '🐳 DevOps & Containers', defaultModel: 'synthetic/hf:zai-org/GLM-4.7-Flash', provider: 'synthetic' },
  { id: 'reliability', name: '💥 Reliability & Resilience', defaultModel: 'synthetic/hf:zai-org/GLM-5.2', provider: 'synthetic' },
];

export const AVAILABLE_MODEL_OPTIONS = [
  { label: 'DeepSeek V4 Flash High (Fast Reasoning)', value: 'deepseek/deepseek-v4-flash-0731:high' },
  { label: 'OpenRouter 5.6 Luna High (Top Precision)', value: 'openrouter/5.6-luna-high' },
  { label: 'Gemini 3.7 Flash High (1M Context)', value: 'google/gemini-3.7-flash:high' },
  { label: 'Qwen 3.8 27B High', value: 'qwen/qwen-3.8-27b:high' },
  { label: 'Claude 3.7 Sonnet (Hybrid Reasoning)', value: 'openrouter/anthropic/claude-3.7-sonnet' },
  { label: 'Claude 5 Sonnet (Direct)', value: 'claude-5-sonnet' },
  { label: 'Claude Opus 4.8 (Direct)', value: 'claude-opus-4-8' },
  { label: 'OpenAI GPT-5.6 Luna', value: 'openai/gpt-5.6-luna' },
  { label: 'Codex GPT-5.6 Sol High (Codex)', value: 'codex/gpt-5.6-sol-high' },
  { label: 'OpenRouter Auto Router', value: 'openrouter/auto' },
  { label: 'Synthetic GLM 5.2 (Zai Org)', value: 'synthetic/hf:zai-org/GLM-5.2' },
  { label: 'Synthetic Qwen 3.6 27B (Qwen)', value: 'synthetic/hf:Qwen/Qwen3.6-27B' },
  { label: 'Grok 4.5 (xAI)', value: 'grok-cli/grok-4.5' },
  { label: 'GLM 5.2 (Synthetic Arbiter)', value: 'glm-5.2' },
  { label: 'AGY Opus Thinking (AGY)', value: 'agy/claude-opus-4-6-thinking' },
];

interface Step4PersonaEnsembleProps {
  personas: Record<string, PersonaSetting>;
  providers?: Record<string, ProviderConfigRecord>;
  modelRegistry?: Record<string, ModelRegistryItem>;
  onUpdatePersona: (personaId: string, patch: Partial<PersonaSetting>) => void;
}

export function Step4PersonaEnsemble({
  personas,
  providers,
  modelRegistry,
  onUpdatePersona,
}: Step4PersonaEnsembleProps) {
  const activeCount = PERSONA_ENSEMBLE_DEFINITIONS.filter(
    (def) => (personas[def.id] ? personas[def.id].enabled !== false : true)
  ).length;

  const filteredModelOptions = React.useMemo(() => {
    return getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, providers, modelRegistry);
  }, [providers, modelRegistry]);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Users className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Step 4: Persona Ensemble Assignment</h3>
            <p className="text-xs text-muted-foreground">
              Map models, reasoning effort levels, and confidence thresholds for all 11 expert reviewer personas.
            </p>
          </div>
        </div>

        <Badge variant="outline" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30 gap-1.5 text-xs">
          <Sparkles className="h-3.5 w-3.5" />
          {activeCount} / 11 Personas Active
        </Badge>
      </div>

      {filteredModelOptions.length === 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-center gap-3 text-amber-300 text-sm font-medium">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
          <span>No active providers or models are enabled. Please enable at least one provider in Step 3 to assign persona models.</span>
        </div>
      )}

      {/* Grid of 11 Personas */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PERSONA_ENSEMBLE_DEFINITIONS.map((def) => {
          const persona = personas[def.id] || {
            id: def.id,
            displayName: def.name,
            model: def.defaultModel,
            effort: 'low',
            confidenceThreshold: 75,
            enabled: true,
          };

          const isEnabled = persona.enabled !== false;
          const assignedModel = persona.model || def.defaultModel;
          const isAssignedModelEnabled = isModelEnabled(assignedModel, providers, modelRegistry);
          const effectiveModel = getFallbackModelForPersona(assignedModel, filteredModelOptions, def.defaultModel);
          const assignedProviderId = getProviderIdForModel(assignedModel, modelRegistry);

          return (
            <Card
              key={def.id}
              className={`border-border/60 transition-all duration-200 ${
                isEnabled ? 'bg-card/70 border-indigo-500/20' : 'bg-card/20 opacity-70'
              }`}
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{def.name}</span>
                  </div>

                  <Button
                    variant={isEnabled ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => onUpdatePersona(def.id, { enabled: !isEnabled })}
                    className={`h-6 text-[11px] font-semibold px-2 ${
                      isEnabled
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {isEnabled ? 'Enabled' : 'Disabled'}
                  </Button>
                </div>

                {/* Controls: Model Dropdown & Reasoning Effort */}
                <TooltipProvider>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                        Assigned AI Model
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            AI engine dedicated to executing review passes for this persona.
                          </TooltipContent>
                        </Tooltip>
                      </label>
                      <Select
                        value={effectiveModel}
                        onValueChange={(val) => onUpdatePersona(def.id, { model: val })}
                      >
                        <SelectTrigger className="h-8 text-xs bg-background/80">
                          <SelectValue placeholder="Select Model" />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredModelOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!isAssignedModelEnabled && (
                        <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1 font-semibold">
                          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                          Provider ({assignedProviderId}) disabled
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                        Reasoning Effort Level
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Depth of multi-pass reasoning tokens allocated (low, medium, high, max).
                          </TooltipContent>
                        </Tooltip>
                      </label>
                      <Select
                        value={persona.effort || 'low'}
                        onValueChange={(val: any) => onUpdatePersona(def.id, { effort: val })}
                      >
                        <SelectTrigger className="h-8 text-xs bg-background/80">
                          <SelectValue placeholder="Effort" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="xhigh">Extra High</SelectItem>
                          <SelectItem value="max">Max</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Confidence Threshold */}
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-border/40">
                    <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                      Confidence Threshold:
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          Minimum confidence score (%) required before publishing comments to PRs.
                        </TooltipContent>
                      </Tooltip>
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="50"
                        max="95"
                        step="5"
                        value={persona.confidenceThreshold || 75}
                        onChange={(e) =>
                          onUpdatePersona(def.id, { confidenceThreshold: Number(e.target.value) })
                        }
                        className="w-24 accent-indigo-500 cursor-pointer"
                      />
                      <Badge variant="outline" className="text-[11px] font-mono bg-muted/30">
                        {persona.confidenceThreshold || 75}%
                      </Badge>
                    </div>
                  </div>
                </TooltipProvider>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
