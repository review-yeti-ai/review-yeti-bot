'use client';

import * as React from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Cpu,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Plus,
  Trash2,
  Globe,
  Key,
  Layers,
  Zap,
  Sliders,
  Shield,
} from 'lucide-react';
import { ProviderConfigRecord, ModelRegistryItem, PersonaSetting } from '@/types/dashboard';
import {
  fetchProviders,
  updateProvider,
  testProvider,
  fetchPersonas,
  updatePersona,
  remapPersonasAndDisableProvider,
} from '@/lib/api-client';
import { ModelRemappingDialog } from '@/components/settings/model-remapping-dialog';

const TARGET_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'gemini',
  'grok',
  'deepseek',
  'glm',
  'doppler',
  'ollama',
  'custom-openai',
];

const PROVIDER_ICONS: Record<string, string> = {
  openai: '🟢',
  anthropic: '🧡',
  gemini: '🔵',
  grok: '⚡',
  deepseek: '🐳',
  glm: '🤖',
  doppler: '🔒',
  ollama: '🦙',
  'custom-openai': '🔌',
  codex: '💻',
  agy: '🧠',
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  grok: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  glm: 'https://api.omniroute.internal/v1',
  doppler: 'https://api.doppler.com/v3',
  ollama: 'http://localhost:11434/v1',
  'custom-openai': 'https://api.custom-llm.com/v1',
};

interface ProviderSettingsProps {
  onProvidersUpdated?: () => void;
}

