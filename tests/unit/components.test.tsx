// @vitest-environment jsdom
// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/layout/status-badge';
import { Topbar } from '@/components/layout/topbar';
import { Sidebar } from '@/components/layout/sidebar';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

describe('Shadcn & Layout Component Primitives (Milestone 1)', () => {
  it('renders Button with variants and handles click events', () => {
    const handleClick = vi.fn();
    render(
      <Button variant="destructive" onClick={handleClick}>
        Delete Persona
      </Button>
    );

    const btn = screen.getByRole('button', { name: /delete persona/i });
    expect(btn).toBeDefined();
    expect(btn.className).toContain('bg-destructive');
    btn.click();
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders Badge with custom variants', () => {
    render(<Badge variant="success">Milestone 1 Pass</Badge>);
    const badge = screen.getByText('Milestone 1 Pass');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-emerald-500/15');
  });

  it('renders StatusBadge with pulsing live status', () => {
    render(<StatusBadge status="live" label="Streaming Live" />);
    const statusText = screen.getByText('Streaming Live');
    expect(statusText).toBeDefined();
  });

  it('renders Topbar with page title and live status indicator', () => {
    render(
      <Topbar title="Overview Dashboard" description="System metrics and persona status" />
    );
    expect(screen.getByText('Overview Dashboard')).toBeDefined();
    expect(screen.getByText('System metrics and persona status')).toBeDefined();
  });

  it('renders Sidebar with full navigation links', () => {
    render(<Sidebar />);
    expect(screen.getByText('ct-review-bot')).toBeDefined();
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Live Stream')).toBeDefined();
    expect(screen.getByText('Repositories')).toBeDefined();
    expect(screen.getByText('Persona Editor')).toBeDefined();
    expect(screen.getByText('Integrations')).toBeDefined();
    expect(screen.getByText('GitHub App')).toBeDefined();
  });
});
