# Pi/MCP adapter

Review Yeti ships the GitHub Action, CLI/runtime contracts, and the Pi/MCP adapter in the same repository. The adapter is an in-repo package under `src/pi/`; it is not a separate product or dependency.

The repository boundary is shared, but the security boundary remains explicit:

- Pi receives only immutable review identity and trusted-base configuration.
- The adapter exposes a fixed read-only tool allowlist.
- It never executes shell commands, mutates GitHub, writes memory, or discovers arbitrary tools.
- Provider results are treated as untrusted and reduced to bounded metadata before they reach an agent.
- Capability refresh can remove tools but cannot widen the trusted allowlist.
- Endpoint, TLS, credential-reference, authorization-scope, cancellation, reconnect, and exact-head checks are enforced by the adapter.

The adapter's construction path is `loadTrustedBaseArtifactFromTrustedContext()` followed by `createPiMcpAdapter()`. Configuration must come from the immutable trusted-base artifact; pull-request files and arbitrary runtime configuration cannot select an endpoint, credential, scope, or tool.

Run its contract suite with:

```sh
npm run test:pi-adapter
```

The adapter is included in `npm run test:all`. The same repository can therefore release the Action, CLI, contracts, and Pi integration together while preserving the read-only runtime boundary.
