'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PersonaSetting } from '@/types/dashboard';
import { ALL_PERSONA_IDS, PERSONA_METADATA } from '@/components/settings/persona-selector';

interface PersonaStatusGridProps {
  personas?: Record<string, PersonaSetting>;
}

export function PersonaStatusGrid({ personas }: PersonaStatusGridProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          Reviewer Personas & Model Ensembles (11 Active)
        </h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {ALL_PERSONA_IDS.map((id) => {
          const meta = PERSONA_METADATA[id];
          const Icon = meta.icon;
          const p = personas?.[id];
          const isEnabled = p ? p.enabled : true;

          return (
            <Card key={id} className="glass-panel border-border/70 p-3 hover:border-indigo-500/50 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-md bg-background/80 ${meta.color}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-xs font-semibold text-foreground truncate max-w-[130px]">
                    {p?.displayName || meta.name}
                  </span>
                </div>
                <Badge variant={isEnabled ? 'success' : 'secondary'} className="text-[9px] py-0 px-1">
                  {isEnabled ? 'Active' : 'Disabled'}
                </Badge>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/40">
                <span className="font-mono">{p?.model || 'claude-3-5-sonnet'}</span>
                <span className="capitalize">Effort: <strong className="text-foreground">{p?.effort || 'low'}</strong></span>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
