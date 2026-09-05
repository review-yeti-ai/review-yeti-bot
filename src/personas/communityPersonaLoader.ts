import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { logger } from '../utils/logger';

export class CommunityPersonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityPersonaError';
  }
}

export class CommunityPersonaNotFoundError extends CommunityPersonaError {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityPersonaNotFoundError';
  }
}

export class CommunityPersonaValidationError extends CommunityPersonaError {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityPersonaValidationError';
  }
}

export class CommunityPersonaFetchError extends CommunityPersonaError {
  constructor(message: string) {
    super(message);
    this.name = 'CommunityPersonaFetchError';
  }
}

export interface PersonaFrontmatter {
  name?: string;
  id?: string;
  role?: string;
  focus?: string | string[];
  model?: string;
  enabled?: boolean;
  required?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  paths?: string[];
  providers?: string[];
  maxTurns?: number;
  description?: string;
  [key: string]: any;
}

export interface ParsedCommunityPersona {
  frontmatter: PersonaFrontmatter;
  charter: string;
  rawContent: string;
  source: string;
  sourceType: 'bundled' | 'local' | 'remote';
}

export interface ResolvedPersonaConfig {
  id: string;
  name: string;
  charter: string;
  enabled: boolean;
  required: boolean;
  paths: string[];
  providers: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns?: number;
  dual_model?: boolean;
  adversarial_model?: string;
  customPrompt?: string;
  uses?: string;
  role?: string;
  focus?: string | string[];
  [key: string]: any;
}

export interface CommunityPersonaLoaderOptions {
  baseDir?: string;
  bundledDir?: string;
  examplesDir?: string;
  cacheDir?: string;
  fetcher?: (url: string) => Promise<string>;
  bypassCache?: boolean;
}

export function sanitizePersonaId(name: string): string {
  let id = (name || 'persona')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id || !/^[a-z]/.test(id)) {
    id = `p-${id}`;
  }
  return id.slice(0, 64);
}

export function parsePersonaCharter(rawContent: string, sourcePath?: string): { frontmatter: PersonaFrontmatter; charter: string } {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new CommunityPersonaValidationError(`Persona charter content is empty or invalid${sourcePath ? ` in ${sourcePath}` : ''}`);
  }

  const trimmed = rawContent.trim();
  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new CommunityPersonaValidationError(
      `Persona charter must include valid YAML frontmatter between '---' markers${sourcePath ? ` in ${sourcePath}` : ''}`
    );
  }

  const frontmatterRaw = match[1];
  const charterBody = match[2].trim();

  let frontmatter: any;
  try {
    frontmatter = yaml.load(frontmatterRaw);
  } catch (err: any) {
    throw new CommunityPersonaValidationError(
      `Failed to parse YAML frontmatter: ${err?.message || err}${sourcePath ? ` in ${sourcePath}` : ''}`
    );
  }

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new CommunityPersonaValidationError(
      `Persona frontmatter must be a YAML mapping/object${sourcePath ? ` in ${sourcePath}` : ''}`
    );
  }

  if (!charterBody || charterBody.length < 10) {
    throw new CommunityPersonaValidationError(
      `Persona charter body cannot be empty (minimum 10 characters required)${sourcePath ? ` in ${sourcePath}` : ''}`
    );
  }

  return { frontmatter, charter: charterBody };
}

export class CommunityPersonaLoader {
  private baseDir: string;
  private bundledDir: string;
  private examplesDir: string;
  private cacheDir: string;
  private fetcher?: (url: string) => Promise<string>;
  private bypassCache: boolean;

  constructor(options: CommunityPersonaLoaderOptions = {}) {
    this.baseDir = options.baseDir || process.cwd();
    this.bundledDir = options.bundledDir || path.join(this.baseDir, 'domains/personas');
    this.examplesDir = options.examplesDir || path.join(this.baseDir, 'examples/personas');
    this.cacheDir = options.cacheDir || path.join(this.baseDir, '.ct-memory/cache/personas');
    this.fetcher = options.fetcher;
    this.bypassCache = options.bypassCache ?? false;
  }

