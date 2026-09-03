# Legacy panel runtime

Lock-backed Node graph for the composite Action **legacy** engine.

The Action used to `npm install` `js-yaml` and `@openrouter/sdk` with
`--prefix "$GITHUB_ACTION_PATH"` and `--no-package-lock`. npm then reified the
**root** `package.json` (Next.js, React, Vitest, …) on every review job — that
is the ~800 Mi / 80 s spike, not the persona panel.

This directory is the only install root for that path:

- `package.json` / `package-lock.json` pin the two runtime packages
- `Dockerfile.legacy-runtime` bakes the same graph in CI (SBOM, size gate)
- the Action runs `npm ci --prefix "$GITHUB_ACTION_PATH/legacy-runtime"` and
  sets `NODE_PATH` to that `node_modules`

Never install into the Action checkout root.
