import { MockGithubServer } from './mockGithubServer';
import { MockOmniRouteServer } from './mockOmniRouteServer';
import { MockTicketServer } from './mockTicketServer';
import { StateManager, TestEnvironmentContext } from './stateManager';
import { AppProcessLauncher, RunningApp } from './appProcessLauncher';

export interface E2ETestHarnessOptions {
  testRunId: string;
  githubPort?: number;
  omniRoutePort?: number;
  ticketPort?: number;
  appPort?: number;
  configYaml?: string;
  constitutionMd?: string;
}

export interface E2ETestHarness {
  testRunId: string;
  ctx: TestEnvironmentContext;
  mockGithub: MockGithubServer;
  mockOmniRoute: MockOmniRouteServer;
  mockTicket: MockTicketServer;
  appProcess: RunningApp;
  stateManager: StateManager;
  teardown: () => Promise<void>;
}

export async function setupE2ETestHarness(options: E2ETestHarnessOptions): Promise<E2ETestHarness> {
  const stateManager = new StateManager();
  const ctx = await stateManager.createEnvironment(options.testRunId);

  if (options.configYaml) {
    stateManager.setupFixtures(ctx, options.configYaml, options.constitutionMd);
  }

  const mockGithub = new MockGithubServer({ port: options.githubPort !== undefined ? options.githubPort : 0 });
  const mockOmniRoute = new MockOmniRouteServer(options.omniRoutePort !== undefined ? options.omniRoutePort : 0);
  const mockTicket = new MockTicketServer(options.ticketPort !== undefined ? options.ticketPort : 0);

  const githubUrl = await mockGithub.start();
  const omniRouteUrl = await mockOmniRoute.start();
  const ticketUrl = await mockTicket.start();

  const appLauncher = new AppProcessLauncher();
  const env = {
    ...ctx.env,
    GITHUB_API_BASE_URL: githubUrl,
    OMNIROUTE_BASE_URL: omniRouteUrl,
    TICKET_API_BASE_URL: ticketUrl,
    GITHUB_WEBHOOK_SECRET: mockGithub.webhookSecret,
  };

  const appProcess = await appLauncher.startApp({
    port: options.appPort !== undefined ? options.appPort : 0,
    env,
  });

  return {
    testRunId: options.testRunId,
    ctx,
    mockGithub,
    mockOmniRoute,
    mockTicket,
    appProcess,
    stateManager,
    teardown: async () => {
      await appLauncher.stopApp();
      await mockGithub.stop();
      await mockOmniRoute.stop();
      await mockTicket.stop();
      await stateManager.teardownEnvironment(options.testRunId);
    },
  };
}
