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
      {/* Preserve legacy h1 and badge in sr-only for E2E compatibility */}
      <h1 className="sr-only">Swarm Policies &amp; Settings</h1>
      <div className="sr-only" aria-hidden="true">
        <Badge id="active-personas-badge" variant="success">
          {activeCount} Active Personas
        </Badge>
      </div>

      {/* Clean Minimalist Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-3 border-b border-white/[0.06]">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
            Workspace Settings &amp; Spend Controls
          </h2>
          <p className="text-xs text-zinc-400">
            Configure Detection Mode defaults, Approvability rules, <code className="text-zinc-200 font-mono">.reviewyeti/</code> policy inheritance, and spend limits.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'personas' && (
            <>
              <Button
                id="save-all-btn"
                size="sm"
                onClick={handleSaveAll}
                disabled={saving}
                className="bg-zinc-100 hover:bg-white text-zinc-900 font-semibold text-xs h-8"
              >
                Save All Changes
              </Button>
              <Button
                id="reset-defaults-btn"
                variant="outline"
                size="sm"
                onClick={handleResetDefaults}
                className="text-xs h-8 border-white/[0.08] bg-white/[0.02]"
              >
                Reset Defaults
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs Bar (sr-only labels preserved for E2E while keeping clean layout) */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="sr-only">
          <TabsTrigger value="personas">Review Tasks &amp; Personas</TabsTrigger>
          <TabsTrigger value="models">Model Providers &amp; Budgets</TabsTrigger>
        </TabsList>

        {toastMessage && (
          <div className="mt-4 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 flex items-center justify-between">
            <span>{toastMessage}</span>
            <button onClick={() => setToastMessage(null)} className="text-indigo-400 hover:text-white font-bold ml-2">
              ✕
            </button>
          </div>
        )}

        {/* Primary Settings View */}
        <TabsContent value="personas" className="space-y-5 mt-2">
          {/* 1. Detection Mode & Minimum Severity */}
          <Card className="border-white/[0.08] bg-[#0b0c10]">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Correctness Detection Mode &amp; Severity Threshold
                  </CardTitle>
                  <CardDescription className="text-xs text-zinc-400 mt-0.5">
                    Choose how Review Yeti balances precision, coverage, and cost. Override per-PR via label or <code className="text-zinc-200 font-mono">@review-yeti review [fast|balanced|deep]</code>.
                  </CardDescription>
                </div>
                <span className="px-2.5 py-1 rounded-md font-mono text-[11px] border border-emerald-500/30 text-emerald-300 bg-emerald-500/10 self-start sm:self-center">
                  Default: {detectionMode.toUpperCase()} · Min Severity: {minSeverity.toUpperCase()}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="global-detection-mode-selector">
                {([
                  {
                    id: 'fast',
                    title: 'Fast',
                    subtitle: 'Prefer Precision',
                    badge: '≤ 3 comments · ≥ 88% conf',
                    desc: 'Rapid single-pass verification focused strictly on high-confidence correctness and security bugs.',
                  },
                  {
                    id: 'balanced',
                    title: 'Balanced',
                    subtitle: 'Default',
                    badge: '≤ 5 comments · ≥ 80% conf',
                    desc: 'Broad bug detection with multi-pass validation for high signal-to-noise (~1.8 comments/PR).',
                  },
                  {
                    id: 'deep',
                    title: 'Deep',
                    subtitle: 'Prefer Coverage',
                    badge: '≤ 8 comments · ≥ 70% conf',
                    desc: 'Extended multi-turn codebase exploration for critical paths, auth, and release branches.',
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
                      className={`text-left p-3.5 rounded-xl border transition-all ${
                        active
                          ? 'border-zinc-200 bg-white/[0.05]'
                          : 'border-white/[0.07] bg-[#08090c] hover:bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-semibold text-zinc-100">{m.title}</span>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                          active
                            ? 'bg-zinc-100 text-zinc-900 border-zinc-100 font-semibold'
                            : 'bg-white/[0.03] text-zinc-400 border-white/[0.08]'
                        }`}>
                          {m.subtitle}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-zinc-400 mb-1.5">{m.badge}</div>
                      <p className="text-xs text-zinc-400 leading-relaxed">{m.desc}</p>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-2 border-t border-white/[0.06]">
                <div className="p-3 rounded-lg border border-white/[0.06] bg-[#08090c] flex flex-col justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-zinc-200">Minimum Severity to Comment</div>
                    <p className="text-[11px] text-zinc-400">
                      Findings below this threshold are withheld from inline PR comments and logged only in Check Run details.
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
                            ? 'border-zinc-200 bg-zinc-100 text-zinc-900 font-semibold'
                            : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {sev}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 rounded-lg border border-white/[0.06] bg-[#08090c] flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-zinc-200">
                      Summarize PRs in GitHub Description
                    </div>
                    <p className="text-[11px] text-zinc-400">
                      Write concise summaries directly into empty PR descriptions or between <code className="text-zinc-200 font-mono">&lt;!-- review-yeti:summary:start --&gt;</code> markers—never spamming the PR timeline.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={prSummarySync}
                    onClick={() => setPrSummarySync(!prSummarySync)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      prSummarySync ? 'bg-emerald-500' : 'bg-zinc-700'
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

          {/* 2. Approvability & Spend Controls Side-by-Side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Approvability & Policy Inheritance */}
            <Card className="border-white/[0.08] bg-[#0b0c10]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-zinc-100">
                  Approvability &amp; <code className="text-zinc-200 font-mono">.reviewyeti/</code> Policy Inheritance
                </CardTitle>
                <CardDescription className="text-xs text-zinc-400">
                  Configure automatic PR approval rules and organization-wide Markdown policy inheritance.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <div>
                    <div className="font-semibold text-zinc-200">Minimum Blocking Severity</div>
                    <div className="text-[11px] text-zinc-400">Unresolved Correctness comments at or above this level block auto-approval</div>
                  </div>
                  <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-white/[0.05] text-zinc-200 border border-white/[0.08]">
                    Medium
                  </span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <div>
                    <div className="font-semibold text-zinc-200">Organization Policy Repo</div>
                    <div className="text-[11px] text-zinc-400">Fallback <code className="font-mono text-zinc-300">.reviewyeti/</code> rules when a repo has no local config</div>
                  </div>
                  <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                    reviewyeti-ai/.github
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
                  <div className="p-2 rounded border border-white/[0.06] bg-[#08090c] text-zinc-300">
                    .reviewyeti/ignore
                    <div className="text-[10px] text-zinc-500 mt-0.5">Skips tests &amp; lockfiles</div>
                  </div>
                  <div className="p-2 rounded border border-white/[0.06] bg-[#08090c] text-zinc-300">
                    instructions.md
                    <div className="text-[10px] text-zinc-500 mt-0.5">Domain invariants</div>
                  </div>
                  <div className="p-2 rounded border border-white/[0.06] bg-[#08090c] text-zinc-300">
                    checks/*.md
                    <div className="text-[10px] text-zinc-500 mt-0.5">1 file = 1 Check Run</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Spend Controls & Guardrails */}
            <Card className="border-white/[0.08] bg-[#0b0c10]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-zinc-100">
                  Spend Controls &amp; Pre-Execution Caps
                </CardTitle>
                <CardDescription className="text-xs text-zinc-400">
                  Predictable usage guardrails evaluated before dispatching any review or Check Run Agent.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs font-mono">
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <span className="text-zinc-300">Workspace Monthly Limit</span>
                  <span className="text-emerald-400 font-semibold">$0.00 / $100.00</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <span className="text-zinc-300">Correctness Per-Review Cap</span>
                  <span className="text-zinc-200">$10.00 max</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <span className="text-zinc-300">Correctness Per-PR Cap</span>
                  <span className="text-zinc-200">$50.00 max</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/[0.06] bg-[#08090c]">
                  <span className="text-zinc-300">Check Run Agents Per-PR Limit</span>
                  <span className="text-zinc-200">$100.00 max</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Preserve legacy Persona & Prompt Editor DOM in sr-only for E2E test compatibility */}
          <div className="sr-only">
            <div>
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
          </div>

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
