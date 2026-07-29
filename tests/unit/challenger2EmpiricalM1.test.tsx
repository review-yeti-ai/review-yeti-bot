// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/layout/status-badge';
import { Topbar } from '@/components/layout/topbar';
import { Sidebar } from '@/components/layout/sidebar';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';

// Mock next/navigation
let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

describe('Empirical Challenger 2 — Milestone 1 Overhaul Edge Case & Utility Suite', () => {
  describe('1. Missing / Empty Optional Props Edge Cases', () => {
    it('renders Topbar cleanly when all optional props are omitted or undefined', () => {
      mockPathname = '/';
      const { container } = render(<Topbar />);
      expect(screen.getByText('Overview Dashboard')).toBeDefined();
      expect(screen.getByText('Real-time review metrics, pass rates, and active persona status')).toBeDefined();
      expect(screen.getAllByText('Live Stream').length).toBeGreaterThan(0);
      expect(container.querySelector('header')).toBeDefined();
    });

    it('renders Topbar with fallback values when given an unknown pathname', () => {
      mockPathname = '/unknown-route';
      render(<Topbar />);
      expect(screen.getByText('ct-review-bot')).toBeDefined();
      expect(screen.getByText('Persona Panel Dashboard')).toBeDefined();
    });

    it('renders Topbar with custom title and description overriding route defaults', () => {
      mockPathname = '/';
      render(
        <Topbar title="Custom Security Header" description="Custom Audit Description" />
      );
      expect(screen.getByText('Custom Security Header')).toBeDefined();
      expect(screen.getByText('Custom Audit Description')).toBeDefined();
    });

    it('renders StatusBadge with default values when status, label, and pulse are undefined', () => {
      const { container } = render(<StatusBadge />);
      expect(screen.getByText('Live Stream')).toBeDefined();
      const dot = container.querySelector('.bg-emerald-500');
      expect(dot).not.toBeNull();
    });

    it('renders StatusBadge correctly for all supported status types', () => {
      const statuses = ['live', 'online', 'busy', 'idle', 'offline', 'error'] as const;
      for (const status of statuses) {
        const { unmount } = render(<StatusBadge status={status} />);
        unmount();
      }
    });

    it('renders StatusBadge with custom label and showPulse=false without crashing', () => {
      const { container } = render(
        <StatusBadge status="busy" label="Processing 11 Personas" showPulse={false} />
      );
      expect(screen.getByText('Processing 11 Personas')).toBeDefined();
      expect(container.querySelector('.status-pulse')).toBeNull();
    });

    it('renders Card components when children or props are empty', () => {
      const { container } = render(
        <Card>
          <CardHeader>
            <CardTitle />
            <CardDescription />
          </CardHeader>
          <CardContent />
          <CardFooter />
        </Card>
      );
      expect(container.querySelector('.rounded-xl')).not.toBeNull();
    });

    it('renders Sidebar gracefully on root and deep path names', () => {
      mockPathname = '/settings';
      render(<Sidebar />);
      expect(screen.getByText('ct-review-bot')).toBeDefined();
      expect(screen.getByText('Persona Editor')).toBeDefined();
    });
  });

  describe('2. CSS Class Overrides & Merge Behavior via cn()', () => {
    it('overrides background and padding classes via twMerge in cn()', () => {
      const merged = cn('bg-red-500 p-4 text-white', 'bg-blue-600 p-8');
      expect(merged).toContain('bg-blue-600');
      expect(merged).not.toContain('bg-red-500');
      expect(merged).toContain('p-8');
      expect(merged).not.toContain('p-4');
      expect(merged).toContain('text-white');
    });

    it('handles boolean conditions, null, undefined, and empty string inputs in cn()', () => {
      const isError = true;
      const isSuccess = false;
      const result = cn(
        'base-class',
        isError && 'border-rose-500',
        isSuccess && 'border-emerald-500',
        null,
        undefined,
        '',
        ['nested-class-1', false && 'nested-class-2']
      );
      expect(result).toBe('base-class border-rose-500 nested-class-1');
    });

    it('allows custom className overrides on Button component', () => {
      render(
        <Button className="px-12 bg-amber-500 hover:bg-amber-600">Custom Button</Button>
      );
      const btn = screen.getByRole('button', { name: /custom button/i });
      expect(btn.className).toContain('px-12');
      expect(btn.className).toContain('bg-amber-500');
      expect(btn.className).not.toContain('px-4'); // overridden default size px-4
    });

    it('allows custom className overrides on Badge component', () => {
      render(
        <Badge variant="destructive" className="uppercase font-bold tracking-widest">
          Critical
        </Badge>
      );
      const badge = screen.getByText('Critical');
      expect(badge.className).toContain('bg-destructive');
      expect(badge.className).toContain('uppercase');
      expect(badge.className).toContain('tracking-widest');
    });
  });

  describe('3. Dark Mode Variable & CSS Glassmorphism Integration', () => {
    it('verifies globals.css contains required HSL dark mode CSS custom properties', () => {
      const cssPath = path.join(process.cwd(), 'src/app/globals.css');
      expect(fs.existsSync(cssPath)).toBe(true);
      const css = fs.readFileSync(cssPath, 'utf8');

      const expectedVariables = [
        '--background',
        '--foreground',
        '--card',
        '--card-foreground',
        '--popover',
        '--popover-foreground',
        '--primary',
        '--primary-foreground',
        '--secondary',
        '--secondary-foreground',
        '--muted',
        '--muted-foreground',
        '--accent',
        '--accent-foreground',
        '--destructive',
        '--destructive-foreground',
        '--border',
        '--input',
        '--ring',
        '--radius',
      ];

      for (const variable of expectedVariables) {
        expect(css).toContain(variable);
      }
    });

    it('verifies globals.css includes glassmorphism utility classes (.glass-panel, .glass-hover, .glass-terminal)', () => {
      const cssPath = path.join(process.cwd(), 'src/app/globals.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      expect(css).toContain('.glass-panel');
      expect(css).toContain('.glass-hover');
      expect(css).toContain('.glass-terminal');
      expect(css).toContain('backdrop-filter: blur');
      expect(css).toContain('status-pulse');
    });

    it('verifies tailwind.config.js maps darkMode: ["class"] and color extensions to HSL variables', () => {
      const configPath = path.join(process.cwd(), 'tailwind.config.js');
      expect(fs.existsSync(configPath)).toBe(true);
      const configText = fs.readFileSync(configPath, 'utf8');

      expect(configText).toContain("darkMode: ['class']");
      expect(configText).toContain("'hsl(var(--background))'");
      expect(configText).toContain("'hsl(var(--card))'");
      expect(configText).toContain("'hsl(var(--primary))'");
      expect(configText).toContain("plugins: [require('tailwindcss-animate')]");
    });
  });
});
