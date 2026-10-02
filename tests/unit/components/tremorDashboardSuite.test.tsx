// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Metric,
  Text,
  Title,
  Subtitle,
  BadgeDelta,
  ProgressBar,
  CategoryBar,
  Tracker,
  BarList,
  TabGroup,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  Callout,
  Grid,
  Flex,
  Divider,
} from '../../../src/components/dashboard/tremor';
import OverviewPage from '../../../src/app/page';
import { ShieldCheck, Cpu } from 'lucide-react';
import { assertTokenTelemetryMarkup } from '../../support/dashboardMarkup';

vi.mock('../../../src/components/live/LiveDashboardView', () => ({ LiveDashboardView: () => <div>Active live fixture</div> }));
vi.mock('../../../src/lib/api-client', () => ({
  fetchReviewLogs: async () => [],
  fetchOverviewStats: async () => ({ totalRepositories: 2, activeAutomations: 0, totalReviewsExecuted: 4,
    totalCostUSD: 0, monthlyCostCapUSD: 100, costCapBreached: false,
    totalTokens: { prompt: 120, completion: 30, total: 150 }, providerHealth: [],
    memoryGraph: { symbolNodesCount: 1, symbolEdgesCount: 0, learningsCount: 0, suppressedNitsCount: 0, adrConstraintsCount: 0 } }),
}));