  /**
   * Resolves a persona charter by reference using the defined precedence:
   * 1. Bundled / community personas in domains/personas/ (or examples/personas/)
   * 2. Local files starting with ./ or ../
   * 3. Remote GitHub repository references (owner/repo/path@ref) with HTTP fetch & caching
   */
  public async resolvePersonaReference(uses: string): Promise<ParsedCommunityPersona> {
    if (!uses || typeof uses !== 'string') {
      throw new CommunityPersonaValidationError('Persona "uses" reference must be a non-empty string');
    }

    const trimmedUses = uses.trim();

    // 1. Bundled / community personas
    const bundledResult = this.tryResolveBundled(trimmedUses);
    if (bundledResult) {
      return bundledResult;
    }

    // 2. Local files starting with ./ or ../
    if (trimmedUses.startsWith('./') || trimmedUses.startsWith('../') || path.isAbsolute(trimmedUses)) {
      return this.resolveLocal(trimmedUses);
    }

    // 3. Remote GitHub repository reference: owner/repo/path@ref
    const remoteMatch = trimmedUses.match(/^([^/@]+)\/([^/@]+)\/([^@]+)@([^@]+)$/);
    if (remoteMatch) {
      return this.resolveRemote(remoteMatch[1], remoteMatch[2], remoteMatch[3], remoteMatch[4], trimmedUses);
    }

    // Fallback: check if bare name exists locally or in bundled
    const bareCandidate = this.tryResolveBundled(trimmedUses.replace(/@.*$/, ''));
    if (bareCandidate) {
      return bareCandidate;
    }

    throw new CommunityPersonaNotFoundError(`Could not resolve persona charter reference: "${trimmedUses}"`);
  }

  /**
   * Synchronous resolution for bundled or local personas.
   */
  public resolvePersonaReferenceSync(uses: string): ParsedCommunityPersona {
    if (!uses || typeof uses !== 'string') {
      throw new CommunityPersonaValidationError('Persona "uses" reference must be a non-empty string');
    }

    const trimmedUses = uses.trim();

    // 1. Bundled
    const bundledResult = this.tryResolveBundled(trimmedUses);
    if (bundledResult) {
      return bundledResult;
    }

    // 2. Local
    if (trimmedUses.startsWith('./') || trimmedUses.startsWith('../') || path.isAbsolute(trimmedUses)) {
      return this.resolveLocal(trimmedUses);
    }

    // 3. Check cache if remote
    const remoteMatch = trimmedUses.match(/^([^/@]+)\/([^/@]+)\/([^@]+)@([^@]+)$/);
    if (remoteMatch) {
      const owner = remoteMatch[1];
      const repo = remoteMatch[2];
      let filePath = remoteMatch[3];
      const ref = remoteMatch[4];
      if (!filePath.endsWith('.md') && !filePath.endsWith('.markdown')) {
        filePath += '.md';
      }
      const safeKey = `${owner}__${repo}__${ref}__${filePath.replace(/[/\\:]/g, '_')}`;
      const cachedPath = path.join(this.cacheDir, safeKey);
      if (fs.existsSync(cachedPath)) {
        const content = fs.readFileSync(cachedPath, 'utf-8');
        const { frontmatter, charter } = parsePersonaCharter(content, cachedPath);
        return {
          frontmatter,
          charter,
          rawContent: content,
          source: cachedPath,
          sourceType: 'remote',
        };
      }
    }

    throw new CommunityPersonaNotFoundError(`Could not synchronously resolve persona reference: "${trimmedUses}"`);
  }

