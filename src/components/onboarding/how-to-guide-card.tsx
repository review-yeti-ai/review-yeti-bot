'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { ManifestDrawer } from './manifest-drawer';
import {
  HelpCircle,
  BookOpen,
  Key,
  FileCode,
  Shield,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Info,
  DollarSign,
  Layers,
} from 'lucide-react';

export const PROVIDER_GUIDES = [
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    orgUrl: 'https://platform.openai.com/account/organization',
    keyFormat: 'sk-proj-... or sk-...',
    steps: [
      'Navigate to OpenAI Platform (platform.openai.com) and log in.',
      'Go to API Keys under User Settings and click "Create new secret key".',
      'For Organization ID, check Settings -> Organization in your OpenAI dashboard.',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    url: 'https://console.anthropic.com/settings/keys',
    keyFormat: 'sk-ant-api03-...',
    steps: [
      'Log into the Anthropic Console (console.anthropic.com).',
      'Select your Workspace and navigate to API Keys.',
      'Click "Create Key", assign a name (e.g. CT-Review-Bot), and copy the key.',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    url: 'https://aistudio.google.com/app/apikey',
    keyFormat: 'AIzaSy...',
    steps: [
      'Open Google AI Studio (aistudio.google.com).',
      'Click "Get API Key" or "Create API Key in new project".',
      'Copy the generated key into the Gemini provider field.',
    ],
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    url: 'https://console.x.ai',
    keyFormat: 'xai-...',
    steps: [
      'Log in to the xAI Console (console.x.ai).',
      'Navigate to API Keys and click "Create API Key".',
      'Select model scopes (Grok-2 / Grok-4.5) and copy the API key.',
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://platform.deepseek.com/api_keys',
    keyFormat: 'sk-...',
    steps: [
      'Visit DeepSeek Open Platform (platform.deepseek.com).',
      'Go to API Keys section and create a new key.',
      'DeepSeek V3 and DeepSeek R1 reasoning models use standard OpenAI compatible format.',
    ],
  },
  {
    id: 'glm',
    name: 'Zhipu GLM',
    url: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyFormat: 'id.secret',
    steps: [
      'Access Zhipu AI BigModel Platform (open.bigmodel.cn).',
      'View your API key from the User Center API Keys tab.',
      'Set Base URL to https://open.bigmodel.cn/api/paas/v4.',
    ],
  },
  {
    id: 'doppler',
    name: 'Doppler Secret Vault',
    url: 'https://dashboard.doppler.com',
    keyFormat: 'dp.pt....',
    steps: [
      'Log into Doppler Secret Manager dashboard.',
      'Generate a Service Token for your project environment.',
      'CT Review Bot will automatically fetch and rotate secret provider keys from Doppler.',
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama Local Engine',
    url: 'https://ollama.com',
    keyFormat: 'Not required (Local localhost:11434)',
    steps: [
      'Install and start Ollama locally (`ollama serve`).',
      'Pull required models: `ollama pull llama3:8b` or `ollama pull codellama`.',
      'Set Base URL to `http://localhost:11434/v1` or internal docker bridge URL.',
    ],
  },
  {
    id: 'custom_openai',
    name: 'Custom OpenAI-Compatible',
    url: 'https://github.com/vllm-project/vllm',
    keyFormat: 'Custom bearer token or sk-custom-...',
    steps: [
      'Deploy vLLM, LocalAI, LM Studio, or Enterprise AI gateway with OpenAI schema.',
      'Specify the endpoint Base URL (e.g. `https://ai.internal.mycompany.com/v1`).',
      'Provide your custom API bearer token or secret header.',
    ],
  },
  {
    id: 'codex',
    name: 'Codex AI Engine',
    url: 'https://codex.calltelemetry.com',
    keyFormat: 'cx-...',
    steps: [
      'CallTelemetry internal high-throughput code review engine.',
      'Obtain API credentials from CallTelemetry Enterprise Portal.',
    ],
  },
  {
    id: 'agy_thinking',
    name: 'AGY Thinking Engine',
    url: 'https://agy.calltelemetry.com',
    keyFormat: 'agy-...',
    steps: [
      'Antigravity deep reasoning cluster for complex architectural arbitration.',
      'Use AGY token or service account key for 256k context reasoning.',
    ],
  },
];

export function HowToGuideCard() {
  const [activeGuideTab, setActiveGuideTab] = React.useState('github_app');
  const [selectedProviderId, setSelectedProviderId] = React.useState('openai');
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const currentProvider = PROVIDER_GUIDES.find((p) => p.id === selectedProviderId) || PROVIDER_GUIDES[0];

  const sampleManifestSnippet = `{
  "name": "ct-review-bot-app",
  "url": "https://github.com/calltelemetry",
  "hook_attributes": {
    "url": "https://api.calltelemetry.com/api/webhooks/github",
    "active": true
  },
  "default_permissions": {
    "pull_requests": "write",
    "issues": "write",
    "contents": "read",
    "checks": "write"
  }
}`;

  return (
    <Card className="border-border/60 bg-card/80 backdrop-blur-xl shadow-lg">
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-bold flex items-center gap-2">
                Onboarding How-To Guides &amp; Documentation
                <Badge variant="outline" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30 text-[10px]">
                  Interactive Help
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Step-by-step guides for GitHub App creation, API keys, and OmniRoute provider cost management.
              </CardDescription>
            </div>
          </div>

          <Button
            onClick={() => setDrawerOpen(true)}
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs font-semibold border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10"
          >
            <FileCode className="h-3.5 w-3.5" />
            Manifest Drawer
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-6 space-y-6">
        <Tabs value={activeGuideTab} onValueChange={setActiveGuideTab} className="space-y-4">
          <TabsList className="bg-muted/50 p-1 border border-border/40 w-full justify-start overflow-x-auto">
            <TabsTrigger value="github_app" className="text-xs font-semibold gap-2">
              <Shield className="h-3.5 w-3.5 text-indigo-400" />
              1. GitHub App Registration
            </TabsTrigger>
            <TabsTrigger value="api_keys" className="text-xs font-semibold gap-2">
              <Key className="h-3.5 w-3.5 text-amber-400" />
              2. Finding API Keys &amp; Org IDs
            </TabsTrigger>
            <TabsTrigger value="cost_caps" className="text-xs font-semibold gap-2">
              <DollarSign className="h-3.5 w-3.5 text-emerald-400" />
              3. OmniRoute &amp; Spending Caps
            </TabsTrigger>
          </TabsList>

          {/* Guide 1: GitHub App Creation */}
          <TabsContent value="github_app" className="space-y-4">
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Shield className="h-4 w-4 text-indigo-400" />
                How to Register a GitHub App for your Organization
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                CT Review Bot integrates with GitHub using an official GitHub App. This provides fine-grained permissions, webhook security, and high API rate limits (5,000 req/hr per installation).
              </p>

              <div className="space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-[11px] font-bold text-indigo-400">1</span>
                  <span>
                    Open your GitHub Organization Settings: <code>https://github.com/organizations/YOUR_ORG/settings/apps/new</code>
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-[11px] font-bold text-indigo-400">2</span>
                  <span>
                    Fill in GitHub App Name (e.g. <code>ct-review-bot-app</code>) and set Webhook Target URL to <code>https://api.calltelemetry.com/api/webhooks/github</code>.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-[11px] font-bold text-indigo-400">3</span>
                  <span>
                    Set Permissions: Pull Requests (Write), Issues (Write), Checks (Write), Contents (Read).
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-[11px] font-bold text-indigo-400">4</span>
                  <span>
                    Generate and download the <strong>Private Key (.pem file)</strong>, then copy the <strong>App ID</strong> and <strong>Installation ID</strong> back into Step 1 of this wizard.
                  </span>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between border-t border-border/40">
                <span className="text-[11px] text-muted-foreground font-mono">Quick Manifest JSON snippet:</span>
                <div className="flex items-center gap-2">
                  <CopyButton value={sampleManifestSnippet} label="Copy Snippet" size="sm" />
                  <Button
                    onClick={() => setDrawerOpen(true)}
                    size="sm"
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
                  >
                    Open Manifest Generator Drawer
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Guide 2: Finding API Keys */}
          <TabsContent value="api_keys" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Left Column: Provider List Selector */}
              <div className="space-y-1 bg-muted/30 p-2 rounded-xl border border-border/60 max-h-[320px] overflow-y-auto">
                <span className="text-[11px] font-semibold text-muted-foreground px-2 py-1 block">
                  Select Provider (11 OmniRoute):
                </span>
                {PROVIDER_GUIDES.map((prov) => (
                  <button
                    key={prov.id}
                    onClick={() => setSelectedProviderId(prov.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-between ${
                      selectedProviderId === prov.id
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <span>{prov.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 opacity-70" />
                  </button>
                ))}
              </div>

              {/* Right Column: Step-by-Step Instructions */}
              <div className="md:col-span-2 rounded-xl border border-border/60 bg-muted/20 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Key className="h-4 w-4 text-amber-400" />
                    {currentProvider.name} Credentials Guide
                  </h4>
                  <a
                    href={currentProvider.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-indigo-400 hover:underline flex items-center gap-1 font-medium"
                  >
                    Open Console <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                <div className="p-2.5 rounded-lg bg-background/60 border border-border/40 text-xs font-mono text-muted-foreground">
                  Expected Key Format: <strong className="text-foreground">{currentProvider.keyFormat}</strong>
                </div>

                <div className="space-y-2 text-xs">
                  <span className="font-semibold text-foreground block">Steps to retrieve API Key:</span>
                  {currentProvider.steps.map((step, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[11px] font-bold text-amber-400">
                        {idx + 1}
                      </span>
                      <span className="text-muted-foreground leading-relaxed">{step}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Guide 3: OmniRoute Provider & Cost Cap Guidance */}
          <TabsContent value="cost_caps" className="space-y-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-emerald-400" />
                OmniRoute Provider Failover &amp; Spending Cap Guidance
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                OmniRoute automatically distributes PR review workloads across all configured AI models (Anthropic, OpenAI, Grok, DeepSeek, GLM, Gemini) while respecting monthly spending caps.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg border border-border/40 bg-background/50 space-y-1">
                  <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5" />
                    Automatic Failover Chain
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    If Anthropic or OpenAI experiences rate limits or downtime, OmniRoute automatically shifts reasoning to DeepSeek or Grok without failing the pull request review.
                  </p>
                </div>

                <div className="p-3 rounded-lg border border-border/40 bg-background/50 space-y-1">
                  <span className="font-semibold text-amber-400 flex items-center gap-1.5">
                    <DollarSign className="h-3.5 w-3.5" />
                    Spending Cap Safeguard
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    When monthly usage hits 80% of your budget limit, CT Review Bot sends an alert. At 100%, non-critical personas switch to lightweight fast models (e.g. GPT-4o-mini).
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>

      <ManifestDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </Card>
  );
}
