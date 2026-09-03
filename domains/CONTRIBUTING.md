# Contributing an ecosystem to the Master Domain Index

The Master Domain Index maps file paths to the bot's built-in reviewer personas so that persona
routing understands "this is a Rust source file" or "this is a Terraform module" without every
contributor needing to know what a persona is. It has two layers:

- **Layer 1 — `domains/ecosystems/<ecosystem>.json`.** One file per language/tooling ecosystem.
  This is the layer you edit.
- **Layer 2 — `domains/classes.json`.** The curated class → persona matrix. This is out of scope
  for ecosystem contributions — you never need to touch it, and PRs that only add an ecosystem
  should not modify it.

## Adding or updating an ecosystem

1. Create or edit `domains/ecosystems/<ecosystem>.json` with this shape:

   ```json
   {
     "ecosystem": "my-ecosystem",
     "description": "One line describing the toolchain",
     "classes": {
       "source": ["**/*.myext"],
       "test": ["**/*_test.myext", "tests/**"]
     }
   }
   ```

   - `ecosystem` and `description` are non-empty strings.
   - `classes` maps one or more of the 14 class names below to a non-empty list of glob patterns.
   - You don't have to use every class — most ecosystems only need `source`, `test`,
     `deps-manifest`, `lockfile`, `database`, and `config`.

2. Glob patterns use git/CodeRabbit-style semantics, matched against the full repo-relative path
   (**not** Node `minimatch`/`picomatch` defaults, and **not** Python `fnmatch`):

   | Token   | Meaning                                                        |
   | ------- | --------------------------------------------------------------- |
   | `**`    | any number of path segments, **including zero**                 |
   | `*`     | anything within one segment (never crosses `/`)                 |
   | `?`     | exactly one non-`/` character                                   |
   | `{a,b}` | brace alternation (empty/blank alternatives are ignored)         |

   Examples: `lib/**/*.ex` matches both `lib/foo.ex` and `lib/a/b/foo.ex`. `*.ex` matches
   `foo.ex` but not `a/foo.ex` — use `**/*.ex` for "anywhere in the tree".

3. Rebuild and check the compiled index:

   ```bash
   npm run domains:build   # regenerates domains/compiled-index.json
   npm run domains:check   # fails if it's stale — this also runs before every `npm test`
   ```

4. Run the domain test suite:

   ```bash
   npx vitest run tests/unit/domainIndex.test.ts
   ```

## The class vocabulary (fixed at 14)

`source`, `test`, `docs`, `deps-manifest`, `lockfile`, `ci`, `infra`, `database`, `config`,
`ui-styles`, `i18n`, `license`, `scripts`, `assets`.

This list is fixed — adding a 15th class is a design decision (it needs a Layer 2 persona mapping
too), not a per-ecosystem contribution. Open an issue if you think a new class is needed.

## What this PR does not do yet

Nothing in the review pipeline consumes the Master Domain Index yet — `resolveFileDomains` in
`src/pipeline/domainIndex.ts` is the primitive a follow-up change will wire into persona/file
routing. Adding or editing an ecosystem today changes `domains/compiled-index.json` and is
covered by tests, but has no runtime effect until that follow-up lands.
