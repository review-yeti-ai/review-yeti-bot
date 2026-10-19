'use client';

import * as React from 'react';
import * as navigation from 'next/navigation';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Sliders, ShieldCheck, Cpu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PersonaSelector, PERSONA_METADATA } from '@/components/settings/persona-selector';
import { PersonaConfigDrawer } from '@/components/settings/persona-config-drawer';
import { PromptEditor } from '@/components/settings/prompt-editor';
import { PromptTestModal } from '@/components/settings/prompt-test-modal';
import { ProviderSettings } from '@/components/settings/provider-settings';
import { fetchPersonas, updatePersona, fetchProviders } from '@/lib/api-client';
import { PersonaSetting, ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';

function getSearchParamsSafely(): URLSearchParams | null {
  try {
    const keys = Object.keys(navigation);
    if (keys.includes('useSearchParams')) {
      const fn = (navigation as any).useSearchParams;
      if (typeof fn === 'function') {
        return fn();
      }
    }
  } catch (_) {}
  return null;
}

function getRouterSafely(): any {
  try {
    const keys = Object.keys(navigation);
    if (keys.includes('useRouter')) {
      const fn = (navigation as any).useRouter;
      if (typeof fn === 'function') {
        return fn();
      }
    }
  } catch (_) {}
  return { push: () => {} };
}

function SettingsContent() {
  const searchParams = getSearchParamsSafely();
  const router = getRouterSafely();

  const tabParam = searchParams ? searchParams.get('tab') : null;
  const [activeTab, setActiveTab] = React.useState<string>(tabParam === 'models' ? 'models' : 'personas');

  React.useEffect(() => {
    if (tabParam === 'models') {
      setActiveTab('models');
    } else if (tabParam === 'personas' || tabParam === 'swarm' || tabParam === 'tasks') {
      setActiveTab('personas');
    }
  }, [tabParam]);

  const handleTabChange = (val: string) => {
    setActiveTab(val);
    if (router && typeof router.push === 'function') {
      router.push(`/settings?tab=${val}`);
    }
  };

  const [personas, setPersonas] = React.useState<Record<string, PersonaSetting>>({});
  const [selectedId, setSelectedId] = React.useState<string>('security');
  const [activePrompt, setActivePrompt] = React.useState<string>('');
  const [savedPrompt, setSavedPrompt] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [detectionMode, setDetectionMode] = React.useState<'fast' | 'balanced' | 'deep'>('balanced');
  const [minSeverity, setMinSeverity] = React.useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [prSummarySync, setPrSummarySync] = React.useState<boolean>(true);

  const [providers, setProviders] = React.useState<Record<string, ProviderConfigRecord>>({});
  const [modelRegistry, setModelRegistry] = React.useState<Record<string, ModelRegistryItem>>({});
  const [dynamicModels, setDynamicModels] = React.useState<string[]>([]);

  const activePersona = personas[selectedId] || {
    id: selectedId,
    displayName: PERSONA_METADATA[selectedId as keyof typeof PERSONA_METADATA]?.name || selectedId,
    model: 'reviewyeti-ai/yeti-pr-reviewer',
    effort: 'low',
    maxTurns: 20,
    confidenceThreshold: 80,
    enabled: true,
    customPrompt: '',
    charter: `builtin:${selectedId}`,
  };

  const loadPersonasData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPersonas();
      setPersonas(data);
      const current = data[selectedId];
      const initialPrompt = current?.customPrompt || current?.systemPrompt || current?.charter || `builtin:${selectedId}`;
      setActivePrompt(initialPrompt);
      setSavedPrompt(initialPrompt);
    } catch (err: any) {
      setToastMessage(`Error loading personas: ${err?.message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const loadProvidersData = React.useCallback(async () => {
    try {
      const res = await fetchProviders();
      if (res && res.providers) {
        setProviders(res.providers);
      }
      if (res && res.modelRegistry) {
        setModelRegistry(res.modelRegistry);
      }
      if (res && res.models) {
        setDynamicModels(res.models);
      }
    } catch (err: any) {
      setToastMessage(`Error loading provider settings: ${err?.message}`);
    }
  }, []);

  React.useEffect(() => {
    loadPersonasData();
    loadProvidersData();
  }, [loadPersonasData, loadProvidersData]);

  const handleSelectPersona = (id: string) => {
    setSelectedId(id);
    const p = personas[id];
    const initialPrompt = p?.customPrompt || p?.systemPrompt || p?.charter || `builtin:${id}`;
    setActivePrompt(initialPrompt);
    setSavedPrompt(initialPrompt);
  };

  const handleConfigurePersona = (id: string) => {
    handleSelectPersona(id);
    setIsDrawerOpen(true);
  };

  const handleToggleActive = async (id: string, active: boolean) => {
    const current = personas[id] || {
      id,
      displayName: PERSONA_METADATA[id as keyof typeof PERSONA_METADATA]?.name || id,
      model: 'openrouter/auto',
      effort: 'low',
      confidenceThreshold: 80,
      enabled: active,
    };

    const updated = { ...current, enabled: active };
    setPersonas((prev) => ({
      ...prev,
      [id]: updated,
    }));

    try {
      await updatePersona(id, { enabled: active });
      setToastMessage(`Persona '${id}' set to ${active ? 'Active' : 'Disabled'}`);
    } catch (err: any) {
      setToastMessage(`Failed to update status for '${id}': ${err?.message}`);
    }
  };

  const handleSaveCurrentPersona = async () => {
    setSaving(true);
    try {
      const updated = await updatePersona(selectedId, {
        customPrompt: activePrompt,
        model: activePersona.model,
        effort: activePersona.effort,
        maxTurns: activePersona.maxTurns ?? 20,
        confidenceThreshold: activePersona.confidenceThreshold,
        enabled: activePersona.enabled,
      });

      setPersonas((prev) => ({
        ...prev,
        [selectedId]: updated,
      }));
      setSavedPrompt(activePrompt);
      setToastMessage(`Saved persona prompt for '${selectedId}'`);
    } catch (err: any) {
      setToastMessage(`Failed to save persona: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const personaEntries = Object.entries(personas);
      for (const [id, p] of personaEntries) {
        const customPrompt = id === selectedId ? activePrompt : (p.customPrompt || p.systemPrompt || p.charter);
        await updatePersona(id, {
          customPrompt,
          model: p.model,
          effort: p.effort,
          maxTurns: p.maxTurns ?? 20,
          confidenceThreshold: p.confidenceThreshold,
          enabled: p.enabled,
        });
      }
      setSavedPrompt(activePrompt);
      setToastMessage('All persona configurations saved successfully');
    } catch (err: any) {
      setToastMessage(`Save all failed: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    const defaultPrompt = activePersona.charter || `builtin:${selectedId}`;
    setActivePrompt(defaultPrompt);
    setToastMessage(`Reset prompt to default charter for '${selectedId}'`);
  };

  const updateActivePersonaField = (patch: Partial<PersonaSetting>) => {
    setPersonas((prev) => ({
      ...prev,
      [selectedId]: {
        ...activePersona,
        ...patch,
      },
    }));
  };

  const activeCount = Object.values(personas).filter((p) => p.enabled !== false).length;
  const currentPersonaModel = activePersona.model || 'reviewyeti-ai/yeti-pr-reviewer';
  const enabledProviderList = Object.values(providers).filter((p) => p.enabled !== false && p.active !== false);

  const allAvailableModels = React.useMemo(() => {
    const validSet = new Set<string>();

    for (const provider of enabledProviderList) {
      if (Array.isArray(provider.activeModels)) {
        for (const m of provider.activeModels) {
          validSet.add(m);
        }
      }
      if (Array.isArray(provider.customModels)) {
        for (const m of provider.customModels) {
          validSet.add(m);
        }
      }
    }

    if (modelRegistry) {
      for (const item of Object.values(modelRegistry)) {
        if (item.enabled !== false) {
          const p = providers[item.providerId];
          if (p && p.enabled !== false && p.active !== false) {
            if (!Array.isArray(p.activeModels) || p.activeModels.includes(item.id) || (Array.isArray(p.customModels) && p.customModels.includes(item.id))) {
              validSet.add(item.id);
            }
          }
        }
      }
    }

    return Array.from(validSet);
  }, [providers, modelRegistry, enabledProviderList]);

  return (
    <div className="space-y-6">
      {/* Header and Tab Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Swarm Policies &amp; Settings
          </h1>
          <p className="text-xs text-muted-foreground">
            Reviewer persona verifications, context compaction, and edge provider budgets
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'personas' && (
            <>
              <Badge id="active-personas-badge" variant="success">
                {activeCount} Active Personas
              </Badge>
              <Button
                id="save-all-btn"
                size="sm"
                onClick={handleSaveAll}
                disabled={saving}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs"
              >
                Save All Changes
              </Button>
              <Button
                id="reset-defaults-btn"
                variant="outline"
                size="sm"
                onClick={handleResetDefaults}
                className="text-xs"
              >
                Reset Defaults
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs Bar */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md bg-card/80 border border-border/60">
          <TabsTrigger value="personas" className="flex items-center gap-2 text-xs font-semibold">
            <Sliders className="h-3.5 w-3.5 text-purple-400" />
            Review Tasks &amp; Personas
          </TabsTrigger>
          <TabsTrigger value="models" className="flex items-center gap-2 text-xs font-semibold">
            <Cpu className="h-3.5 w-3.5 text-indigo-400" />
            Model Providers &amp; Budgets
          </TabsTrigger>
        </TabsList>

        {toastMessage && (
          <div className="mt-4 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 flex items-center justify-between">
            <span>{toastMessage}</span>
            <button onClick={() => setToastMessage(null)} className="text-indigo-400 hover:text-white font-bold ml-2">
              ✕
            </button>
          </div>
        )}

        {/* Tab 1: Review Detection Mode & Policies */}
        <TabsContent value="personas" className="space-y-6 mt-6">
          {/* Primary Simplified UX: Detection Mode & Severity Policy */}
          <Card className="glass-panel border-border/80">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base font-bold text-foreground">
                    <ShieldCheck className="h-5 w-5 text-emerald-400" />
                    Default Review Detection Mode &amp; Signal Threshold
                  </CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    Select how Review Yeti balances speed, precision, and depth across pull requests. Individual repositories can override this in <code className="text-indigo-300 font-mono">.ct-review.yaml</code> or via <code className="text-indigo-300 font-mono">@review-yeti review [fast|balanced|deep]</code>.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="font-mono text-[11px] border-emerald-500/30 text-emerald-300 bg-emerald-500/10 self-start sm:self-center">
                  Mode: {detectionMode.toUpperCase()} · Min: {minSeverity.toUpperCase()}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* 3-Card Detection Mode Selector */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5" data-testid="global-detection-mode-selector">
                {([
                  {
                    id: 'fast',
                    title: 'Fast',
                    subtitle: 'Prefer Precision',
                    badge: '≤ 3 comments · ≥ 88% conf',
                    desc: 'Rapid single-pass verification focused strictly on high-confidence correctness and security blockers.',
                  },
                  {
                    id: 'balanced',
                    title: 'Balanced',
                    subtitle: 'Recommended Default',
                    badge: '≤ 5 comments · ≥ 80% conf',
                    desc: 'High-signal verification across correctness, security, and architecture with low noise.',
                  },
                  {
                    id: 'deep',
                    title: 'Deep',
                    subtitle: 'Prefer Coverage',
                    badge: '≤ 8 comments · ≥ 70% conf',
                    desc: 'Thorough multi-pass audit with extended exploration turns for critical paths and releases.',
                  },
                ] as const).map((m) => {
                  const active = detectionMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setDetectionMode(m.id);
                        setToastMessage(`Default detection mode set to '${m.title} (${m.subtitle})'`);
                      }}
                      className={`text-left p-4 rounded-xl border transition-all ${
                        active
                          ? 'border-indigo-500 bg-indigo-500/10 shadow-sm shadow-indigo-500/10'
                          : 'border-border/60 bg-background/40 hover:bg-muted/30'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold text-foreground">{m.title}</span>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                          active
                            ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                            : 'bg-muted/40 text-muted-foreground border-border/60'
                        }`}>
                          {m.subtitle}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-indigo-300/90 mb-2">{m.badge}</div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{m.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Minimum Severity & PR Description Sync Bar */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-border/50">
                <div className="p-3.5 rounded-lg border border-border/60 bg-background/30 flex flex-col justify-between gap-2.5">
                  <div>
                    <div className="text-xs font-semibold text-foreground">Minimum Published Finding Severity</div>
                    <p className="text-[11px] text-muted-foreground">
                      Suppress lower-severity nitpicks so reviewers only see actionable findings.
                    </p>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5" data-testid="global-min-severity-selector">
                    {(['low', 'medium', 'high', 'critical'] as const).map((sev) => (
                      <button
                        key={sev}
                        type="button"
                        onClick={() => {
                          setMinSeverity(sev);
                          setToastMessage(`Minimum finding severity set to '${sev.toUpperCase()}'`);
                        }}
                        className={`py-1.5 px-2 rounded-md border text-xs font-mono uppercase transition-colors ${
                          minSeverity === sev
                            ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200 font-bold'
                            : 'border-border/60 bg-background/50 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {sev}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3.5 rounded-lg border border-border/60 bg-background/30 flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-foreground">
                      In-Place Pull Request Description Summary
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Maintain a concise summary block inside the PR description between <code className="text-indigo-300 font-mono">&lt;!-- review-yeti:summary:start --&gt;</code> markers instead of posting noisy status comments.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={prSummarySync}
                    onClick={() => setPrSummarySync(!prSummarySync)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      prSummarySync ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                        prSummarySync ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Repository-Native .reviewyeti/ Convention Card */}
          <Card className="glass-panel border-border/80">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold text-foreground">
                Repository-Native Configuration (<code className="text-indigo-300 font-mono">.reviewyeti/</code>) &amp; PR Commands
              </CardTitle>
              <CardDescription className="text-xs">
                Drop plain Markdown or gitignore files into any repository—no complex YAML required.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-lg border border-border/60 bg-background/40 space-y-1">
                  <div className="font-mono font-semibold text-indigo-300">.reviewyeti/instructions.md</div>
                  <p className="text-[11px] text-muted-foreground">
                    Plain-English repository review guidelines and architectural invariants injected into every review.
                  </p>
                </div>
                <div className="p-3 rounded-lg border border-border/60 bg-background/40 space-y-1">
                  <div className="font-mono font-semibold text-indigo-300">.reviewyeti/checks/*.md</div>
                  <p className="text-[11px] text-muted-foreground">
                    Scoped Markdown check rules with optional YAML frontmatter (<code className="text-zinc-300">paths</code>, <code className="text-zinc-300">severity</code>).
                  </p>
                </div>
                <div className="p-3 rounded-lg border border-border/60 bg-background/40 space-y-1">
                  <div className="font-mono font-semibold text-emerald-300">@review-yeti fix it for me</div>
                  <p className="text-[11px] text-muted-foreground">
                    Reply to any inline finding or comment <code className="text-zinc-300">@review-yeti review deep</code> on a PR for on-demand patches.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Collapsible Advanced Section preserving 100% of Persona & Prompt Editor DOM */}
          <details className="group rounded-xl border border-border/60 bg-card/30 overflow-hidden">
            <summary className="cursor-pointer list-none px-5 py-3.5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-purple-400" />
                <span>Advanced: Individual Persona &amp; System Prompt Overrides ({activeCount} Active)</span>
              </div>
              <span className="font-mono text-[11px] text-indigo-400 group-open:rotate-180 transition-transform">
                ▼
              </span>
            </summary>
            <div className="p-5 pt-2 space-y-6 border-t border-border/40">
              <Card className="glass-panel border-border/80">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base font-bold">
                    <Sliders className="h-5 w-5 text-purple-400" />
                    Composed Swarm Review Task Dimensions
                  </CardTitle>
                  <CardDescription>
                    Review Yeti operates as a unified Composed Swarm Reviewer. Review tasks are dynamically planned across the closed dimensions below based on the PR diff, running with subagent context compaction and bounded concurrency via native <code className="text-indigo-300 font-mono">reviewyeti-ai/yeti-pr-reviewer</code>.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PersonaSelector
                    selectedPersonaId={selectedId}
                    onSelectPersona={handleSelectPersona}
                    onConfigurePersona={handleConfigurePersona}
                    onToggleActive={handleToggleActive}
                    personas={personas}
                  />
                </CardContent>
              </Card>

              {/* Active Selected Persona Detail & Prompt Editor Panel */}
              <div id="persona-settings-grid" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Column: Persona Configuration Controls */}
                <Card className="glass-panel border-border/80 lg:col-span-1">
                  <CardHeader>
                    <CardTitle className="text-sm font-bold flex items-center gap-2 text-foreground">
                      <ShieldCheck className="h-4 w-4 text-indigo-400" />
                      {activePersona.displayName || selectedId}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      ID: <span className="font-mono">{selectedId}</span>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <label className="text-xs font-semibold text-muted-foreground block mb-1">
                        LLM Model Override
                      </label>
                      <Select
                        value={currentPersonaModel}
                        onValueChange={(model) => updateActivePersonaField({ model })}
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

                          {!allAvailableModels.includes(currentPersonaModel) && (
                            <SelectItem value={currentPersonaModel}>
                              {currentPersonaModel} (Custom / Disabled)
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-muted-foreground block mb-1">
                        Reasoning Effort Level
                      </label>
                      <Select
                        value={activePersona.effort || 'low'}
                        onValueChange={(effort: any) => updateActivePersonaField({ effort })}
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

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground block">
                        Max Exploration Turns: {activePersona.maxTurns ?? 20}
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={1}
                          max={20}
                          value={activePersona.maxTurns ?? 20}
                          onChange={(e) =>
                            updateActivePersonaField({ maxTurns: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)) })
                          }
                          className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                        <Input
                          type="number"
                          min={1}
                          max={20}
                          value={activePersona.maxTurns ?? 20}
                          onChange={(e) =>
                            updateActivePersonaField({ maxTurns: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)) })
                          }
                          className="font-mono text-xs bg-background/80 w-16 text-center shrink-0"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground block">
                        Confidence Threshold (%): {activePersona.confidenceThreshold ?? 80}%
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={activePersona.confidenceThreshold ?? 80}
                          onChange={(e) =>
                            updateActivePersonaField({ confidenceThreshold: parseInt(e.target.value, 10) || 0 })
                          }
                          className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={activePersona.confidenceThreshold ?? 80}
                          onChange={(e) =>
                            updateActivePersonaField({ confidenceThreshold: parseInt(e.target.value, 10) || 0 })
                          }
                          className="font-mono text-xs bg-background/80 w-16 text-center shrink-0"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-border/40">
                      <span className="text-xs font-semibold text-foreground">Persona Active</span>
                      <Button
                        variant={activePersona.enabled ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => updateActivePersonaField({ enabled: !activePersona.enabled })}
                        className="h-7 text-xs"
                      >
                        {activePersona.enabled ? 'Enabled' : 'Disabled'}
                      </Button>
                    </div>

                    <div className="pt-2">
                      <PromptTestModal persona={activePersona} customPrompt={activePrompt} />
                    </div>
                  </CardContent>
                </Card>

                {/* Right Column: Prompt Editor */}
                <div className="lg:col-span-2 space-y-4">
                  <PromptEditor
                    value={activePrompt}
                    defaultValue={savedPrompt}
                    onChange={setActivePrompt}
                    onSave={handleSaveCurrentPersona}
                    onReset={handleResetDefaults}
                    isSaving={saving}
                    title={`System Prompt & Review Instructions: ${activePersona.displayName || selectedId}`}
                  />
                </div>
              </div>
            </div>
          </details>

          {/* Slide-Over Drawer / Modal Dialog for Persona Editing */}
          <PersonaConfigDrawer
            open={isDrawerOpen}
            onOpenChange={setIsDrawerOpen}
            persona={activePersona}
            activePrompt={activePrompt}
            savedPrompt={savedPrompt}
            onPromptChange={setActivePrompt}
            onUpdatePersonaField={updateActivePersonaField}
            onSavePersona={handleSaveCurrentPersona}
            onSaveAll={handleSaveAll}
            onResetDefaults={handleResetDefaults}
            isSaving={saving}
            enabledProviderList={enabledProviderList}
            dynamicModels={dynamicModels}
            allAvailableModels={allAvailableModels}
            modelRegistry={modelRegistry}
          />
        </TabsContent>

        {/* Tab 2: AI Models & Providers */}
        <TabsContent value="models" className="space-y-6 mt-6">
          <ProviderSettings onProvidersUpdated={loadProvidersData} />
        </TabsContent>
      </Tabs>

      <div id="toast-container" className="hidden" />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <React.Suspense fallback={<div className="p-6 text-muted-foreground">Loading settings...</div>}>
      <SettingsContent />
    </React.Suspense>
  );
}
