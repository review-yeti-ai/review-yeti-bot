import { logger } from "../../utils/logger";
import { MemoryAdapter, MemoryAdapterConfig, MemoryProviderType } from "./types";
import { SQLiteMemoryAdapter } from "./sqliteAdapter";
import { HonchoMemoryAdapter } from "./honchoAdapter";
import { CompositeMemoryAdapter } from "./compositeAdapter";

export function resolveMemoryProvider(config?: MemoryAdapterConfig): MemoryProviderType {
  const envProvider = (
    process.env.MEMORY_PROVIDER ||
    process.env.CT_MEMORY_PROVIDER ||
    config?.provider ||
    "auto"
  ).toLowerCase() as MemoryProviderType;

  if (envProvider !== "auto") {
    return envProvider;
  }

  // Auto-detection logic:
  // If HONCHO_API_KEY is present, automatically use composite mode (local SQLite + Honcho cloud sync)
  if (process.env.HONCHO_API_KEY || config?.honcho?.apiKey) {
    return "composite";
  }

  return "sqlite";
}

export function createMemoryAdapter(config?: MemoryAdapterConfig): MemoryAdapter {
  const provider = resolveMemoryProvider(config);

  logger.info("Initializing Review Yeti Memory Adapter", { provider });

  switch (provider) {
    case "honcho": {
      return new HonchoMemoryAdapter(config?.honcho);
    }

    case "composite": {
      const primary = new SQLiteMemoryAdapter(config?.sqlite);
      const secondary = new HonchoMemoryAdapter(config?.honcho);
      return new CompositeMemoryAdapter({
        primary,
        secondary,
        writeAsync: true,
      });
    }

    case "sqlite":
    default: {
      return new SQLiteMemoryAdapter(config?.sqlite);
    }
  }
}