  private tryResolveBundled(uses: string): ParsedCommunityPersona | null {
    // Extract base name from patterns like:
    // review-yeti/personas/django-security@v1 -> django-security
    // personas/django-security -> django-security
    // django-security@v1 -> django-security
    let candidateName = uses;

    // Strip version tag if present
    candidateName = candidateName.replace(/@.*$/, '');

    // Strip prefixes like review-yeti/personas/ or domains/personas/ or personas/
    if (candidateName.includes('/personas/')) {
      candidateName = candidateName.split('/personas/')[1];
    } else if (candidateName.startsWith('review-yeti/')) {
      candidateName = candidateName.replace(/^review-yeti\//, '');
    }

    const possibleFilenames = [
      candidateName.endsWith('.md') ? candidateName : `${candidateName}.md`,
      candidateName,
    ];

    const searchDirs = [this.bundledDir, this.examplesDir];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const filename of possibleFilenames) {
        const candidatePath = path.join(dir, filename);
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
          const content = fs.readFileSync(candidatePath, 'utf-8');
          const { frontmatter, charter } = parsePersonaCharter(content, candidatePath);
          return {
            frontmatter,
            charter,
            rawContent: content,
            source: candidatePath,
            sourceType: 'bundled',
          };
        }
      }
    }

    return null;
  }

  private resolveLocal(localPath: string): ParsedCommunityPersona {
    const resolvedPath = path.isAbsolute(localPath)
      ? localPath
      : path.resolve(this.baseDir, localPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      throw new CommunityPersonaNotFoundError(`Local persona file not found at: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const { frontmatter, charter } = parsePersonaCharter(content, resolvedPath);
    return {
      frontmatter,
      charter,
      rawContent: content,
      source: resolvedPath,
      sourceType: 'local',
    };
  }

  private async resolveRemote(
    owner: string,
    repo: string,
    rawFilePath: string,
    ref: string,
    originalRef: string
  ): Promise<ParsedCommunityPersona> {
    let filePath = rawFilePath;
    if (!filePath.endsWith('.md') && !filePath.endsWith('.markdown')) {
      filePath += '.md';
    }

    const safeKey = `${owner}__${repo}__${ref}__${filePath.replace(/[/\\:]/g, '_')}`;
    const cachedFilePath = path.join(this.cacheDir, safeKey);

    // Cache hit
    if (!this.bypassCache && fs.existsSync(cachedFilePath)) {
      try {
        const content = fs.readFileSync(cachedFilePath, 'utf-8');
        const { frontmatter, charter } = parsePersonaCharter(content, cachedFilePath);
        return {
          frontmatter,
          charter,
          rawContent: content,
          source: cachedFilePath,
          sourceType: 'remote',
        };
      } catch (err: any) {
        logger.warn('Corrupted persona cache entry, re-fetching', { cachedFilePath, error: err?.message });
      }
    }

    // Remote fetch
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    let fetchedContent = '';

    if (this.fetcher) {
      try {
        fetchedContent = await this.fetcher(rawUrl);
      } catch (err: any) {
        throw new CommunityPersonaFetchError(`Custom fetcher failed for "${rawUrl}": ${err?.message || err}`);
      }
    } else {
      try {
        const res = await fetch(rawUrl, {
          headers: {
            'User-Agent': 'review-yeti-bot',
            'Accept': 'text/plain, text/markdown',
          },
        });

        if (!res.ok) {
          throw new CommunityPersonaFetchError(
            `Failed to fetch remote persona from "${rawUrl}": HTTP ${res.status} ${res.statusText}`
          );
        }

        fetchedContent = await res.text();
      } catch (err: any) {
        if (err instanceof CommunityPersonaFetchError) {
          throw err;
        }
        throw new CommunityPersonaFetchError(
          `Network error fetching remote persona "${originalRef}" (${rawUrl}): ${err?.message || err}`
        );
      }
    }

    // Validate frontmatter and charter
    const { frontmatter, charter } = parsePersonaCharter(fetchedContent, rawUrl);

    // Write to cache
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      fs.writeFileSync(cachedFilePath, fetchedContent, 'utf-8');
    } catch (err: any) {
      logger.warn('Failed to cache remote persona charter', { cachedFilePath, error: err?.message });
    }

    return {
      frontmatter,
      charter,
      rawContent: fetchedContent,
      source: rawUrl,
      sourceType: 'remote',
    };
  }

  /**
   * Resolves a single persona configuration item into a normalized, usable persona object.
   */
  public async resolvePersona(personaItem: any): Promise<ResolvedPersonaConfig> {
    if (!personaItem || typeof personaItem !== 'object') {
      throw new CommunityPersonaValidationError('Persona configuration item must be an object');
    }

    if (!personaItem.uses) {
      const id = personaItem.id || sanitizePersonaId(personaItem.name || 'persona');
      return {
        id,
        name: personaItem.name || id,
        charter: personaItem.charter || '',
        enabled: personaItem.enabled ?? true,
        required: personaItem.required ?? false,
        paths: personaItem.paths || ['**'],
        providers: personaItem.providers || ['openrouter'],
        model: personaItem.model,
        effort: personaItem.effort,
        maxTurns: personaItem.maxTurns,
        dual_model: personaItem.dual_model,
        adversarial_model: personaItem.adversarial_model,
        customPrompt: personaItem.customPrompt,
        ...personaItem,
      };
    }

    const resolved = await this.resolvePersonaReference(personaItem.uses);
    const fm = resolved.frontmatter;

    const id = personaItem.id || fm.id || sanitizePersonaId(personaItem.name || fm.name || 'persona');
    const name = personaItem.name || fm.name || id;

    return {
      id,
      name,
      enabled: personaItem.enabled ?? fm.enabled ?? true,
      required: personaItem.required ?? fm.required ?? false,
      paths: personaItem.paths || fm.paths || ['**'],
      providers: personaItem.providers || fm.providers || ['openrouter'],
      model: personaItem.model || fm.model,
      effort: personaItem.effort || fm.effort || fm.reasoning_effort,
      maxTurns: personaItem.maxTurns ?? fm.maxTurns,
      uses: personaItem.uses,
      role: fm.role,
      focus: fm.focus,
      sourceType: resolved.sourceType,
      source: resolved.source,
      ...personaItem,
      charter: resolved.charter,
    };
  }

  /**
   * Resolves an array of persona configurations.
   */
  public async resolvePersonas(personas: any[]): Promise<ResolvedPersonaConfig[]> {
    if (!Array.isArray(personas)) {
      return [];
    }

    return Promise.all(personas.map((p) => this.resolvePersona(p)));
  }
}

export const defaultCommunityPersonaLoader = new CommunityPersonaLoader();

export async function resolveCommunityPersonas(
  personas: any[],
  options?: CommunityPersonaLoaderOptions
): Promise<ResolvedPersonaConfig[]> {
  const loader = options ? new CommunityPersonaLoader(options) : defaultCommunityPersonaLoader;
  return loader.resolvePersonas(personas);
}
