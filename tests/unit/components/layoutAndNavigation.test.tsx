// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { StatusBadge } from '@/components/layout/status-badge';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/live',
}));

describe('Layout and Navigation Components Unit Tests', () => {
  describe('Sidebar Component', () => {
    it('renders sidebar navigation links and brand title', () => {
      render(<Sidebar />);

      expect(screen.getByText('ct-review-bot')).toBeInTheDocument();
      expect(screen.getByText('Overview')).toBeInTheDocument();
      expect(screen.getByText('Live Stream')).toBeInTheDocument();
      expect(screen.getByText('Repositories')).toBeInTheDocument();
      expect(screen.getByText('Persona Editor')).toBeInTheDocument();
      expect(screen.getByText('Integrations')).toBeInTheDocument();
      expect(screen.getByText('GitHub App')).toBeInTheDocument();
    });

    it('displays active badge on Live Stream link', () => {
      render(<Sidebar />);
      expect(screen.getByText('LIVE')).toBeInTheDocument();
    });

    it('toggles mobile navigation menu drawer when mobile button is clicked', () => {
      render(<Sidebar />);

      const toggleButton = screen.getByLabelText(/toggle navigation menu/i);
      expect(toggleButton).toBeInTheDocument();

      fireEvent.click(toggleButton);
      const backdrop = screen.getByText('', { selector: '#sidebar-backdrop' });
      expect(backdrop).toBeInTheDocument();

      fireEvent.click(backdrop);
      expect(screen.queryByText('', { selector: '#sidebar-backdrop' })).not.toBeInTheDocument();
    });
  });

  describe('Topbar Component', () => {
    it('renders current page title and description', () => {
      render(<Topbar title="Custom Page Title" description="Custom Page Description" />);

      expect(screen.getByText('Custom Page Title')).toBeInTheDocument();
      expect(screen.getByText('Custom Page Description')).toBeInTheDocument();
      expect(screen.getByText('Env:')).toBeInTheDocument();
      expect(screen.getByText('Production')).toBeInTheDocument();
    });

    it('fires onRefresh callback when refresh button is clicked', () => {
      const handleRefresh = vi.fn();
      render(<Topbar onRefresh={handleRefresh} />);

      const refreshButton = screen.getByTitle('Refresh Data');
      fireEvent.click(refreshButton);
      expect(handleRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('StatusBadge Component', () => {
    it('renders live status badge with label', () => {
      render(<StatusBadge status="live" label="Live Stream" />);
      expect(screen.getByText('Live Stream')).toBeInTheDocument();
    });

    it('renders offline status badge label', () => {
      render(<StatusBadge status="offline" label="Connection Error" />);
      expect(screen.getByText('Connection Error')).toBeInTheDocument();
    });

    it('renders busy status badge with default label', () => {
      render(<StatusBadge status="busy" />);
      expect(screen.getByText('Reviewing')).toBeInTheDocument();
    });
  });
});
