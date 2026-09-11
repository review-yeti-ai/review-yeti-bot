export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY = 'review-yeti-ai/review-yeti-bot';
export const SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID = 1326169548;

export interface ActionDispatchConfig {
  requireExpectedGeneration: boolean;
  centralExternalRepositories: ReadonlySet<string>;
}

interface ActionDispatchEnvironment {
  ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION?: string;
  ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES?: string;
}

export function actionDispatchConfigFromEnv(
  environment: NodeJS.ProcessEnv | ActionDispatchEnvironment = process.env,
): ActionDispatchConfig {
  const value = environment.ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION;
  let requireExpectedGeneration: boolean;
  if (value === undefined || value === '' || value === 'false') requireExpectedGeneration = false;
  else if (value === 'true') requireExpectedGeneration = true;
  else throw new Error('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');

  const configuredRepositories = environment.ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES;
  if (configuredRepositories === undefined) {
    return { requireExpectedGeneration, centralExternalRepositories: new Set() };
  }
  if (configuredRepositories !== SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY) {
    throw new Error('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories');
  }
  return {
    requireExpectedGeneration,
    centralExternalRepositories: new Set([SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY]),
  };
}
