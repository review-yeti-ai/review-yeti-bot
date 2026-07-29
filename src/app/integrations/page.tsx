'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Blocks, RefreshCw } from 'lucide-react';
import { IntegrationsGrid } from '@/components/integrations/integrations-grid';
import { fetchIntegrations, fetchMcpServers } from '@/lib/api-client';
import { IntegrationItem, McpServerConfig } from '@/types/dashboard';

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = React.useState<IntegrationItem[]>([]);
  const [mcpServers, setMcpServers] = React.useState<McpServerConfig[]>([]);
  const [loading, setLoading] = React.useState(true);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [integRes, mcpRes] = await Promise.allSettled([
        fetchIntegrations(),
        fetchMcpServers(),
      ]);
      if (integRes.status === 'fulfilled') setIntegrations(integRes.value);
      if (mcpRes.status === 'fulfilled') setMcpServers(mcpRes.value);
    } catch {
      // Fallback defaults in grid
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Integrations Panel & MCP Fleet
          </h2>
          <p className="text-sm text-muted-foreground">
            Doppler secret manager, Sentry error tracking, Jira software, Slack webhooks, Linear, GitHub App, and MCP server fleet management
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="gap-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <IntegrationsGrid integrations={integrations} mcpServers={mcpServers} />
    </div>
  );
}
