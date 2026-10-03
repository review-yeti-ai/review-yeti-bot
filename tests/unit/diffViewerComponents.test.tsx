// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiffViewer } from '../../src/components/live/diff-viewer';
import { FindingDiffCard } from '../../src/components/live/finding-diff-card';
import { ReasoningFeed } from '../../src/components/live/reasoning-feed';
import { ToolFeed } from '../../src/components/live/tool-feed';
import { LiveDashboardView } from '../../src/components/live/LiveDashboardView';
import { ChangedFileDiff, AnchoredFinding } from '../../src/types/diff';
import { LiveStreamEvent } from '../../src/types/live';
import { ToolExecutionRecord } from '../../src/lib/useSSE';

// Mock EventSource for Vitest environment
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 0);
  }

  emitMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  close() {
    this.readyState = 2;
  }
}

// Mock ResizeObserver for Recharts in jsdom
beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  if (typeof window !== 'undefined') {
    window.ResizeObserver =
      window.ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    // Mock scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('jobId=job-test-123'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe('Milestone 2 UI Components Suite', () => {
  const sampleFiles: ChangedFileDiff[] = [
    {
      path: 'src/auth/jwt.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -10,3 +10,5 @@\n const token = header.split(" ")[1];\n-verify(token, secret);\n+if (!token) throw new Error("No token");\n+verifyToken(token, secret, { algorithms: ["RS256"] });\n+// validated',
      hunks: [
        {
          header: '@@ -10,3 +10,5 @@',
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 5,
          lines: [
            { type: 'context', oldLineNumber: 10, newLineNumber: 10, content: 'const token = header.split(" ")[1];' },
            { type: 'delete', oldLineNumber: 11, content: 'verify(token, secret);' },
            { type: 'add', newLineNumber: 11, content: 'if (!token) throw new Error("No token");' },
            { type: 'add', newLineNumber: 12, content: 'verifyToken(token, secret, { algorithms: ["RS256"] });' },
            { type: 'add', newLineNumber: 13, content: '// validated' },
          ],
        },
      ],
    },
    {
      path: 'src/config/database.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
      patch: '@@ -0,0 +1,2 @@\n+export const poolSize = 10;\n+export const ssl = true;',
      hunks: [
        {
          header: '@@ -0,0 +1,2 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { type: 'add', newLineNumber: 1, content: 'export const poolSize = 10;' },
            { type: 'add', newLineNumber: 2, content: 'export const ssl = true;' },
          ],
        },
      ],
    },
  ];

  const sampleFindings: AnchoredFinding[] = [
    {
      id: 'finding-sec-1',
      severity: 'P0',
      file: 'src/auth/jwt.ts',
      line: 12,
      title: 'Missing Audience and Issuer Validation',
      description: 'JWT verification does not specify audience or issuer checks, allowing tokens from other realms.',
      suggestion: 'verifyToken(token, secret, { algorithms: ["RS256"], audience: "my-app", issuer: "auth.corp" });',
      status: 'active',
      persona: 'security',
    },
    {
      id: 'finding-file-level',
      severity: 'P1',
      file: 'src/auth/jwt.ts',
      line: 0,
      title: 'File level warning: Insecure imports',
      description: 'The file imports deprecated legacy auth helper.',
      status: 'active',
      persona: 'architecture',
    },
  ];

  describe('FindingDiffCard Component', () => {
    it('renders P0 Blocker badge, anchor file:line, and title/description', () => {
      render(<FindingDiffCard finding={sampleFindings[0]} />);

      expect(screen.getByText(/P0 Blocker/i)).toBeDefined();
      expect(screen.getByText(/src\/auth\/jwt\.ts:12/)).toBeDefined();
      expect(screen.getByText('Missing Audience and Issuer Validation')).toBeDefined();
      expect(
        screen.getByText(/JWT verification does not specify audience or issuer checks/)
      ).toBeDefined();
      expect(screen.getByText('security')).toBeDefined();
    });

    it('renders P1 Warning and P2 Nit badges correctly', () => {
      const p1Finding: AnchoredFinding = {
        ...sampleFindings[0],
        id: 'p1-test',
        severity: 'P1',
      };
      const { rerender } = render(<FindingDiffCard finding={p1Finding} />);
      expect(screen.getByText(/P1 Warning/i)).toBeDefined();

      const p2Finding: AnchoredFinding = {
        ...sampleFindings[0],
        id: 'p2-test',
        severity: 'P2',
      };
      rerender(<FindingDiffCard finding={p2Finding} />);
      expect(screen.getByText(/P2 Nit/i)).toBeDefined();
    });

    it('renders copyable code fix suggestion box when suggestion is present', () => {
      render(<FindingDiffCard finding={sampleFindings[0]} />);

      expect(screen.getByText(/Suggested Fix/i)).toBeDefined();
      expect(screen.getByText(/verifyToken\(token, secret, \{ algorithms: \["RS256"\], audience: "my-app"/)).toBeDefined();
      expect(screen.getByText('Copy')).toBeDefined();
    });

    it('triggers onDismiss callback with finding ID when dismiss button is clicked', () => {
      const handleDismiss = vi.fn();
      render(<FindingDiffCard finding={sampleFindings[0]} onDismiss={handleDismiss} />);

      const dismissBtn = screen.getByText('Dismiss');
      fireEvent.click(dismissBtn);

      const confirmBtn = screen.getByText('Confirm Dismiss');
      fireEvent.click(confirmBtn);

      expect(handleDismiss).toHaveBeenCalledWith('finding-sec-1', expect.any(String));
    });

    it('triggers onAdjustSeverity callback when severity dropdown/toggle is changed', () => {
      const handleAdjust = vi.fn();
      render(<FindingDiffCard finding={sampleFindings[0]} onAdjustSeverity={handleAdjust} />);

      const sevBtn = screen.getByText(/Severity:/i);
      fireEvent.click(sevBtn);

      const p1Btn = screen.getByText(/P1 Warning/i);
      fireEvent.click(p1Btn);

      expect(handleAdjust).toHaveBeenCalledWith('finding-sec-1', 'P1');
    });
  });

  describe('DiffViewer Component', () => {
    it('renders file headers with path, additions, and deletions badges', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      expect(screen.getByText('src/auth/jwt.ts')).toBeDefined();
      expect(screen.getByText('src/config/database.ts')).toBeDefined();
      expect(screen.getAllByText('3').length).toBeGreaterThan(0);
      expect(screen.getAllByText('1').length).toBeGreaterThan(0);
      expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    });

    it('renders unified diff line numbers and content', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      // Line content from diff
      expect(screen.getByText('const token = header.split(" ")[1];')).toBeDefined();
      expect(screen.getByText('verify(token, secret);')).toBeDefined();
      expect(screen.getByText('if (!token) throw new Error("No token");')).toBeDefined();
    });

    it('injects line-anchored FindingDiffCard immediately beneath the matching line', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      // Finding on line 12 is rendered
      expect(screen.getByText('Missing Audience and Issuer Validation')).toBeDefined();
      expect(screen.getByText(/src\/auth\/jwt\.ts:12/)).toBeDefined();
    });

    it('renders file-level unanchored findings in a file notice header', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      expect(screen.getByText('File level warning: Insecure imports')).toBeDefined();
    });

    it('filters files using the search input', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      const searchInput = screen.getByPlaceholderText('Filter changed files by path...');
      fireEvent.change(searchInput, { target: { value: 'database' } });

      expect(screen.getByText('src/config/database.ts')).toBeDefined();
      expect(screen.queryByText('src/auth/jwt.ts')).toBeNull();
    });

    it('toggles expand and collapse of file diff when file header is clicked', () => {
      render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

      const fileHeader = screen.getByText('src/auth/jwt.ts');
      expect(screen.getByText('const token = header.split(" ")[1];')).toBeDefined();

      // Click to collapse
      fireEvent.click(fileHeader);
      expect(screen.queryByText('const token = header.split(" ")[1];')).toBeNull();

      // Click to expand again
      fireEvent.click(fileHeader);
      expect(screen.getByText('const token = header.split(" ")[1];')).toBeDefined();
    });

    it('filters findings by selectedPersona', () => {
      render(
        <DiffViewer
          files={sampleFiles}
          findings={sampleFindings}
          selectedPersona="security"
        />
      );

      // Security finding should be visible
      expect(screen.getByText('Missing Audience and Issuer Validation')).toBeDefined();
      // Architecture file-level finding should be filtered out
      expect(screen.queryByText('File level warning: Insecure imports')).toBeNull();
    });
  });

  describe('ReasoningFeed Component', () => {
    const mockReasoning = {
      security: 'Step 1: Inspecting auth handlers.\nStep 2: Discovered vulnerable JWT verify call without issuer check.',
      architecture: 'Step 1: Evaluating module dependencies.',
    };

    const mockReasoningEvents: LiveStreamEvent[] = [
      {
        jobId: 'job-1',
        timestamp: '2026-07-27T10:00:00Z',
        type: 'reasoning:chunk',
        persona: 'quality',
        data: {
          personaId: 'quality',
          reasoning: 'Analyzing test coverage for modified auth routes.',
        },
      },
    ];

    it('renders persona accordion cards with streaming reasoning text', () => {
      render(
        <ReasoningFeed
          reasoning={mockReasoning}
          events={mockReasoningEvents}
          selectedPersona="all"
        />
      );

      expect(screen.getByText('Persona Reasoning Traces')).toBeDefined();
      expect(screen.getByText('Security')).toBeDefined();
      expect(screen.getByText('Architecture')).toBeDefined();
      expect(screen.getByText('Quality')).toBeDefined();

      expect(screen.getByText(/Step 1: Inspecting auth handlers/)).toBeDefined();
      expect(screen.getByText(/Analyzing test coverage for modified auth routes/)).toBeDefined();
    });

    it('filters reasoning cards to selectedPersona', () => {
      render(
        <ReasoningFeed
          reasoning={mockReasoning}
          selectedPersona="security"
        />
      );

      expect(screen.getByText('Security')).toBeDefined();
      expect(screen.queryByText('Architecture')).toBeNull();
    });

    it('allows toggling persona accordion cards', () => {
      render(<ReasoningFeed reasoning={mockReasoning} />);

      const securityHeader = screen.getByText('Security');
      expect(screen.getByText(/Step 1: Inspecting auth handlers/)).toBeDefined();

      // Click to collapse
      fireEvent.click(securityHeader);
      expect(screen.queryByText(/Step 1: Inspecting auth handlers/)).toBeNull();

      // Click to expand
      fireEvent.click(securityHeader);
      expect(screen.getByText(/Step 1: Inspecting auth handlers/)).toBeDefined();
    });
  });

  describe('ToolFeed Component', () => {
    const mockExecutions: ToolExecutionRecord[] = [
      {
        id: 'exec-1',
        jobId: 'job-1',
        personaId: 'security',
        tool: 'zoekt_search',
        args: { query: 'verifyToken', limit: 10 },
        output: 'Found 3 occurrences of verifyToken across 2 files.',
        outputLength: 46,
        status: 'completed',
        durationMs: 145,
        turn: 1,
        timestamp: '2026-07-27T10:00:00Z',
      },
      {
        id: 'exec-2',
        jobId: 'job-1',
        personaId: 'devops',
        tool: 'run_linter',
        args: { command: 'eslint src/auth' },
        error: 'ESLint exited with code 1: 2 errors found',
        status: 'error',
        durationMs: 420,
        turn: 2,
        timestamp: '2026-07-27T10:00:05Z',
      },
    ];

    it('renders tool invocations with tool name, persona badge, status, and duration', () => {
      render(<ToolFeed toolExecutions={mockExecutions} selectedPersona="all" />);

      expect(screen.getByText('Subagent Tool Timeline')).toBeDefined();
      expect(screen.getByText('zoekt_search')).toBeDefined();
      expect(screen.getByText('run_linter')).toBeDefined();
      expect(screen.getByText('145ms')).toBeDefined();
      expect(screen.getByText('420ms')).toBeDefined();
      expect(screen.getByText('Success')).toBeDefined();
      expect(screen.getByText('Failed')).toBeDefined();
    });

    it('expands arguments and output drawers when tool card is clicked', () => {
      render(<ToolFeed toolExecutions={mockExecutions} />);

      const toolCard = screen.getByText('zoekt_search');
      expect(screen.queryByText(/Found 3 occurrences of verifyToken/)).toBeNull();

      // Expand card
      fireEvent.click(toolCard);
      expect(screen.getByText(/Found 3 occurrences of verifyToken/)).toBeDefined();
      expect(screen.getAllByText(/verifyToken/).length).toBeGreaterThan(0);
    });

    it('filters tool executions by selectedPersona', () => {
      render(<ToolFeed toolExecutions={mockExecutions} selectedPersona="security" />);

      expect(screen.getByText('zoekt_search')).toBeDefined();
      expect(screen.queryByText('run_linter')).toBeNull();
    });
  });

  describe('LiveDashboardView Integration & Tabs Switching', () => {
    beforeEach(() => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/live/diff')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              jobId: 'job-test-123',
              files: sampleFiles,
              findings: sampleFindings,
            }),
          });
        }
        if (url.includes('/api/live/jobs')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              jobs: [],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        });
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('renders the 3 primary view switcher tabs: Diff & Findings, Reasoning & Tools, Raw Terminal', async () => {
      const { unmount } = render(<LiveDashboardView />);

      expect(screen.getByRole('tab', { name: /Diff & Findings/i })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Reasoning & Tools/i })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Raw Terminal/i })).toBeDefined();
      unmount();
    });

    it('switches view between Diff, Reasoning, and Terminal when tabs are clicked', async () => {
      const { unmount } = render(<LiveDashboardView />);

      // Initially Diff tab is active and shows diff viewer
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter changed files by path...')).toBeDefined();
      });

      // Switch to Reasoning & Tools tab
      const reasoningTab = screen.getByRole('tab', { name: /Reasoning & Tools/i });
      fireEvent.pointerDown(reasoningTab, { button: 0, ctrlKey: false });
      fireEvent.keyDown(reasoningTab, { key: 'Enter', code: 'Enter' });
      fireEvent.click(reasoningTab);

      await waitFor(() => {
        expect(screen.getByText('Persona Reasoning Traces')).toBeDefined();
        expect(screen.getByText('Subagent Tool Timeline')).toBeDefined();
      });

      // Switch to Raw Terminal tab
      const terminalTab = screen.getByRole('tab', { name: /Raw Terminal/i });
      fireEvent.pointerDown(terminalTab, { button: 0, ctrlKey: false });
      fireEvent.keyDown(terminalTab, { key: 'Enter', code: 'Enter' });
      fireEvent.click(terminalTab);

      await waitFor(() => {
        expect(screen.getByText('Terminal Feed')).toBeDefined();
      });
      unmount();
    });
  });
});
