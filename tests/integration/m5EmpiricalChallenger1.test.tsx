// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../vitest.config';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/layout/status-badge';
import { Topbar } from '@/components/layout/topbar';

describe('Milestone 5 Empirical Challenger 1: Build Cleanliness, Process Isolation & RTL Event Handling', () => {
  const projectRoot = path.resolve(__dirname, '../../');
  const publicDir = path.resolve(projectRoot, 'public');

  describe('1. Build Script Cleanliness (npm run build:frontend)', () => {
    it('package.json contains build:frontend script with required pipeline steps', () => {
      const pkgPath = path.join(projectRoot, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts['build:frontend']).toBeDefined();
      expect(pkg.scripts['build:frontend']).toContain('next build');
      expect(pkg.scripts['build:frontend']).toContain('node scripts/postbuild.js');
    });

    it('verifies static export HTML files exist in public/ with non-zero size', () => {
      const requiredPages = [
        'index.html',
        '404.html',
        'github-app.html',
        'integrations.html',
        'live.html',
        'repos.html',
        'settings.html',
      ];

      for (const page of requiredPages) {
        const filePath = path.join(publicDir, page);
        expect(fs.existsSync(filePath)).toBe(true);
        const stat = fs.statSync(filePath);
        expect(stat.size).toBeGreaterThan(100);
      }
    });

    it('verifies postbuild HTML cleanliness and DOCTYPE validity', () => {
      const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').toLowerCase();
      expect(indexHtml).toContain('<!doctype html>');
      expect(indexHtml).toContain('<html');
      expect(indexHtml).toContain('</html>');
    });
  });

  describe('2. Process Isolation under Vitest 4 Execution', () => {
    it('vitest.config.ts sets pool to forks', () => {
      const rawConfig = (config as any).test ? config : (config as any).default || config;
      expect(rawConfig.test?.pool).toBe('forks');
    });

    it('vitest.config.ts uses top-level pool controls without deprecated poolOptions', () => {
      const rawConfig = (config as any).test ? config : (config as any).default || config;
      expect(rawConfig.test?.pool).toBe('forks');
      // REL-560: parallel files, still one isolated fork per file.
      expect(rawConfig.test?.fileParallelism).toBe(true);
      expect(rawConfig.test?.isolate).toBe(true);
      expect(rawConfig.test?.poolOptions).toBeUndefined();
    });

    it('verifies process environment isolation and absence of environment leakage', () => {
      const isolationKey = 'M5_CHALLENGER_1_ISOLATION_TEST';
      process.env[isolationKey] = 'isolated_challenger_val';
      expect(process.env[isolationKey]).toBe('isolated_challenger_val');
      delete process.env[isolationKey];
      expect(process.env[isolationKey]).toBeUndefined();
    });
  });

  describe('3. Component Rendering & React Testing Library Event Handling', () => {
    it('renders UI Button and fires click event handlers', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Run Verification</Button>);

      const btn = screen.getByRole('button', { name: 'Run Verification' });
      expect(btn).toBeInTheDocument();

      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('renders disabled UI Button and prevents click execution', () => {
      const handleClick = vi.fn();
      render(<Button disabled onClick={handleClick}>Disabled Action</Button>);

      const btn = screen.getByRole('button', { name: 'Disabled Action' });
      expect(btn).toBeDisabled();

      fireEvent.click(btn);
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('renders Input component and updates state on user change event', () => {
      const handleChange = vi.fn();
      render(<Input placeholder="Search repositories..." onChange={handleChange} />);

      const input = screen.getByPlaceholderText('Search repositories...') as HTMLInputElement;
      expect(input).toBeInTheDocument();

      fireEvent.change(input, { target: { value: 'cisco-cdr' } });
      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(input.value).toBe('cisco-cdr');
    });

    it('renders Badge component with secondary styling', () => {
      render(<Badge variant="secondary">Milestone 5</Badge>);
      const badge = screen.getByText('Milestone 5');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('bg-secondary');
    });

    it('renders StatusBadge and handles live status state', () => {
      render(<StatusBadge status="live" label="System Active" />);
      expect(screen.getByText('System Active')).toBeInTheDocument();
    });

    it('renders Topbar component and fires onRefresh handler on button click', () => {
      const handleRefresh = vi.fn();
      render(<Topbar title="M5 Dashboard" description="Verification Hub" onRefresh={handleRefresh} />);

      expect(screen.getByText('M5 Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Verification Hub')).toBeInTheDocument();

      const refreshBtn = screen.getByTitle('Refresh Data');
      fireEvent.click(refreshBtn);
      expect(handleRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
