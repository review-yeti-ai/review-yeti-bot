import yaml from 'js-yaml';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { PlatformMemoryStore } from '../memory/platformMemoryStore';
import { logger } from '../utils/logger';

export interface CodeRabbitRule {
  id: string;
  rule: string;
  scope: string[];
  severity?: 'P0' | 'P1' | 'P2';
}

export interface CodeRabbitPathInstruction {
  path: string;
  instructions: string;
}

export interface CodeRabbitConfig {
  rules?: CodeRabbitRule[];
  path_instructions?: CodeRabbitPathInstruction[];
}

export class RuleSyncEngine {
  private prMemoryStore: PRMemoryStore;
  private platformMemoryStore: PlatformMemoryStore;

  constructor(prStore?: PRMemoryStore, platformStore?: PlatformMemoryStore) {
    this.prMemoryStore = prStore || new PRMemoryStore();
    this.platformMemoryStore = platformStore || new PlatformMemoryStore();
  }

  /**
   * Parses raw YAML content from .ct-review.yaml or .coderabbit.yaml,
   * extracts explicit rules and path instructions, and syncs them into memory stores.
   */
  public async syncYamlConfigToMemory(repo: string, yamlContent: string): Promise<{
    rulesSyncedCount: number;
    pathInstructionsSyncedCount: number;
  }> {
    logger.info('Syncing YAML rules & path instructions to memory stores', { repo });

    let rulesSyncedCount = 0;
    let pathInstructionsSyncedCount = 0;

    try {
      const parsed = (yaml.load(yamlContent) || {}) as CodeRabbitConfig;

      // 1. Sync Rules
      if (Array.isArray(parsed.rules)) {
        for (const r of parsed.rules) {
          if (!r || !r.rule) continue;
          const id = r.id || `rule_${r.rule.slice(0, 15).replace(/\W+/g, '_')}`;
          const scopeStr = Array.isArray(r.scope) ? r.scope.join(', ') : '**';
          const category = r.severity === 'P0' ? 'security' : r.severity === 'P1' ? 'architecture' : 'convention';

          await this.prMemoryStore.recordLearning(repo, 0, {
            category,
            title: id,
            description: r.rule,
            filePath: scopeStr,
          });

          await this.platformMemoryStore.recordPlatformPattern(
            category === 'convention' ? 'quality' : category,
            id,
            r.rule,
            repo
          );
          rulesSyncedCount++;
        }
      }

      // 2. Sync Path Instructions
      if (Array.isArray(parsed.path_instructions)) {
        for (const pi of parsed.path_instructions) {
          if (!pi || !pi.path || !pi.instructions) continue;
          await this.prMemoryStore.recordPathInstruction(repo, {
            pathPattern: pi.path,
            instructions: pi.instructions.trim(),
          });
          pathInstructionsSyncedCount++;
        }
      }

      logger.info('Completed YAML rules sync cleanly', { repo, rulesSyncedCount, pathInstructionsSyncedCount });
    } catch (err: any) {
      logger.warn('Failed to parse or sync YAML rules to memory', { repo, error: err?.message });
    }

    return { rulesSyncedCount, pathInstructionsSyncedCount };
  }
}
