export interface ActionDispatchConfig {
  requireExpectedGeneration: boolean;
}

interface ActionDispatchEnvironment {
  ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION?: string;
}

export function actionDispatchConfigFromEnv(
  environment: NodeJS.ProcessEnv | ActionDispatchEnvironment = process.env,
): ActionDispatchConfig {
  const value = environment.ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION;
  if (value === undefined || value === '' || value === 'false') {
    return { requireExpectedGeneration: false };
  }
  if (value === 'true') return { requireExpectedGeneration: true };
  throw new Error('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');
}
