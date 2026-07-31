'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PromptEditor } from '@/components/settings/prompt-editor';
import { PromptTestModal } from '@/components/settings/prompt-test-modal';
import { PERSONA_METADATA } from '@/components/settings/persona-selector';
import { PersonaSetting, ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';
import { ShieldCheck, Sliders, Cpu, Gauge, Save, X, Sparkles, RotateCw } from 'lucide-react';

interface PersonaConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  persona: PersonaSetting;
  activePrompt: string;
  savedPrompt: string;
  onPromptChange: (prompt: string) => void;
  onUpdatePersonaField: (patch: Partial<PersonaSetting>) => void;
  onSavePersona: () => Promise<void>;
  onSaveAll: () => Promise<void>;
  onResetDefaults: () => void;
  isSaving: boolean;
  enabledProviderList: ProviderConfigRecord[];
  dynamicModels: string[];
  allAvailableModels: string[];
  modelRegistry: Record<string, ModelRegistryItem>;
}

export function PersonaConfigDrawer({
  open,
  onOpenChange,
  persona,
  activePrompt,
  savedPrompt,
  onPromptChange,
  onUpdatePersonaField,
  onSavePersona,
  onSaveAll,
  onResetDefaults,
  isSaving,
  enabledProviderList,
  dynamicModels,
  allAvailableModels,
  modelRegistry,
}: PersonaConfigDrawerProps) {
  const meta = PERSONA_METADATA[persona.id as keyof typeof PERSONA_METADATA] || {
    name: persona.displayName || persona.id,
    icon: ShieldCheck,
    color: 'text-indigo-400',
  };
  const Icon = meta.icon;
  const currentModel = persona.model || 'claude-haiku-4.5';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-card border-border/80 p-6 rounded-xl shadow-2xl">
        <DialogHeader className="pb-4 border-b border-border/40">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl bg-background/90 border border-border/40 ${meta.color}`}>
                <Icon className="h-6 w-6" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold flex items-center gap-2">
                  <span>{persona.displayName || meta.name}</span>
                </DialogTitle>
                <DialogDescription className="text-xs font-mono text-muted-foreground mt-0.5">
                  ID: {persona.id} • Configure System Prompt, Model Override &amp; Arbitration Rules
                </DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={persona.enabled !== false ? 'success' : 'secondary'} className="text-xs">
                {persona.enabled !== false ? 'Active' : 'Disabled'}
              </Badge>
              {persona.required && (
                <Badge variant="outline" className="text-xs border-indigo-400/40 text-indigo-300">
                  Required
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Quick Settings Bar: Model, Effort, Max Turns, Confidence, Active Toggle */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 p-4 rounded-xl border border-border/60 bg-background/40">
            {/* 1. LLM Model Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-indigo-400" />
                Model Override
              </label>
              <Select
                value={currentModel}
                onValueChange={(model) => onUpdatePersonaField({ model })}
              >
                <SelectTrigger className="text-xs bg-background/80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {enabledProviderList.length > 0 ? (
                    enabledProviderList.map((provider) => {
                      const activeModelsList = dynamicModels.length > 0 ? dynamicModels : allAvailableModels;
                      const rawModels = Array.from(
                        new Set([
                          ...(provider.activeModels || []),
                          ...(provider.customModels || []),
                          ...Object.values(modelRegistry || {})
                            .filter((item) => item.providerId === provider.id && item.enabled !== false)
                            .map((item) => item.id),
                        ])
                      );

                      const providerModels = rawModels.filter((m) => {
                        if (Array.isArray(provider.activeModels)) {
                          const inActive = provider.activeModels.includes(m);
                          const inCustom = Array.isArray(provider.customModels) && provider.customModels.includes(m);
                          if (!inActive && !inCustom) return false;
                        }
                        if (modelRegistry[m] && modelRegistry[m].enabled === false) return false;
                        if (activeModelsList.length > 0 && !activeModelsList.includes(m)) return false;
                        return true;
                      });

                      if (providerModels.length === 0) return null;

                      return (
                        <React.Fragment key={provider.id}>
                          <div className="px-2 py-1 text-[11px] font-bold text-indigo-400 uppercase tracking-wider bg-accent/40">
                            {provider.displayName}
                          </div>
                          {providerModels.map((m) => (
                            <SelectItem key={`${provider.id}-${m}`} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <div className="p-2 text-xs text-muted-foreground text-center">
                      No active providers available
                    </div>
                  )}

                  {!allAvailableModels.includes(currentModel) && (
                    <SelectItem value={currentModel}>
                      {currentModel} (Custom / Default)
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* 2. Reasoning Effort Level */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-amber-400" />
                Reasoning Effort
              </label>
              <Select
                value={persona.effort || 'low'}
                onValueChange={(effort: any) => onUpdatePersonaField({ effort })}
              >
                <SelectTrigger className="text-xs bg-background/80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low (Fast scan)</SelectItem>
                  <SelectItem value="medium">Medium (Standard)</SelectItem>
                  <SelectItem value="high">High (Deep reasoning)</SelectItem>
                  <SelectItem value="xhigh">Extra High (Thorough)</SelectItem>
                  <SelectItem value="max">Max (Maximum audit)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 3. Max Exploration Turns Slider & Numeric Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <RotateCw className="h-3.5 w-3.5 text-indigo-400" />
                  Max Turns
                </span>
                <span className="font-mono text-indigo-300 font-bold">
                  {persona.maxTurns ?? 20}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={persona.maxTurns ?? 20}
                  onChange={(e) =>
                    onUpdatePersonaField({ maxTurns: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)) })
                  }
                  className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={persona.maxTurns ?? 20}
                  onChange={(e) =>
                    onUpdatePersonaField({ maxTurns: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)) })
                  }
                  className="font-mono text-xs bg-background/80 w-14 text-center shrink-0 h-8 p-1"
                />
              </div>
            </div>

            {/* 3. Confidence Threshold Slider & Numeric Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Sliders className="h-3.5 w-3.5 text-purple-400" />
                  Confidence
                </span>
                <span className="font-mono text-indigo-300 font-bold">
                  {persona.confidenceThreshold ?? 80}%
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={persona.confidenceThreshold ?? 80}
                  onChange={(e) =>
                    onUpdatePersonaField({ confidenceThreshold: parseInt(e.target.value, 10) || 0 })
                  }
                  className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={persona.confidenceThreshold ?? 80}
                  onChange={(e) =>
                    onUpdatePersonaField({ confidenceThreshold: parseInt(e.target.value, 10) || 0 })
                  }
                  className="font-mono text-xs bg-background/80 w-14 text-center shrink-0 h-8 p-1"
                />
              </div>
            </div>

            {/* 4. Active Switch & Dry-Run Simulator */}
            <div className="space-y-1.5 flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Persona Active</span>
                <Switch
                  id="drawer-persona-active-switch"
                  checked={persona.enabled !== false}
                  onCheckedChange={(checked) => onUpdatePersonaField({ enabled: checked })}
                />
              </div>
              <div className="pt-1">
                <PromptTestModal
                  persona={persona}
                  customPrompt={activePrompt}
                  trigger={
                    <Button variant="outline" size="sm" className="w-full h-8 text-xs gap-1.5 border-indigo-500/30 text-indigo-300">
                      <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                      Dry-Run Simulator
                    </Button>
                  }
                />
              </div>
            </div>
          </div>

          {/* System Prompt Template Editor */}
          <div className="pt-2">
            <PromptEditor
              value={activePrompt}
              defaultValue={savedPrompt}
              onChange={onPromptChange}
              onSave={onSavePersona}
              onReset={onResetDefaults}
              isSaving={isSaving}
              title={`System Prompt & Review Guidelines: ${persona.displayName || persona.id}`}
            />
          </div>
        </div>

        <DialogFooter className="pt-4 border-t border-border/40 flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-xs"
          >
            Close
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSaveAll}
              disabled={isSaving}
              className="text-xs"
            >
              Save All Personas
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onSavePersona}
              disabled={isSaving}
              className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? 'Saving Persona...' : 'Save Persona Changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