export function ProviderSettings({ onProvidersUpdated }: ProviderSettingsProps) {
  const [providers, setProviders] = React.useState<Record<string, ProviderConfigRecord>>({});
  const [modelRegistry, setModelRegistry] = React.useState<Record<string, ModelRegistryItem>>({});
  const [personas, setPersonas] = React.useState<Record<string, PersonaSetting>>({});
  const [loading, setLoading] = React.useState(true);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [testResults, setTestResults] = React.useState<
    Record<string, { success: boolean; message: string; latencyMs?: number }>
  >({});
  const [showKeys, setShowKeys] = React.useState<Record<string, boolean>>({});
  const [customModelInput, setCustomModelInput] = React.useState<Record<string, string>>({});
  const [rawApiKeys, setRawApiKeys] = React.useState<Record<string, string>>({});
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);

  // Model Remapping Dialog state
  const [remappingDialogOpen, setRemappingDialogOpen] = React.useState(false);
  const [impactedPersonas, setImpactedPersonas] = React.useState<PersonaSetting[]>([]);
  const [availableModelsForRemap, setAvailableModelsForRemap] = React.useState<string[]>([]);
  const [disablingTargetName, setDisablingTargetName] = React.useState<string>('');
  const [pendingAction, setPendingAction] = React.useState<{
    type: 'provider' | 'model';
    providerId: string;
    patch?: Partial<ProviderConfigRecord>;
    modelName?: string;
  } | null>(null);

  const loadProviderData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [res, personasData] = await Promise.all([
        fetchProviders(),
        fetchPersonas().catch(() => ({})),
      ]);
      if (res.providers) {
        setProviders(res.providers);
      }
      if (res.modelRegistry) {
        setModelRegistry(res.modelRegistry);
      }
      if (personasData) {
        setPersonas(personasData);
      }
    } catch (err: any) {
      setToastMessage(`Failed to load providers: ${err?.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadProviderData();
  }, [loadProviderData]);

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleFieldChange = (id: string, patch: Partial<ProviderConfigRecord>) => {
    setProviders((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...patch,
      },
    }));
  };

  const handleTestConnection = async (id: string) => {
    setTestingId(id);
    const provider = providers[id];
    try {
      const res = await testProvider(id, { baseUrl: provider?.baseUrl });
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          success: res.success,
          message: res.message || 'Connection test succeeded',
          latencyMs: res.latencyMs,
        },
      }));
      setToastMessage(`Tested ${provider?.displayName || id}: ${res.message}`);
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          success: false,
          message: err?.message || 'Connection test failed',
        },
      }));
      setToastMessage(`Connection test failed for ${id}: ${err?.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleSaveProvider = async (id: string) => {
    setSavingId(id);
    const provider = providers[id];
    const rawKey = rawApiKeys[id];
    try {
      const patch: Partial<ProviderConfigRecord> = {
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        subscriptionTier: provider.subscriptionTier,
        activeModels: provider.activeModels,
        customModels: provider.customModels,
      };
      if (rawKey !== undefined && rawKey.trim() !== '') {
        patch.apiKeyRaw = rawKey;
      }
      const updated = await updateProvider(id, patch);
      setProviders((prev) => ({ ...prev, [id]: updated }));
      setToastMessage(`Saved changes for ${updated.displayName}`);
      if (onProvidersUpdated) {
        onProvidersUpdated();
      }
    } catch (err: any) {
      setToastMessage(`Failed to save provider '${id}': ${err?.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const handleAddCustomModel = async (providerId: string) => {
    const modelName = customModelInput[providerId]?.trim();
    if (!modelName) return;

    const provider = providers[providerId];
    if (!provider) return;

    const existingCustom = provider.customModels || [];
    if (existingCustom.includes(modelName)) {
      setToastMessage(`Model '${modelName}' is already registered for ${provider.displayName}`);
      return;
    }

    const newCustom = [...existingCustom, modelName];
    const newActive = Array.from(new Set([...provider.activeModels, modelName]));

    setProviders((prev) => ({
      ...prev,
      [providerId]: {
        ...prev[providerId],
        customModels: newCustom,
        activeModels: newActive,
      },
    }));

    setCustomModelInput((prev) => ({ ...prev, [providerId]: '' }));

    // Auto save
    setSavingId(providerId);
    try {
      const updated = await updateProvider(providerId, {
        customModels: newCustom,
        activeModels: newActive,
      });
      setProviders((prev) => ({ ...prev, [providerId]: updated }));
      setToastMessage(`Added custom model '${modelName}' to ${provider.displayName}`);
      if (onProvidersUpdated) {
        onProvidersUpdated();
      }
      // Re-fetch registry
      const res = await fetchProviders();
      if (res.modelRegistry) setModelRegistry(res.modelRegistry);
    } catch (err: any) {
      setToastMessage(`Failed to add custom model: ${err?.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const handleRemoveCustomModel = async (providerId: string, modelName: string) => {
    const provider = providers[providerId];
    if (!provider) return;

    const newCustom = (provider.customModels || []).filter((m) => m !== modelName);
    const newActive = provider.activeModels.filter((m) => m !== modelName);

    setProviders((prev) => ({
      ...prev,
      [providerId]: {
        ...prev[providerId],
        customModels: newCustom,
        activeModels: newActive,
      },
    }));

    setSavingId(providerId);
    try {
      const updated = await updateProvider(providerId, {
        customModels: newCustom,
        activeModels: newActive,
      });
      setProviders((prev) => ({ ...prev, [providerId]: updated }));
      setToastMessage(`Removed model '${modelName}' from ${provider.displayName}`);
      if (onProvidersUpdated) {
        onProvidersUpdated();
      }
      const res = await fetchProviders();
      if (res.modelRegistry) setModelRegistry(res.modelRegistry);
    } catch (err: any) {
      setToastMessage(`Failed to remove custom model: ${err?.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const getAvailableModelsFromOtherProviders = (excludedProviderId?: string, excludedModelName?: string): string[] => {
    const validModels = new Set<string>();
    for (const [pId, p] of Object.entries(providers)) {
      if (p.enabled && pId !== excludedProviderId) {
        if (Array.isArray(p.activeModels)) {
          for (const m of p.activeModels) {
            if (m !== excludedModelName) validModels.add(m);
          }
        }
        if (Array.isArray(p.customModels)) {
          for (const m of p.customModels) {
            if (m !== excludedModelName) validModels.add(m);
          }
        }
      }
    }
    for (const [mId, item] of Object.entries(modelRegistry)) {
      if (item.enabled !== false && item.providerId !== excludedProviderId && mId !== excludedModelName) {
        const p = providers[item.providerId];
        if (p && p.enabled) {
          validModels.add(mId);
        }
      }
    }
    return Array.from(validModels);
  };

  const checkAndToggleProviderEnabled = async (providerId: string, nextEnabled: boolean) => {
    const provider = providers[providerId];
    if (!provider) return;

    if (!nextEnabled) {
      const providerModels = new Set<string>([
        ...(provider.activeModels || []),
        ...(provider.customModels || []),
        ...Object.values(modelRegistry)
          .filter((item) => item.providerId === providerId)
          .map((item) => item.id),
      ]);

      const activePersonas = Object.values(personas).filter((p) => p.enabled !== false);
      const impacted = activePersonas.filter((p) => providerModels.has(p.model));

      if (impacted.length > 0) {
        const altModels = getAvailableModelsFromOtherProviders(providerId);
        setImpactedPersonas(impacted);
        setAvailableModelsForRemap(altModels);
        setDisablingTargetName(provider.displayName || providerId);
        setPendingAction({
          type: 'provider',
          providerId,
          patch: { enabled: false },
        });
        setRemappingDialogOpen(true);
        return;
      }
    }

    handleFieldChange(providerId, { enabled: nextEnabled });
  };

  const handleToggleModelActive = (providerId: string, modelName: string) => {
    const provider = providers[providerId];
    if (!provider) return;

    const isActive = provider.activeModels.includes(modelName);
    const newActive = isActive
      ? provider.activeModels.filter((m) => m !== modelName)
      : [...provider.activeModels, modelName];

    if (isActive) {
      const activePersonas = Object.values(personas).filter((p) => p.enabled !== false);
      const impacted = activePersonas.filter((p) => p.model === modelName);

      if (impacted.length > 0) {
        const altModels = getAvailableModelsFromOtherProviders(undefined, modelName);
        setImpactedPersonas(impacted);
        setAvailableModelsForRemap(altModels);
        setDisablingTargetName(`model '${modelName}'`);
        setPendingAction({
          type: 'model',
          providerId,
          modelName,
          patch: { activeModels: newActive },
        });
        setRemappingDialogOpen(true);
        return;
      }
    }

    handleFieldChange(providerId, { activeModels: newActive });
  };

  const handleConfirmRemap = async (remappedPersonas: Record<string, string>) => {
    if (!pendingAction) return;
    setSavingId(pendingAction.providerId);
    try {
      if (pendingAction.type === 'provider') {
        await remapPersonasAndDisableProvider(remappedPersonas, pendingAction.providerId, {
          enabled: false,
        });
        setProviders((prev) => ({
          ...prev,
          [pendingAction.providerId]: {
            ...prev[pendingAction.providerId],
            enabled: false,
          },
        }));
      } else if (pendingAction.type === 'model' && pendingAction.patch) {
        for (const [personaId, newModel] of Object.entries(remappedPersonas)) {
          await updatePersona(personaId, { model: newModel });
        }
        const updated = await updateProvider(pendingAction.providerId, pendingAction.patch);
        setProviders((prev) => ({ ...prev, [pendingAction.providerId]: updated }));
      }
      setToastMessage(`Remapped impacted persona(s) and disabled ${disablingTargetName}`);
      await loadProviderData();
      if (onProvidersUpdated) onProvidersUpdated();
    } catch (err: any) {
      setToastMessage(`Failed to disable and remap: ${err?.message}`);
    } finally {
      setSavingId(null);
      setPendingAction(null);
    }
  };

  const allProviderKeys = Array.from(
    new Set([...TARGET_PROVIDER_IDS, ...Object.keys(providers)])
  );

  if (loading && Object.keys(providers).length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-3">
        <RefreshCw className="h-5 w-5 animate-spin text-indigo-400" />
        <span>Loading AI Providers &amp; Model Registries...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {toastMessage && (
        <div
          id="provider-toast"
          className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 flex items-center justify-between"
        >
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="text-indigo-400 hover:text-white font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Provider Configurations Grid */}
      <div>
        <div className="mb-4">
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Cpu className="h-5 w-5 text-indigo-400" />
            AI Provider Credentials &amp; Infrastructure Endpoints
          </h3>
          <p className="text-xs text-muted-foreground">
            Configure API keys, base URLs, subscription tiers, and active status for all supported provider families
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {allProviderKeys.map((id) => {
            const provider = providers[id] || {
              id,
              displayName: id.toUpperCase(),
              enabled: false,
              baseUrl: DEFAULT_BASE_URLS[id] || '',
              subscriptionTier: 'pay-as-you-go',
              activeModels: [],
              customModels: [],
              updatedAt: new Date().toISOString(),
            };

            const testResult = testResults[id];
            const isTesting = testingId === id;
            const isSaving = savingId === id;
            const icon = PROVIDER_ICONS[id] || '⚙️';
            const supportsCustom = id === 'ollama' || id === 'custom-openai' || id === 'openai' || id === 'deepseek';

            return (
              <Card
                key={id}
                className={`glass-panel border-border/80 flex flex-col justify-between transition-all ${
                  provider.enabled ? 'border-indigo-500/40 bg-indigo-950/10' : 'opacity-85'
                }`}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{icon}</span>
                      <CardTitle className="text-sm font-bold">{provider.displayName}</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={provider.enabled ? 'success' : 'secondary'}
                        className="text-[10px] uppercase font-semibold px-2 py-0.5"
                      >
                        {provider.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                      <Button
                        variant={provider.enabled ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          const nextEnabled = !provider.enabled;
                          checkAndToggleProviderEnabled(id, nextEnabled);
                        }}
                        className="h-6 text-[10px] px-2"
                      >
                        {provider.enabled ? 'Active' : 'Enable'}
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="text-[11px] font-mono text-muted-foreground">
                    ID: {id}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3.5 text-xs flex-1">
                  {/* API Key Input */}
                  {id !== 'glm' && (
                    <div>
                      <label className="text-[11px] font-semibold text-muted-foreground block mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Key className="h-3 w-3 text-indigo-400" />
                          API Key / Secret Token
                        </span>
                        {provider.apiKeyMasked && (
                          <span className="text-[10px] font-mono text-emerald-400">
                            Stored: {provider.apiKeyMasked}
                          </span>
                        )}
                      </label>
                      <div className="relative flex items-center">
                        <Input
                          type={showKeys[id] ? 'text' : 'password'}
                          placeholder={provider.apiKeyMasked || 'Enter API Key (sk-...)'}
                          value={rawApiKeys[id] !== undefined ? rawApiKeys[id] : ''}
                          onChange={(e) =>
                            setRawApiKeys((prev) => ({ ...prev, [id]: e.target.value }))
                          }
                          className="font-mono text-xs pr-8 bg-background/80"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShowKey(id)}
                          className="absolute right-2 text-muted-foreground hover:text-foreground"
                          title="Toggle visibility"
                        >
                          {showKeys[id] ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Base URL Input */}
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1 flex items-center gap-1">
                      <Globe className="h-3 w-3 text-purple-400" />
                      API Base URL
                    </label>
                    <Input
                      type="text"
                      placeholder={DEFAULT_BASE_URLS[id] || 'https://api.example.com/v1'}
                      value={provider.baseUrl || ''}
                      onChange={(e) => handleFieldChange(id, { baseUrl: e.target.value })}
                      className="font-mono text-xs bg-background/80"
                    />
                  </div>

                  {/* Subscription Tier Selector */}
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-400" />
                      Subscription Tier
                    </label>
                    <Select
                      value={provider.subscriptionTier || 'pay-as-you-go'}
                      onValueChange={(tier: any) => handleFieldChange(id, { subscriptionTier: tier })}
                    >
                      <SelectTrigger className="text-xs bg-background/80 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="free">Free / Community</SelectItem>
                        <SelectItem value="pay-as-you-go">Pay-as-you-go</SelectItem>
                        <SelectItem value="pro">Pro (Tier 1-2)</SelectItem>
                        <SelectItem value="team">Team (Tier 3-4)</SelectItem>
                        <SelectItem value="enterprise">Enterprise (Tier 5)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Custom Model Management for Ollama/Custom OpenAI */}
                  {supportsCustom && (
                    <div className="pt-2 border-t border-border/40 space-y-2">
                      <label className="text-[11px] font-semibold text-muted-foreground block">
                        Add Custom Model Name
                      </label>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          placeholder="e.g. llama3.3:70b, my-model-v1"
                          value={customModelInput[id] || ''}
                          onChange={(e) =>
                            setCustomModelInput((prev) => ({ ...prev, [id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddCustomModel(id);
                          }}
                          className="font-mono text-xs bg-background/80 h-8 flex-1"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAddCustomModel(id)}
                          className="h-8 text-xs px-2.5 shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add
                        </Button>
                      </div>

                      {provider.customModels && provider.customModels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {provider.customModels.map((customName) => (
                            <span
                              key={customName}
                              className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                            >
                              {customName}
                              <button
                                onClick={() => handleRemoveCustomModel(id, customName)}
                                className="text-indigo-400 hover:text-red-400 ml-0.5"
                                title="Remove custom model"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Connection Test Output Badge */}
                  {testResult && (
                    <div
                      className={`p-2 rounded text-[11px] flex items-center gap-2 border ${
                        testResult.success
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {testResult.success ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
                      )}
                      <div className="flex-1 truncate">
                        <span>{testResult.message}</span>
                        {testResult.latencyMs !== undefined && (
                          <span className="font-mono text-[10px] ml-1.5 opacity-80">
                            ({testResult.latencyMs}ms)
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Footer Actions */}
                  <div className="pt-2 flex items-center justify-between gap-2 border-t border-border/40">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestConnection(id)}
                      disabled={isTesting}
                      className="h-7 text-[11px] px-2.5 text-muted-foreground hover:text-foreground"
                    >
                      {isTesting ? (
                        <RefreshCw className="h-3 w-3 animate-spin mr-1 text-indigo-400" />
                      ) : (
                        <Zap className="h-3 w-3 mr-1 text-amber-400" />
                      )}
                      Test Connection
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleSaveProvider(id)}
                      disabled={isSaving}
                      className="h-7 text-[11px] px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
                    >
                      {isSaving ? 'Saving...' : 'Save Provider'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Model Registry Controls & Table */}
      <Card className="glass-panel border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-bold text-foreground">
            <Layers className="h-5 w-5 text-purple-400" />
            Global AI Model Registry &amp; Cost Control Table
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Manage available models, context window token caps, and cost per 1k prompt/completion tokens. Enabled models dynamically populate reviewer persona selection dropdowns.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-border/60">
                <TableHead className="text-xs font-bold text-foreground">Model ID &amp; Name</TableHead>
                <TableHead className="text-xs font-bold text-foreground">Provider</TableHead>
                <TableHead className="text-xs font-bold text-foreground">Context Window</TableHead>
                <TableHead className="text-xs font-bold text-foreground">Cost / 1k Tokens (Prompt/Completion)</TableHead>
                <TableHead className="text-xs font-bold text-foreground text-center">Active Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.values(modelRegistry).map((model) => {
                const provider = providers[model.providerId];
                const isModelActive = provider?.activeModels.includes(model.id) ?? model.enabled;

                return (
                  <TableRow key={model.id} className="hover:bg-accent/30">
                    <TableCell className="font-mono text-xs font-semibold text-foreground">
                      <div className="flex items-center gap-2">
                        <span>{model.displayName || model.id}</span>
                        {model.isCustom && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-indigo-400 text-indigo-400">
                            Custom
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-normal block">{model.id}</span>
                    </TableCell>

                    <TableCell>
                      <Badge variant="secondary" className="text-[10px] uppercase font-mono">
                        {model.providerId}
                      </Badge>
                    </TableCell>

                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {model.contextWindowTokens
                        ? `${(model.contextWindowTokens / 1000).toLocaleString()}k tokens`
                        : 'Default (128k)'}
                    </TableCell>

                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {model.costPer1kPromptUSD !== undefined && model.costPer1kPromptUSD > 0 ? (
                        <span>
                          ${model.costPer1kPromptUSD.toFixed(5)} / ${model.costPer1kCompletionUSD?.toFixed(5)}
                        </span>
                      ) : (
                        <span className="text-emerald-400 font-semibold">Free / Synthetic</span>
                      )}
                    </TableCell>

                    <TableCell className="text-center">
                      <Button
                        variant={isModelActive ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleToggleModelActive(model.providerId, model.id)}
                        className={`h-6 text-[10px] px-2.5 ${
                          isModelActive ? 'bg-indigo-600 hover:bg-indigo-500' : 'text-muted-foreground'
                        }`}
                      >
                        {isModelActive ? 'Active' : 'Disabled'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ModelRemappingDialog
        open={remappingDialogOpen}
        onOpenChange={setRemappingDialogOpen}
        impactedPersonas={impactedPersonas}
        availableModels={availableModelsForRemap}
        disablingTargetName={disablingTargetName}
        onConfirm={handleConfirmRemap}
      />
    </div>
  );
}