describe('Tremor & Tremor Raw Dashboard UX Component Suite', () => {
  describe('Card & Typography Primitives', () => {
    it('renders Card with title, metric, description and custom decoration', () => {
      const { container } = render(
        <Card decoration="top" decorationColor="emerald" data-testid="test-card">
          <CardHeader>
            <CardTitle>Total PR Reviews</CardTitle>
            <CardDescription>Automated edge validations</CardDescription>
          </CardHeader>
          <CardContent>
            <Metric>1,280</Metric>
            <Text>100% automated enforcement</Text>
          </CardContent>
          <CardFooter>
            <Text>Updated just now</Text>
          </CardFooter>
        </Card>
      );

      expect(screen.getByTestId('test-card')).toBeInTheDocument();
      expect(screen.getByText('Total PR Reviews')).toBeInTheDocument();
      expect(screen.getByText('Automated edge validations')).toBeInTheDocument();
      expect(screen.getByText('1,280')).toBeInTheDocument();
      expect(screen.getByText('100% automated enforcement')).toBeInTheDocument();
      expect(screen.getByText('Updated just now')).toBeInTheDocument();
      expect(container.firstChild).toHaveClass('border-t-2', 'border-t-emerald-500');
    });

    it('renders Title, Subtitle, and Metric with value prop', () => {
      render(
        <div>
          <Title>Executive Summary</Title>
          <Subtitle>Moving 24-hour window</Subtitle>
          <Metric value="99.4%" />
        </div>
      );

      expect(screen.getByText('Executive Summary')).toBeInTheDocument();
      expect(screen.getByText('Moving 24-hour window')).toBeInTheDocument();
      expect(screen.getByText('99.4%')).toBeInTheDocument();
    });
  });

  describe('BadgeDelta Component', () => {
    it('renders positive increase badge with green styling', () => {
      render(<BadgeDelta deltaType="increase">+14.2%</BadgeDelta>);
      const badge = screen.getByText('+14.2%');
      expect(badge).toBeInTheDocument();
      expect(badge.parentElement).toHaveClass('text-emerald-400');
    });

    it('renders decrease badge with negative rose styling when increase is positive', () => {
      render(<BadgeDelta deltaType="decrease">-8.5%</BadgeDelta>);
      const badge = screen.getByText('-8.5%');
      expect(badge).toBeInTheDocument();
      expect(badge.parentElement).toHaveClass('text-rose-400');
    });

    it('inverts styling when isIncreasePositive is false', () => {
      // For token burn or errors, decrease is positive!
      render(
        <BadgeDelta deltaType="decrease" isIncreasePositive={false}>
          -22% Tokens
        </BadgeDelta>
      );
      const badge = screen.getByText('-22% Tokens');
      expect(badge.parentElement).toHaveClass('text-emerald-400');
    });

    it('renders unchanged badge with neutral zinc styling', () => {
      render(<BadgeDelta deltaType="unchanged">0.0%</BadgeDelta>);
      const badge = screen.getByText('0.0%');
      expect(badge.parentElement).toHaveClass('text-zinc-400');
    });
  });

  describe('ProgressBar Component', () => {
    it('renders clamped progress bar with label and percentage', () => {
      render(<ProgressBar value={64} label="AST Compaction Rate" color="emerald" />);
      expect(screen.getByText('AST Compaction Rate')).toBeInTheDocument();
      expect(screen.getByText('64%')).toBeInTheDocument();
    });

    it('clamps values below 0 and above 100', () => {
      const { rerender } = render(<ProgressBar value={-15} label="Clamped Low" />);
      expect(screen.getByText('0%')).toBeInTheDocument();

      rerender(<ProgressBar value={140} label="Clamped High" />);
      expect(screen.getByText('100%')).toBeInTheDocument();
    });
  });

  describe('CategoryBar Component', () => {
    it('renders multi-segment distribution bar with labels', () => {
      render(
        <CategoryBar
          values={[10, 5, 2]}
          colors={['emerald', 'amber', 'rose']}
          labels={['Approved', 'Warnings', 'P0 Blockers']}
          showLabels={true}
        />
      );

      expect(screen.getByText(/Approved \(10\)/)).toBeInTheDocument();
      expect(screen.getByText(/Warnings \(5\)/)).toBeInTheDocument();
      expect(screen.getByText(/P0 Blockers \(2\)/)).toBeInTheDocument();
    });
  });

  describe('Tracker Component', () => {
    it('renders heartbeat blocks with tooltips', () => {
      const blocks = [
        { color: 'emerald' as const, tooltip: 'Stage 1: Passed' },
        { color: 'emerald' as const, tooltip: 'Stage 2: Passed' },
        { color: 'yellow' as const, tooltip: 'Stage 3: Running' },
        { color: 'gray' as const, tooltip: 'Stage 4: Pending' },
      ];

      render(<Tracker data={blocks} data-testid="tracker-container" />);
      expect(screen.getByTestId('tracker-container')).toBeInTheDocument();
      expect(screen.getByTitle('Stage 1: Passed')).toBeInTheDocument();
      expect(screen.getByTitle('Stage 3: Running')).toBeInTheDocument();
    });
  });

  describe('BarList Component', () => {
    it('renders ranked items with labels, values, and percentage widths', () => {
      const items = [
        { name: 'calltelemetry/cisco-cdr', value: 45000, icon: Cpu },
        { name: 'reviewyeti-ai/yeti-bot', value: 25000, icon: ShieldCheck },
        { name: 'calltelemetry/k8s', value: 10000 },
      ];

      render(<BarList data={items} valueFormatter={(v) => `${(v / 1000).toFixed(0)}k tok`} />);

      expect(screen.getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
      expect(screen.getByText('45k tok')).toBeInTheDocument();
      expect(screen.getByText('reviewyeti-ai/yeti-bot')).toBeInTheDocument();
      expect(screen.getByText('25k tok')).toBeInTheDocument();
    });
  });

  describe('TabGroup & Tabs System', () => {
    it('renders tab triggers and switches active panel on user click', () => {
      function TestTabs() {
        const [active, setActive] = React.useState('tab1');
        return (
          <TabGroup value={active} onValueChange={setActive}>
            <TabList>
              <Tab value="tab1">Live Swarm</Tab>
              <Tab value="tab2" onClick={() => setActive('tab2')}>Audit Logs</Tab>
            </TabList>
            <TabPanels>
              <TabPanel value="tab1">Content for Live Swarm</TabPanel>
              <TabPanel value="tab2">Content for Audit Logs</TabPanel>
            </TabPanels>
          </TabGroup>
        );
      }

      render(<TestTabs />);

      expect(screen.getByText('Content for Live Swarm')).toBeInTheDocument();
      expect(screen.queryByText('Content for Audit Logs')).not.toBeInTheDocument();

      const tab2Trigger = screen.getByRole('tab', { name: /Audit Logs/i });
      fireEvent.click(tab2Trigger);

      expect(screen.getByText('Content for Audit Logs')).toBeInTheDocument();
      expect(screen.queryByText('Content for Live Swarm')).not.toBeInTheDocument();
    });
  });

  describe('Callout Component', () => {
    it('renders alert callout with title, description, and icon', () => {
      render(
        <Callout
          title="P0 Blocker Policy Enforced"
          color="rose"
          icon={ShieldCheck}
        >
          Raw diff inspection detected unauthenticated API route in public controller.
        </Callout>
      );

      expect(screen.getByText('P0 Blocker Policy Enforced')).toBeInTheDocument();
      expect(
        screen.getByText(/Raw diff inspection detected unauthenticated API route/)
      ).toBeInTheDocument();
    });
  });

  describe('Layout Primitives (Grid, Flex, Divider)', () => {
    it('renders Grid, Flex, and Divider layout containers cleanly', () => {
      const { container } = render(
        <Grid numItems={2} numItemsMd={4} className="test-grid">
          <Flex justifyContent="between" alignItems="center">
            <span>Left</span>
            <span>Right</span>
          </Flex>
          <Divider />
        </Grid>
      );

      expect(screen.getByText('Left')).toBeInTheDocument();
      expect(screen.getByText('Right')).toBeInTheDocument();
      expect(container.querySelector('hr')).toBeInTheDocument();
      expect(container.querySelector('.grid-cols-2')).toBeInTheDocument();
    });
  });
});


describe('Overview telemetry navigation', () => {
  it('mounts observed telemetry after selecting the fleet tab instead of requiring inactive cards in the export', async () => {
    const { container } = render(<OverviewPage />);
    expect(container.querySelector('[id="chart-tokens-timeseries"]')).toBeNull();
    const fleet = screen.getByRole('tab', { name: 'Fleet Telemetry & Compaction ROI' });
    fireEvent.mouseDown(fleet, { button: 0, ctrlKey: false });
    await waitFor(() => assertTokenTelemetryMarkup(container.querySelector('[id="chart-tokens-timeseries"]'),
      { prompt: 120, completion: 30, total: 150 }));
    expect(container.querySelector('[id="chart-model-costs"]')?.textContent).toContain('$0.000');
    expect(fleet).toHaveAttribute('aria-selected', 'true');
  });
});
