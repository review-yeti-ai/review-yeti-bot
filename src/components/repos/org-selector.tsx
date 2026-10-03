'use client';

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Building2, Users } from 'lucide-react';
import { fetchGitHubOrgs } from '@/lib/api-client';
import { GitHubOrganizationSummary } from '@/types/dashboard';

export interface OrgSelectorProps {
  selectedOrg: string;
  onSelectOrg: (org: string) => void;
  className?: string;
}

export function OrgSelector({ selectedOrg, onSelectOrg, className }: OrgSelectorProps) {
  const [organizations, setOrganizations] = React.useState<GitHubOrganizationSummary[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let mounted = true;
    if (typeof fetchGitHubOrgs !== 'function') {
      setLoading(false);
      return;
    }
    fetchGitHubOrgs()
      .then((orgs) => {
        if (mounted) {
          setOrganizations(orgs || []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      <Building2 className="h-4 w-4 text-muted-foreground" />
      <Select
        value={selectedOrg || '__all__'}
        onValueChange={(val) => onSelectOrg(val === '__all__' ? '' : val)}
        disabled={loading}
      >
        <SelectTrigger className="w-[240px] h-9 text-xs bg-card border-border/80">
          <SelectValue placeholder="Select Organization" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">
            <div className="flex items-center justify-between w-full gap-2">
              <span className="font-medium">All Organizations</span>
            </div>
          </SelectItem>
          {organizations.map((org) => (
            <SelectItem key={org.login} value={org.login}>
              <div className="flex items-center justify-between w-full gap-3">
                <div className="flex items-center gap-2">
                  {org.avatarUrl ? (
                    <img
                      src={org.avatarUrl}
                      alt={org.login}
                      className="w-4 h-4 rounded-full border border-border/60"
                    />
                  ) : (
                    <Users className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground">{org.name || org.login}</span>
                </div>
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-muted font-mono">
                  {org.monitoredCount}/{org.totalReposCount}
                </Badge>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
