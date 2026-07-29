import fs from 'node:fs/promises';
import path from 'node:path';

export interface TechStackDetection {
  languages: Record<string, number>; // Language name -> percentage (0 - 100)
  frameworks: string[];
  manifestsFound: string[];
  infrastructure: string[];
  scanDurationMs: number;
  totalFilesScanned: number;
}

export interface StackScanResult {
  detection: TechStackDetection;
  recommendedProfile: 'chill' | 'balanced' | 'assertive';
  recommendedPersonas: Array<{
    id: string;
    name: string;
    charter: string;
    paths: string[];
    required: boolean;
    providers: ('codex' | 'grok' | 'agy-opus' | 'claude')[];
  }>;
  recommendedPathFilters: string[];
}

export async function scanRepositoryStack(repoPath: string): Promise<StackScanResult> {
  const startTime = Date.now();

  const counts: Record<string, number> = {
    TypeScript: 0,
    JavaScript: 0,
    Python: 0,
    Go: 0,
    Java: 0,
    Elixir: 0,
    Docker: 0,
    Kubernetes: 0,
    HTML_CSS: 0,
    Other: 0,
  };

  const manifestsFound: string[] = [];
  const frameworks: string[] = [];
  const infrastructure: string[] = [];
  let totalFilesScanned = 0;

  async function inspectDir(dir: string, depth = 0) {
    if (depth > 3) return; // Cap depth for <1s guarantee
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.name.startsWith('.') && entry.name !== '.dockerignore') return;
          if (['node_modules', 'dist', 'build', 'target', 'vendor', '.git', 'coverage', 'out', 'tmp'].includes(entry.name)) return;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await inspectDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            totalFilesScanned++;
          const filename = entry.name.toLowerCase();

          // Manifest & Config Detection
          if (filename === 'package.json') {
            manifestsFound.push('package.json');
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const pkg = JSON.parse(content);
              const deps = { ...pkg.dependencies, ...pkg.devDependencies };
              if (deps['express']) frameworks.push('Express');
              if (deps['react'] || deps['next']) frameworks.push(deps['next'] ? 'Next.js' : 'React');
              if (deps['typescript']) counts.TypeScript += 5;
              else counts.JavaScript += 5;
            } catch (_) {}
          } else if (filename === 'tsconfig.json') {
            manifestsFound.push('tsconfig.json');
            counts.TypeScript += 5;
          } else if (filename === 'requirements.txt' || filename === 'pyproject.toml' || filename === 'pipfile') {
            manifestsFound.push(entry.name);
            counts.Python += 5;
            if (filename === 'pyproject.toml') {
              try {
                const content = await fs.readFile(fullPath, 'utf-8');
                if (content.includes('django')) frameworks.push('Django');
                if (content.includes('fastapi')) frameworks.push('FastAPI');
              } catch (_) {}
            }
          } else if (filename === 'go.mod') {
            manifestsFound.push('go.mod');
            counts.Go += 5;
          } else if (filename === 'pom.xml' || filename === 'build.gradle' || filename === 'build.gradle.kts') {
            manifestsFound.push(entry.name);
            counts.Java += 5;
            frameworks.push('Spring Boot / JVM');
          } else if (filename === 'mix.exs') {
            manifestsFound.push('mix.exs');
            counts.Elixir += 5;
            frameworks.push('Phoenix / BEAM');
          } else if (filename === 'dockerfile' || filename.startsWith('docker-compose')) {
            manifestsFound.push(entry.name);
            infrastructure.push('Docker');
            counts.Docker += 2;
          } else if (filename === 'chart.yaml') {
            manifestsFound.push('Chart.yaml');
            infrastructure.push('Kubernetes / Helm');
            counts.Kubernetes += 3;
          } else if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
            if (fullPath.includes('/k8s/') || fullPath.includes('/deploy/') || fullPath.includes('/helm/')) {
              infrastructure.push('Kubernetes');
              counts.Kubernetes++;
            }
          }

          // Extension Sampling
          const ext = path.extname(entry.name).toLowerCase();
          if (['.ts', '.tsx'].includes(ext)) counts.TypeScript++;
          else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) counts.JavaScript++;
          else if (ext === '.py') counts.Python++;
          else if (ext === '.go') counts.Go++;
          else if (ext === '.java') counts.Java++;
          else if (['.ex', '.exs'].includes(ext)) counts.Elixir++;
          else if (['.html', '.css', '.scss'].includes(ext)) counts.HTML_CSS++;
          else counts.Other++;
        }
      })
    );
  } catch (_) {}
  }

  await inspectDir(repoPath);

  // Calculate percentages
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const languages: Record<string, number> = {};
  for (const [lang, val] of Object.entries(counts)) {
    if (val > 0) {
      const pct = Math.round((val / totalCount) * 100);
      if (pct > 0) languages[lang] = pct;
    }
  }

  // Generate recommended persona roster
  const recommendedPersonas: StackScanResult['recommendedPersonas'] = [
    {
      id: 'security-arbiter',
      name: 'Security & Vulnerability Arbiter',
      charter: 'builtin:security',
      paths: ['**'],
      required: true,
      providers: ['claude', 'codex'],
    },
  ];

  if (languages.TypeScript || languages.JavaScript) {
    recommendedPersonas.push({
      id: 'ts-node-architect',
      name: 'TypeScript & Node.js Lead',
      charter: 'builtin:correctness',
      paths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', 'package.json'],
      required: true,
      providers: ['codex', 'grok'],
    });
  }

  if (languages.Python) {
    recommendedPersonas.push({
      id: 'python-architect',
      name: 'Python Systems & Logic Reviewer',
      charter: 'builtin:correctness',
      paths: ['**/*.py', 'requirements.txt', 'pyproject.toml'],
      required: false,
      providers: ['codex', 'claude'],
    });
  }

  if (languages.Go) {
    recommendedPersonas.push({
      id: 'go-systems-engineer',
      name: 'Go Systems & Concurrency Engineer',
      charter: 'builtin:correctness',
      paths: ['**/*.go', 'go.mod'],
      required: false,
      providers: ['codex', 'grok'],
    });
  }

  if (languages.Java) {
    recommendedPersonas.push({
      id: 'java-enterprise-reviewer',
      name: 'Java Enterprise Architect',
      charter: 'builtin:correctness',
      paths: ['**/*.java', 'pom.xml', 'build.gradle'],
      required: false,
      providers: ['claude', 'codex'],
    });
  }

  if (languages.Elixir) {
    recommendedPersonas.push({
      id: 'elixir-beam-architect',
      name: 'Elixir BEAM Concurrency Specialist',
      charter: 'builtin:correctness',
      paths: ['**/*.ex', '**/*.exs', 'mix.exs'],
      required: false,
      providers: ['claude', 'codex'],
    });
  }

  if (infrastructure.length > 0 || languages.Docker || languages.Kubernetes) {
    recommendedPersonas.push({
      id: 'devops-sec-ops',
      name: 'DevOps & Cloud Infrastructure Specialist',
      charter: 'builtin:policy-compliance',
      paths: ['Dockerfile', '**/docker-compose*.yml', '**/k8s/**/*.yaml', 'Chart.yaml', '*.tf'],
      required: false,
      providers: ['grok', 'claude'],
    });
  }

  const scanDurationMs = Date.now() - startTime;

  return {
    detection: {
      languages,
      frameworks: [...new Set(frameworks)],
      manifestsFound: [...new Set(manifestsFound)],
      infrastructure: [...new Set(infrastructure)],
      scanDurationMs,
      totalFilesScanned,
    },
    recommendedProfile: 'balanced',
    recommendedPersonas,
    recommendedPathFilters: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'target/**',
      'vendor/**',
      'coverage/**',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'go.sum',
      'Cargo.lock',
    ],
  };
}

export async function scanTechStack(repoPath: string) {
  const res = await scanRepositoryStack(repoPath);
  const langKeys = Object.keys(res.detection.languages).map((l) => l.toLowerCase());
  return {
    languages: langKeys,
    frameworks: res.detection.frameworks,
    hasDocker: res.detection.infrastructure.includes('Docker') || langKeys.includes('docker'),
    hasKubernetes: res.detection.infrastructure.includes('Kubernetes') || res.detection.infrastructure.includes('Kubernetes / Helm') || langKeys.includes('kubernetes'),
    scanDurationMs: res.detection.scanDurationMs,
    detection: res.detection,
  };
}
