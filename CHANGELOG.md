# Changelog

## [1.28.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.5...v1.28.6) (2026-09-04)


### Bug Fixes

* **ci:** keep the test-parse gate local, drop it from the required job (REL-570) ([#464](https://github.com/review-yeti-ai/review-yeti-bot/issues/464)) ([bd19aa0](https://github.com/review-yeti-ai/review-yeti-bot/commit/bd19aa0b3d63c4121356a2c620d1b39bee18257b))

## [1.28.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.4...v1.28.5) (2026-09-04)


### Bug Fixes

* **ci:** make lint cover test files with a parse gate (REL-570) ([#462](https://github.com/review-yeti-ai/review-yeti-bot/issues/462)) ([1fcf8a7](https://github.com/review-yeti-ai/review-yeti-bot/commit/1fcf8a7f9fbf18555a35fb30f98fbc2b1c89beeb))

## [1.28.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.3...v1.28.4) (2026-09-04)


### Bug Fixes

* **test:** scale wall-clock budgets by worker contention (REL-560) ([#460](https://github.com/review-yeti-ai/review-yeti-bot/issues/460)) ([f0697ac](https://github.com/review-yeti-ai/review-yeti-bot/commit/f0697acedffa904c6ab6b108d9a921e3d0f8355f))

## [1.28.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.2...v1.28.3) (2026-09-04)


### Performance

* **test:** enable vitest fileParallelism (REL-560) ([#458](https://github.com/review-yeti-ai/review-yeti-bot/issues/458)) ([157cbbf](https://github.com/review-yeti-ai/review-yeti-bot/commit/157cbbf63a88063def81e626d9049c0943189ffc))

## [1.28.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.1...v1.28.2) (2026-09-04)


### Bug Fixes

* **test:** give each worker a disposable state root instead of sharing /tmp/ct-review-bot (REL-560) ([#456](https://github.com/review-yeti-ai/review-yeti-bot/issues/456)) ([b82b11e](https://github.com/review-yeti-ai/review-yeti-bot/commit/b82b11e01a00bcc80e0ca0988603419dc7054f72))

## [1.28.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.0...v1.28.1) (2026-09-04)


### Performance

* **test:** move the npm pack/install closure out of the per-PR gate (REL-559) ([#453](https://github.com/review-yeti-ai/review-yeti-bot/issues/453)) ([f2d38bf](https://github.com/review-yeti-ai/review-yeti-bot/commit/f2d38bfc523feec404befbc937418cb36a9cd3c0))

## [1.28.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.27.0...v1.28.0) (2026-09-04)


### Features

* **oidc:** support wildcard workflow refs/shas and allow app-gate in deploy template ([#448](https://github.com/review-yeti-ai/review-yeti-bot/issues/448)) ([5acd512](https://github.com/review-yeti-ai/review-yeti-bot/commit/5acd5127c5250a25074af92f11d02f463c6dec00))
* **review:** carry Review Yeti lanes per domain and review the full diff when a blocking owner reruns (REL-552) ([#444](https://github.com/review-yeti-ai/review-yeti-bot/issues/444)) ([544b66b](https://github.com/review-yeti-ai/review-yeti-bot/commit/544b66b01e7986c8cbf89f711c74b933cb055167))


### Bug Fixes

* **dispatch:** allow policy.allowAppGate in action dispatch service entrypoint ([#450](https://github.com/review-yeti-ai/review-yeti-bot/issues/450)) ([2742cf4](https://github.com/review-yeti-ai/review-yeti-bot/commit/2742cf45b3e32215465b5cea3b96105f25aba7a4))
* **review:** resolve trusted repair-delta parents on the central repository_dispatch path (REL-553) ([#447](https://github.com/review-yeti-ai/review-yeti-bot/issues/447)) ([dc17d9c](https://github.com/review-yeti-ai/review-yeti-bot/commit/dc17d9c77d630da1cbc83a12fe93661c2e858ac5))
* **test:** bound the wall-clock capacity-wait assertions instead of pinning them [no-linear] ([#451](https://github.com/review-yeti-ai/review-yeti-bot/issues/451)) ([8d27250](https://github.com/review-yeti-ai/review-yeti-bot/commit/8d27250ce340e2393416b2349c3c3a057c3a3036))

## [1.27.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.26.0...v1.27.0) (2026-09-03)


### Features

* **doks:** support repository_dispatch central callers and optional OPENROUTER_BASE_URL ([#446](https://github.com/review-yeti-ai/review-yeti-bot/issues/446)) ([bce9193](https://github.com/review-yeti-ai/review-yeti-bot/commit/bce9193b45ae7ef1eae7677227c1563b5b007097))
* **domains:** add the community Master Domain Index (REL-551) ([#439](https://github.com/review-yeti-ai/review-yeti-bot/issues/439)) ([0009210](https://github.com/review-yeti-ai/review-yeti-bot/commit/000921031a9adcecbfcf25195eae24a7d39a1f73))
* **k8s:** support dual runner mode (generic vs prebaked) [no-linear] ([#443](https://github.com/review-yeti-ai/review-yeti-bot/issues/443)) ([d62d553](https://github.com/review-yeti-ai/review-yeti-bot/commit/d62d5536e01dd423fdaac32870110581a5a2463b))


### Bug Fixes

* **crd:** allow public GHCR worker image in v1alpha2 CRD schema [no-linear] ([#441](https://github.com/review-yeti-ai/review-yeti-bot/issues/441)) ([40ea4b9](https://github.com/review-yeti-ai/review-yeti-bot/commit/40ea4b9bc103dc15adae7af50a3b0bd7b71c975d))
* **review:** scope forward-merge diffs past follow-up commits on top of the merge ([#445](https://github.com/review-yeti-ai/review-yeti-bot/issues/445)) ([c9d406b](https://github.com/review-yeti-ai/review-yeti-bot/commit/c9d406ba4b88be8918fc2998b3189ac8a885f867))

## [1.26.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.25.1...v1.26.0) (2026-09-03)


### Features

* **k8s:** support public GHCR trusted worker and operator images [no-linear] ([#437](https://github.com/review-yeti-ai/review-yeti-bot/issues/437)) ([d14c91d](https://github.com/review-yeti-ai/review-yeti-bot/commit/d14c91d3cd9c8e22a62aa043a982a952ac7d4dc4))


### Bug Fixes

* **ci:** native Blacksmith multi-arch GHCR publish [no-linear] ([#434](https://github.com/review-yeti-ai/review-yeti-bot/issues/434)) ([e561b8f](https://github.com/review-yeti-ai/review-yeti-bot/commit/e561b8f7463c366ae123241aff5db146596c11c0))
* **ci:** size-gate worker as smaller than bot, public before gate [no-linear] ([#436](https://github.com/review-yeti-ai/review-yeti-bot/issues/436)) ([22abccc](https://github.com/review-yeti-ai/review-yeti-bot/commit/22abccc87a5c5a6db9154b3ae675d13b8c1bfd16))
* **review:** disable undici 300s headersTimeout on 15-minute streams ([#435](https://github.com/review-yeti-ai/review-yeti-bot/issues/435)) ([ff6438d](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff6438d51319ea2ad6d2724c8d24af60b4e778a4))
* **review:** floor reasoning effort and bound output tokens on direct-transport recovery ([#438](https://github.com/review-yeti-ai/review-yeti-bot/issues/438)) ([8feb3e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/8feb3e498eecba13da302d9e39c1bbbe83249e7e))
* **review:** wait for streaming headers on the 15-minute generation clock [no-linear] ([#432](https://github.com/review-yeti-ai/review-yeti-bot/issues/432)) ([3c20d60](https://github.com/review-yeti-ai/review-yeti-bot/commit/3c20d606b49b6e4e15884d87e7e62bfd52eeefd0))

## [1.25.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.25.0...v1.25.1) (2026-09-03)


### Bug Fixes

* **review:** keep requested reasoning effort on direct recovery [no-linear] ([#429](https://github.com/review-yeti-ai/review-yeti-bot/issues/429)) ([7d84689](https://github.com/review-yeti-ai/review-yeti-bot/commit/7d8468998a8d7d82e649267233a0bea1356f04db))
* **review:** let live thinking streams run until the 15-minute max [no-linear] ([#431](https://github.com/review-yeti-ai/review-yeti-bot/issues/431)) ([99522c3](https://github.com/review-yeti-ai/review-yeti-bot/commit/99522c369edbda1a53f87d40eeada1e5405f654d))

## [1.25.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.24.2...v1.25.0) (2026-09-03)


### Features

* **ci:** publish digest-pinned images to GHCR [no-linear] ([#425](https://github.com/review-yeti-ai/review-yeti-bot/issues/425)) ([b6465be](https://github.com/review-yeti-ai/review-yeti-bot/commit/b6465be25cf62a9eced0292610faa0cdf6bfc12f))
* **doks:** admit app-gate publication on PRReviewJob [no-linear] ([#424](https://github.com/review-yeti-ai/review-yeti-bot/issues/424)) ([ade319d](https://github.com/review-yeti-ai/review-yeti-bot/commit/ade319d4c559e3e8339c00c7705cd75a53360615))


### Bug Fixes

* bake legacy panel runtime in CI (stop 800 Mi npm spike) ([#421](https://github.com/review-yeti-ai/review-yeti-bot/issues/421)) ([ba0cbef](https://github.com/review-yeti-ai/review-yeti-bot/commit/ba0cbefb962c7735fdabe522264edbdd5c56d3df))
* **ci:** build bot dist and publish GHCR images as public [no-linear] ([#426](https://github.com/review-yeti-ai/review-yeti-bot/issues/426)) ([9e0b1f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/9e0b1f86b58c303fd8ce1da83718173c8e8a9b9c))
* **review:** recover Ollama content stalls with reasoning disabled [no-linear] ([#428](https://github.com/review-yeti-ai/review-yeti-bot/issues/428)) ([447ea47](https://github.com/review-yeti-ai/review-yeti-bot/commit/447ea470ec152bc26ac043e64ee341d1fa448a5d))
* **review:** separate content-stall inactivity from a runaway-reasoning budget ([#427](https://github.com/review-yeti-ai/review-yeti-bot/issues/427)) ([998e92b](https://github.com/review-yeti-ai/review-yeti-bot/commit/998e92ba549144b0bfc33659fe2da6365dfa7302))
* **review:** unlimited tokens, none first-pass, six-lane Ollama ([#423](https://github.com/review-yeti-ai/review-yeti-bot/issues/423)) ([b8dbf30](https://github.com/review-yeti-ai/review-yeti-bot/commit/b8dbf30fe184d728425e1d27f77bfa06e8f598a9))

## [1.24.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.24.1...v1.24.2) (2026-09-02)


### Bug Fixes

* **action:** fall back to a local diff when the GitHub diff API 406s ([#419](https://github.com/review-yeti-ai/review-yeti-bot/issues/419)) ([e97bcfa](https://github.com/review-yeti-ai/review-yeti-bot/commit/e97bcfaa469558f5ad5de2acc22ee99d629a8672))

## [1.24.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.24.0...v1.24.1) (2026-09-02)


### Bug Fixes

* **action:** fall back after malformed OpenRouter output ([5b6a23e](https://github.com/review-yeti-ai/review-yeti-bot/commit/5b6a23effbaa0ff9a0aa17aba8c59769af2e564f))
* **action:** fall back after malformed OpenRouter output ([85171f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/85171f817582aa0f48b3e2c6cc7f2345a1d22c04))

## [1.24.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.23.1...v1.24.0) (2026-09-02)


### Features

* **qualification:** compare sanitized finding overlap ([d88d5b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/d88d5b7db076f7c03a50bcd1f357668a71552024))
* **qualification:** compare sanitized finding overlap ([81c1fb9](https://github.com/review-yeti-ai/review-yeti-bot/commit/81c1fb94d943aa95707dc98b8eea4e1b4dc50a24))


### Bug Fixes

* **action:** remove fixed default diff cap ([25d3560](https://github.com/review-yeti-ai/review-yeti-bot/commit/25d3560d584fc200e35d356f1caf8154c1c0ebc0))

## [1.23.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.23.0...v1.23.1) (2026-09-02)


### Bug Fixes

* **ollama:** coordinate shared capacity before review requests ([#410](https://github.com/review-yeti-ai/review-yeti-bot/issues/410)) ([52728ed](https://github.com/review-yeti-ai/review-yeti-bot/commit/52728ed515627f3f01e4ded8122b1c5b13ac04df))

## [1.23.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.22.2...v1.23.0) (2026-09-02)


### Features

* **doks:** bind qualification receipts to execution identity ([92223b2](https://github.com/review-yeti-ai/review-yeti-bot/commit/92223b2fb91852328958141a849fab46ce42e194))
* **doks:** bind qualification receipts to execution identity ([2863fd3](https://github.com/review-yeti-ai/review-yeti-bot/commit/2863fd33b3018bfe3c0f2370a6ee4ac862e7c374))

## [1.22.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.22.1...v1.22.2) (2026-09-02)


### Bug Fixes

* align same-head qualification verdicts ([11de7bb](https://github.com/review-yeti-ai/review-yeti-bot/commit/11de7bb79902a1ec0efd75579468e71451133e9e))
* align same-head qualification with production verdict policy ([12e0f40](https://github.com/review-yeti-ai/review-yeti-bot/commit/12e0f40031d95efae09a5909a5d8c805a4ec2820))

## [1.22.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.22.0...v1.22.1) (2026-09-02)


### Bug Fixes

* **doks:** recognize same-head worker contracts ([d407a6d](https://github.com/review-yeti-ai/review-yeti-bot/commit/d407a6d3cce7021b5a2d65bb610a4376c634ba59))
* **doks:** recognize same-head worker contracts ([a52fdc7](https://github.com/review-yeti-ai/review-yeti-bot/commit/a52fdc72fd3fe0b10720be6abf6fce7a2f6a0c73))

## [1.22.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.21.2...v1.22.0) (2026-09-02)


### Features

* **doks:** add read-only same-head qualification ([96bedaf](https://github.com/review-yeti-ai/review-yeti-bot/commit/96bedafeb9cd7882abcb020e2a9c4d6bbe17ccec))
* **doks:** admit read-only same-head qualification ([5a18ff7](https://github.com/review-yeti-ai/review-yeti-bot/commit/5a18ff74e81fe0365b6f1ec6fc9afb0d2e7a8943))
* **github:** mint repository-scoped review tokens ([bf92e4d](https://github.com/review-yeti-ai/review-yeti-bot/commit/bf92e4d5c909913c1603a081e1f0459899c1e13f))
* **worker:** add same-head DOKS qualification ([fd6da60](https://github.com/review-yeti-ai/review-yeti-bot/commit/fd6da6014277c9ed168527a63455d17ad74e0499))
* **worker:** bind qualification input to exact PR head ([73154e0](https://github.com/review-yeti-ai/review-yeti-bot/commit/73154e07ca9363488f47486fdc0c4ff0ff98c4d8))

## [1.21.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.21.1...v1.21.2) (2026-09-02)


### Bug Fixes

* **doks:** preserve full-panel deadline budget ([#397](https://github.com/review-yeti-ai/review-yeti-bot/issues/397)) ([ea05dac](https://github.com/review-yeti-ai/review-yeti-bot/commit/ea05dac5b1d50a2aaffefe739a00d0b424123499))

## [1.21.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.21.0...v1.21.1) (2026-09-01)


### Bug Fixes

* **review:** trust GitHub normalized workflow refs ([#395](https://github.com/review-yeti-ai/review-yeti-bot/issues/395)) ([389f8cc](https://github.com/review-yeti-ai/review-yeti-bot/commit/389f8cc51aa0e2ffd78f8c2ab0195b247d2d610c))

## [1.21.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.5...v1.21.0) (2026-09-01)


### Features

* **review:** optimize OpenRouter prompt caching ([#393](https://github.com/review-yeti-ai/review-yeti-bot/issues/393)) ([4ce45b5](https://github.com/review-yeti-ai/review-yeti-bot/commit/4ce45b589f9b9ce7fa3a36965999aa5b18e37fa2))

## [1.20.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.4...v1.20.5) (2026-09-01)


### Bug Fixes

* **review:** separate capacity and request deadlines ([#391](https://github.com/review-yeti-ai/review-yeti-bot/issues/391)) ([412ddb8](https://github.com/review-yeti-ai/review-yeti-bot/commit/412ddb8ea967a4bd71024e46c251c703e3cb65bd))

## [1.20.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.3...v1.20.4) (2026-09-01)


### Bug Fixes

* **review:** bind repair reuse to workflow sha ([#389](https://github.com/review-yeti-ai/review-yeti-bot/issues/389)) ([30780a9](https://github.com/review-yeti-ai/review-yeti-bot/commit/30780a95e4cfee0cfe69cde0c2a6347c114f9231))

## [1.20.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.2...v1.20.3) (2026-09-01)


### Bug Fixes

* **release:** use workflow-capable v1 promotion token ([#386](https://github.com/review-yeti-ai/review-yeti-bot/issues/386)) ([42e8776](https://github.com/review-yeti-ai/review-yeti-bot/commit/42e87769aee977603c3042ea835404f220dee181))

## [1.20.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.1...v1.20.2) (2026-09-01)


### Bug Fixes

* advance OpenRouter timeout recovery to fallback model ([#383](https://github.com/review-yeti-ai/review-yeti-bot/issues/383)) ([12f74ad](https://github.com/review-yeti-ai/review-yeti-bot/commit/12f74add0a6a0dc9102e7b7e2709c174efde3923))

## [1.20.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.20.0...v1.20.1) (2026-09-01)


### Bug Fixes

* **review:** release cancelled OpenRouter streams ([#381](https://github.com/review-yeti-ai/review-yeti-bot/issues/381)) ([cd91241](https://github.com/review-yeti-ai/review-yeti-bot/commit/cd9124140e01f333090b6a4f60f81a1f35ff841c))

## [1.20.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.5...v1.20.0) (2026-09-01)


### Features

* **qualification:** add strict panel schemas and opt-in operator profile ([#378](https://github.com/review-yeti-ai/review-yeti-bot/issues/378)) ([58d6964](https://github.com/review-yeti-ai/review-yeti-bot/commit/58d6964cae6e586e720d339f2c29dc18bc423f56))


### Bug Fixes

* **review:** honor streamed reasoning and timeout policy ([#379](https://github.com/review-yeti-ai/review-yeti-bot/issues/379)) ([8b226a2](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b226a2d2009a2621d60ba5bd5d96bbffb6c973b))

## [1.19.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.4...v1.19.5) (2026-09-01)


### Bug Fixes

* **qualification:** align DOKS panel with OpenRouter contract ([#375](https://github.com/review-yeti-ai/review-yeti-bot/issues/375)) ([6af33f7](https://github.com/review-yeti-ai/review-yeti-bot/commit/6af33f7e179bc8e99a8faec96dbd23654481c032))
* **review:** keep timeout quarantine lane-local ([#377](https://github.com/review-yeti-ai/review-yeti-bot/issues/377)) ([5405565](https://github.com/review-yeti-ai/review-yeti-bot/commit/54055651a8f42d09014ef99c423a71982bf31e44))

## [1.19.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.3...v1.19.4) (2026-09-01)


### Bug Fixes

* **review:** recover malformed primary route before failover ([#373](https://github.com/review-yeti-ai/review-yeti-bot/issues/373)) ([965cc98](https://github.com/review-yeti-ai/review-yeti-bot/commit/965cc98f83c7d00a43163008cbf39210639bccc9))

## [1.19.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.2...v1.19.3) (2026-09-01)


### Bug Fixes

* **review:** upgrade Synthetic fallback to GLM 5.3 Flash ([1f4b25e](https://github.com/review-yeti-ai/review-yeti-bot/commit/1f4b25e859cd2792a8e713d506f2c35b3c19fb60))

## [1.19.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.1...v1.19.2) (2026-09-01)


### Bug Fixes

* abort settled review transport attempts ([#369](https://github.com/review-yeti-ai/review-yeti-bot/issues/369)) ([9687b98](https://github.com/review-yeti-ai/review-yeti-bot/commit/9687b98385b124daa8cad4453e29a9067c65cbc1))

## [1.19.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.19.0...v1.19.1) (2026-09-01)


### Bug Fixes

* **operator:** allow namespaced event recording ([c8291b1](https://github.com/review-yeti-ai/review-yeti-bot/commit/c8291b104693d4477dc289d83c6abd60fee91c72))

## [1.19.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.18.0...v1.19.0) (2026-09-01)


### Features

* **review:** bound trusted repair delta reviews ([#362](https://github.com/review-yeti-ai/review-yeti-bot/issues/362)) ([663f666](https://github.com/review-yeti-ai/review-yeti-bot/commit/663f666be8eebe04b66dab5989c8ef11cfe970e7))


### Bug Fixes

* **doks:** make runtime install checks executable ([d6ee241](https://github.com/review-yeti-ai/review-yeti-bot/commit/d6ee2417a6f7a40686f415e4b2fe85f6ad44d73d))

## [1.18.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.17.0...v1.18.0) (2026-09-01)


### Features

* **doks:** add inert review runtime installer ([#361](https://github.com/review-yeti-ai/review-yeti-bot/issues/361)) ([f7a964a](https://github.com/review-yeti-ai/review-yeti-bot/commit/f7a964aa4ca8c722433c7fc0feffc544ecf005c1))


### Bug Fixes

* bound OpenRouter 5xx recovery after timeout ([#360](https://github.com/review-yeti-ai/review-yeti-bot/issues/360)) ([f65b6d9](https://github.com/review-yeti-ai/review-yeti-bot/commit/f65b6d9d7194046176ce1af67ba0a5795c8cad04))
* respect reasoning-required OpenRouter models ([#358](https://github.com/review-yeti-ai/review-yeti-bot/issues/358)) ([0fae773](https://github.com/review-yeti-ai/review-yeti-bot/commit/0fae77361f4e918a871c77bcad47a242480508cb))

## [1.17.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.16.0...v1.17.0) (2026-09-01)


### Features

* **action:** add opt-in durable DOKS dispatch ([#316](https://github.com/review-yeti-ai/review-yeti-bot/issues/316)) ([fca07f6](https://github.com/review-yeti-ai/review-yeti-bot/commit/fca07f6d87b867a2082b5ea74b30c5a9cf9a9187))
* **dispatch:** add fail-closed review job projection ([#323](https://github.com/review-yeti-ai/review-yeti-bot/issues/323)) ([54bf862](https://github.com/review-yeti-ai/review-yeti-bot/commit/54bf862cd2bc7ce7d1b58928d864d64f9d3b457b))
* **dispatch:** add inert Kubernetes job projector ([#324](https://github.com/review-yeti-ai/review-yeti-bot/issues/324)) ([165a865](https://github.com/review-yeti-ai/review-yeti-bot/commit/165a865de9d0e6ea4fed5ff2cc7b9b6e1fc76a86))
* **dispatch:** add isolated DOKS admission service ([#318](https://github.com/review-yeti-ai/review-yeti-bot/issues/318)) ([d959330](https://github.com/review-yeti-ai/review-yeti-bot/commit/d9593305e93b68b4603153c4ed7bbc2744f91bf8))
* **operator:** add isolated PR workspace primitives ([#326](https://github.com/review-yeti-ai/review-yeti-bot/issues/326)) ([e42561a](https://github.com/review-yeti-ai/review-yeti-bot/commit/e42561abb5a847e5fdd614454580f3116ca56afa))
* **operator:** add race-safe workspace reclamation ([#327](https://github.com/review-yeti-ai/review-yeti-bot/issues/327)) ([5170c65](https://github.com/review-yeti-ai/review-yeti-bot/commit/5170c65e5049a9b3337885cf947995da6fbda8fd))
* **operator:** add receipt-only worker job contract ([f170010](https://github.com/review-yeti-ai/review-yeti-bot/commit/f1700100e79ff18b80ff5f099b8700af56cad119))
* **operator:** add receipt-only worker job contract ([2bde694](https://github.com/review-yeti-ai/review-yeti-bot/commit/2bde694d2909af67728ae056c36a0424452b8285))
* **operator:** define immutable review job v1alpha2 ([#325](https://github.com/review-yeti-ai/review-yeti-bot/issues/325)) ([9da4167](https://github.com/review-yeti-ai/review-yeti-bot/commit/9da41675572eed65d4da4c94d488b1642920b0c2))
* **operator:** persist bounded dispatch timing receipt ([#333](https://github.com/review-yeti-ai/review-yeti-bot/issues/333)) ([85733e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/85733e4202f1ee558ff71b97b6a92081ad8b2514))
* **operator:** record DOKS dispatch lifecycle timings ([#332](https://github.com/review-yeti-ai/review-yeti-bot/issues/332)) ([734a4ec](https://github.com/review-yeti-ai/review-yeti-bot/commit/734a4ecefcca810c440aa6c21e90d6f1aed5beba))
* **operator:** wire disabled v1alpha2 receipt controller ([6e52d81](https://github.com/review-yeti-ai/review-yeti-bot/commit/6e52d819685b6ab50043cca631aee87573b3ce6c))
* **operator:** wire disabled v1alpha2 receipt controller ([7d0c828](https://github.com/review-yeti-ai/review-yeti-bot/commit/7d0c828bce8dcbb59efebb550d032d73dd103980))
* retain partial stream timeout telemetry ([#353](https://github.com/review-yeti-ai/review-yeti-bot/issues/353)) ([339974d](https://github.com/review-yeti-ai/review-yeti-bot/commit/339974dcf370f561df97df18779367a26bfd8b3f))
* **review:** add capacity-aware provider dispatch ([#342](https://github.com/review-yeti-ai/review-yeti-bot/issues/342)) ([ab73676](https://github.com/review-yeti-ai/review-yeti-bot/commit/ab73676a1884a5b014d9e982fffc9a6eba1175f7))
* **worker:** add bounded panel qualification mode ([#346](https://github.com/review-yeti-ai/review-yeti-bot/issues/346)) ([c2e8ca6](https://github.com/review-yeti-ai/review-yeti-bot/commit/c2e8ca676eac9ed1189f4e858c7dcf6c5a4236af))
* **worker:** add bounded provider qualification mode ([#344](https://github.com/review-yeti-ai/review-yeti-bot/issues/344)) ([57d2d1e](https://github.com/review-yeti-ai/review-yeti-bot/commit/57d2d1e1a52a432196298d8ccc276dd0a30dd0a2))
* **worker:** add immutable worker image contract ([0c2bc4c](https://github.com/review-yeti-ai/review-yeti-bot/commit/0c2bc4c24265df79944ebc6f6f8dfc9e51b500b9))
* **worker:** add immutable worker image contract ([351b994](https://github.com/review-yeti-ai/review-yeti-bot/commit/351b994187a0a88afdf6a78548f17139464e57cb))
* **worker:** enforce receipt-only execution mode ([5b9523d](https://github.com/review-yeti-ai/review-yeti-bot/commit/5b9523d2a2c3b142faac6edcb3a1a0ffdec05a4d))
* **worker:** enforce receipt-only execution mode ([ee8eb9c](https://github.com/review-yeti-ai/review-yeti-bot/commit/ee8eb9cf79cfcae5e44c63be37cdc8cea7cc3e2e))


### Bug Fixes

* **action:** accept GitHub pipeline OIDC endpoint ([#319](https://github.com/review-yeti-ai/review-yeti-bot/issues/319)) ([558d650](https://github.com/review-yeti-ai/review-yeti-bot/commit/558d6507cc74eef0674b0b92f13e753d0a71d4b6))
* **action:** allow GitHub vstoken OIDC endpoint ([#320](https://github.com/review-yeti-ai/review-yeti-bot/issues/320)) ([d62b8b1](https://github.com/review-yeti-ai/review-yeti-bot/commit/d62b8b166ce7dd2fe233b305dff71953970b8f4c))
* **action:** trust GitHub OIDC service domain ([#321](https://github.com/review-yeti-ai/review-yeti-bot/issues/321)) ([924d36f](https://github.com/review-yeti-ai/review-yeti-bot/commit/924d36f4a52208d243b33b22bc3824e0350dea16))
* disable reasoning on timeout recovery ([#356](https://github.com/review-yeti-ai/review-yeti-bot/issues/356)) ([5959363](https://github.com/review-yeti-ai/review-yeti-bot/commit/5959363ad07def6c3efa0be66dede1a14cc8b095))
* **dispatch:** persist publication mode fail closed ([#322](https://github.com/review-yeti-ai/review-yeti-bot/issues/322)) ([427e96b](https://github.com/review-yeti-ai/review-yeti-bot/commit/427e96bda3969031e6fe66ff3434baf8eb0807e6))
* ignore empty streamed deltas for TTFT ([#352](https://github.com/review-yeti-ai/review-yeti-bot/issues/352)) ([40c2e6e](https://github.com/review-yeti-ai/review-yeti-bot/commit/40c2e6e3b36ae69da7a825a65030e9d848fc84eb))
* keep TTFT open until usable streamed output ([#350](https://github.com/review-yeti-ai/review-yeti-bot/issues/350)) ([af63949](https://github.com/review-yeti-ai/review-yeti-bot/commit/af63949a29d32287166ef2cb45c6602912f6adf9))
* **operator:** allow in-cluster API service ([#337](https://github.com/review-yeti-ai/review-yeti-bot/issues/337)) ([4988143](https://github.com/review-yeti-ai/review-yeti-bot/commit/49881439768078f3c6ce3438e9c86453e6672645))
* **operator:** allow translated DOKS API endpoint ([#340](https://github.com/review-yeti-ai/review-yeti-bot/issues/340)) ([10c463f](https://github.com/review-yeti-ai/review-yeti-bot/commit/10c463fbb0b5b582d463b9f6ae0d5b9608db9ea6))
* **operator:** record fast worker start timing ([#341](https://github.com/review-yeti-ai/review-yeti-bot/issues/341)) ([c9d6dbe](https://github.com/review-yeti-ai/review-yeti-bot/commit/c9d6dbe8d0de95bba81079509aa43ac3b24cb9ee))
* **operator:** release lease after rejected worker ([fe6ce95](https://github.com/review-yeti-ai/review-yeti-bot/commit/fe6ce9595f04d0d41b54cd26c97aff550e20fb85))
* recover bounded structured panel output ([#347](https://github.com/review-yeti-ai/review-yeti-bot/issues/347)) ([0674691](https://github.com/review-yeti-ai/review-yeti-bot/commit/06746910a36ccbb31fd58b8ee434d9ec042c7eea))
* **worker:** preserve injected live environment ([a5a958e](https://github.com/review-yeti-ai/review-yeti-bot/commit/a5a958e0b39d22cac5687390d818251267258b7e))

## [1.16.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.6...v1.16.0) (2026-08-30)


### Features

* qualify OpenRouter across three fixtures ([#310](https://github.com/review-yeti-ai/review-yeti-bot/issues/310)) ([24ef8c3](https://github.com/review-yeti-ai/review-yeti-bot/commit/24ef8c3bd784388f569b2d9c46580b23b5a4cff1))
* support explicit OpenRouter model fallbacks ([2180a7e](https://github.com/review-yeti-ai/review-yeti-bot/commit/2180a7e591916426fdadce96b9cc703fac9bd45d))


### Bug Fixes

* align OpenRouter allowlist with GLM-5.2 ([099578a](https://github.com/review-yeti-ai/review-yeti-bot/commit/099578ac2a3aaf02bd1a0ce89dfdf801a21e8de5))
* honor separated live-proof arguments ([#312](https://github.com/review-yeti-ai/review-yeti-bot/issues/312)) ([0250c0c](https://github.com/review-yeti-ai/review-yeti-bot/commit/0250c0cefad9d653475375c4f2c2de2408c57181))

## [1.15.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.5...v1.15.6) (2026-08-28)


### Bug Fixes

* **openrouter:** abort active streams at total deadline ([#302](https://github.com/review-yeti-ai/review-yeti-bot/issues/302)) ([34e1d76](https://github.com/review-yeti-ai/review-yeti-bot/commit/34e1d76791b9e75bee0b0e4ecccc8e743d5db947))

## [1.15.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.4...v1.15.5) (2026-08-27)


### Bug Fixes

* preserve reasoning during OpenRouter timeout recovery ([#300](https://github.com/review-yeti-ai/review-yeti-bot/issues/300)) ([7b1ab07](https://github.com/review-yeti-ai/review-yeti-bot/commit/7b1ab07d8806e8871e2675bdd5154eccfd63416e))

## [1.15.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.3...v1.15.4) (2026-08-27)


### Bug Fixes

* preserve findings during OpenRouter timeout recovery ([#298](https://github.com/review-yeti-ai/review-yeti-bot/issues/298)) ([173b3d5](https://github.com/review-yeti-ai/review-yeti-bot/commit/173b3d5acddf10a09d81cfda020403a70b26f510))

## [1.15.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.2...v1.15.3) (2026-08-27)


### Bug Fixes

* recover OpenRouter streaming timeouts ([#295](https://github.com/review-yeti-ai/review-yeti-bot/issues/295)) ([9c35639](https://github.com/review-yeti-ai/review-yeti-bot/commit/9c3563952790c158d609356cfbacdb5b527a8c56))

## [1.15.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.1...v1.15.2) (2026-08-27)


### Bug Fixes

* **review:** align reasoning output budgets and evaluation overrides ([#293](https://github.com/review-yeti-ai/review-yeti-bot/issues/293)) ([aa73bd4](https://github.com/review-yeti-ai/review-yeti-bot/commit/aa73bd4ef06bb49cb3a9e2d628f7d5525f912dbb))

## [1.15.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.15.0...v1.15.1) (2026-08-27)


### Bug Fixes

* **review:** enforce canonical model finding contract ([1ba40cc](https://github.com/review-yeti-ai/review-yeti-bot/commit/1ba40ccc72771fa25376f54e57916e377443476f))

## [1.15.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.14.2...v1.15.0) (2026-08-27)


### Features

* **output:** support schema contract with compatibility fallback ([54612bc](https://github.com/review-yeti-ai/review-yeti-bot/commit/54612bcd1fbd01fe47e430a5a1b8b3d09d1256b3))

## [1.14.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.14.1...v1.14.2) (2026-08-27)


### Bug Fixes

* **telemetry:** retain OpenRouter fallback attribution ([#287](https://github.com/review-yeti-ai/review-yeti-bot/issues/287)) ([57c453d](https://github.com/review-yeti-ai/review-yeti-bot/commit/57c453d346d6ed25a1a753969d15cb8eaf3904d3))

## [1.14.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.14.0...v1.14.1) (2026-08-27)


### Bug Fixes

* **streaming:** bound active generation wall clock ([#285](https://github.com/review-yeti-ai/review-yeti-bot/issues/285)) ([fbca6d8](https://github.com/review-yeti-ai/review-yeti-bot/commit/fbca6d870c47be0f6bbbac4362b1a575902d5ff1))

## [1.14.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.13.2...v1.14.0) (2026-08-27)


### Features

* **openrouter:** harden bounded production-readiness path ([#283](https://github.com/review-yeti-ai/review-yeti-bot/issues/283)) ([541e97b](https://github.com/review-yeti-ai/review-yeti-bot/commit/541e97b9742abbd509ba9eff8651649bbfbcc9ee))

## [1.13.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.13.1...v1.13.2) (2026-08-26)


### Bug Fixes

* **telemetry:** preserve OpenRouter upstream attribution ([#281](https://github.com/review-yeti-ai/review-yeti-bot/issues/281)) ([6c5127d](https://github.com/review-yeti-ai/review-yeti-bot/commit/6c5127da400e370a552e0a2f19c4372b85d6f2f4))

## [1.13.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.13.0...v1.13.1) (2026-08-26)


### Bug Fixes

* **openrouter:** bound active stream lifetime ([#278](https://github.com/review-yeti-ai/review-yeti-bot/issues/278)) ([9eaab7f](https://github.com/review-yeti-ai/review-yeti-bot/commit/9eaab7fc59ed0ec12a924d1fb5f7999b35b82720))

## [1.13.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.12.0...v1.13.0) (2026-08-26)


### Features

* **telemetry:** record output contract provenance ([#276](https://github.com/review-yeti-ai/review-yeti-bot/issues/276)) ([9bd00c4](https://github.com/review-yeti-ai/review-yeti-bot/commit/9bd00c487809dbd81a6a6f5e64566bec76353c9c))

## [1.12.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.11.0...v1.12.0) (2026-08-26)


### Features

* **ollama:** derive deterministic review seeds ([#266](https://github.com/review-yeti-ai/review-yeti-bot/issues/266)) ([0035fed](https://github.com/review-yeti-ai/review-yeti-bot/commit/0035fed15e26bf7102760c88affe230ad5dbb754))
* **telemetry:** classify bounded model output shapes ([#265](https://github.com/review-yeti-ai/review-yeti-bot/issues/265)) ([5b20127](https://github.com/review-yeti-ai/review-yeti-bot/commit/5b20127802742ec585bcb4c0c8aa5eacbabd05f9))


### Bug Fixes

* **release:** document conventional commit requirement ([#275](https://github.com/review-yeti-ai/review-yeti-bot/issues/275)) ([649876c](https://github.com/review-yeti-ai/review-yeti-bot/commit/649876cb3c7aa3bec33262d94986328556c44b6d))
* **review:** align prompt with available evidence ([#263](https://github.com/review-yeti-ai/review-yeti-bot/issues/263)) ([c3513d1](https://github.com/review-yeti-ai/review-yeti-bot/commit/c3513d1708452ce20ddf00bd875e708bb6ff0b3a))
* **telemetry:** retain bounded model response attempts ([#267](https://github.com/review-yeti-ai/review-yeti-bot/issues/267)) ([47b835a](https://github.com/review-yeti-ai/review-yeti-bot/commit/47b835ab5ebb8b430bf4f5cf138b49cc63b58703))

## [1.11.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.10.1...v1.11.0) (2026-08-25)


### Features

* **config:** add execution profile request parity ([#253](https://github.com/review-yeti-ai/review-yeti-bot/issues/253)) ([233d21c](https://github.com/review-yeti-ai/review-yeti-bot/commit/233d21c1549090ef09155c1b0a47175a3ad8d43c))
* **config:** validate canonical execution profiles ([#252](https://github.com/review-yeti-ai/review-yeti-bot/issues/252)) ([0417f5c](https://github.com/review-yeti-ai/review-yeti-bot/commit/0417f5cba2e4bf854f6d17666e72ceb932db8d25))
* expand licensing persona to enforce commercial entitlement integrity ([#245](https://github.com/review-yeti-ai/review-yeti-bot/issues/245)) ([5184547](https://github.com/review-yeti-ai/review-yeti-bot/commit/51845470af0262145457fa0e3b7211e032b48c70))
* **receipts:** add provider telemetry receipt ([9ed68b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/9ed68b716e2eac8cca6cf458a8b9aafccca259f4))
* **receipts:** record provider outcome telemetry ([#251](https://github.com/review-yeti-ai/review-yeti-bot/issues/251)) ([8b1a91b](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b1a91b2b4c9161df9d4462d38442f290508a089))


### Bug Fixes

* bound OpenRouter review recovery and telemetry ([3249d95](https://github.com/review-yeti-ai/review-yeti-bot/commit/3249d95f104344c444d9b251f2315c85ac7822fc))
* cap Ollama request concurrency ([#261](https://github.com/review-yeti-ai/review-yeti-bot/issues/261)) ([e309780](https://github.com/review-yeti-ai/review-yeti-bot/commit/e309780b6ffe7848032100357ec26a6b3a30b78d))
* **receipts:** attribute provider from configured transport ([#248](https://github.com/review-yeti-ai/review-yeti-bot/issues/248)) ([9b91407](https://github.com/review-yeti-ai/review-yeti-bot/commit/9b91407526af4b201b29fd512721a868ea9e2265))
* **review:** resolve exact gitlink metadata ([#240](https://github.com/review-yeti-ai/review-yeti-bot/issues/240)) ([64bfc55](https://github.com/review-yeti-ai/review-yeti-bot/commit/64bfc5532503871ef1f783fc3ce3bc25d1ec69b1))

## [1.10.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.10.0...v1.10.1) (2026-08-22)


### Bug Fixes

* **ci:** verify main after merge without arming the deploy job ([#237](https://github.com/review-yeti-ai/review-yeti-bot/issues/237)) ([5ff23f3](https://github.com/review-yeti-ai/review-yeti-bot/commit/5ff23f33b9250fee21030ca8f5373fdd103bd2bb))
* **release:** stop force-moving published release tags on every merge ([#239](https://github.com/review-yeti-ai/review-yeti-bot/issues/239)) ([55e4295](https://github.com/review-yeti-ai/review-yeti-bot/commit/55e429502a7568ac7ba203f5409fa3c4b65d60e4))

## [1.10.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.12...v1.10.0) (2026-08-22)


### Features

* **review:** verified publication gate — falsification stage [NO-SHIP: acceptance failed] ([#159](https://github.com/review-yeti-ai/review-yeti-bot/issues/159)) ([f5b8c24](https://github.com/review-yeti-ai/review-yeti-bot/commit/f5b8c240030c77fdeb77aefc8fb8844e621c20eb))


### Bug Fixes

* **ci:** actually run the test suite on pull requests ([#234](https://github.com/review-yeti-ai/review-yeti-bot/issues/234)) ([5618b9b](https://github.com/review-yeti-ai/review-yeti-bot/commit/5618b9bb3dd80614b19c2d3162a58cbc6440e466))
* **pipeline:** ambient GitHub event must not overwrite an explicit PR head ([#235](https://github.com/review-yeti-ai/review-yeti-bot/issues/235)) ([c9aeec3](https://github.com/review-yeti-ai/review-yeti-bot/commit/c9aeec33066c719673dc1ee1382ca92068e008e8))
* **review:** falsification stage — decouple per-call verdict timeout from stage boundedness [re-measured: still NO-SHIP on recall] ([#233](https://github.com/review-yeti-ai/review-yeti-bot/issues/233)) ([e93a622](https://github.com/review-yeti-ai/review-yeti-bot/commit/e93a622a38a2a57f85f4fafaa1b188b0e502106d))
* **review:** reserve triple direct generation budget ([1d9d592](https://github.com/review-yeti-ai/review-yeti-bot/commit/1d9d592c8c6bd52952ad59628dec981568e22ed1))
* **test:** build dist/pipeline before tests so cassette replay is deterministic ([#231](https://github.com/review-yeti-ai/review-yeti-bot/issues/231)) ([7ef0ffa](https://github.com/review-yeti-ai/review-yeti-bot/commit/7ef0ffaed3bc76f70712f06a8cfce5aa0065cf36))

## [1.9.12](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.11...v1.9.12) (2026-08-21)


### Bug Fixes

* **review:** recover direct reasoning responses ([d5c4dac](https://github.com/review-yeti-ai/review-yeti-bot/commit/d5c4dacdb0e50862f85ed851c85e573837fd5106))
* **review:** recover direct reasoning responses ([dd95512](https://github.com/review-yeti-ai/review-yeti-bot/commit/dd955122d8b914ecf341247812a0912e1558230b))

## [1.9.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.10...v1.9.11) (2026-08-21)


### Bug Fixes

* **review:** preserve direct budget transport scope ([a646ab9](https://github.com/review-yeti-ai/review-yeti-bot/commit/a646ab942e4c51fc8f6010a1a7467c6116cb50a7))
* **review:** preserve direct budget transport scope ([a3292f9](https://github.com/review-yeti-ai/review-yeti-bot/commit/a3292f9cecdd74a52030dabc3a36ae7fa190e145))

## [1.9.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.9...v1.9.10) (2026-08-21)


### Bug Fixes

* **review:** reserve direct provider output budget ([de57a9f](https://github.com/review-yeti-ai/review-yeti-bot/commit/de57a9f53d8230312726d9b69b50a7d40b00396c))

## [1.9.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.8...v1.9.9) (2026-08-21)


### Bug Fixes

* **review:** failover dead providers; do not BLOCK on provider lanes ([#217](https://github.com/review-yeti-ai/review-yeti-bot/issues/217)) ([577c936](https://github.com/review-yeti-ai/review-yeti-bot/commit/577c9365f4a88961ef0c4e6af2085a5c65a46174))
* **review:** recover on admitted model route ([#221](https://github.com/review-yeti-ai/review-yeti-bot/issues/221)) ([f7a4f67](https://github.com/review-yeti-ai/review-yeti-bot/commit/f7a4f679857b84137deaa561a7767a750e17314d))

## [1.9.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.7...v1.9.8) (2026-08-21)


### Bug Fixes

* **review:** use policy-safe format recovery model ([#218](https://github.com/review-yeti-ai/review-yeti-bot/issues/218)) ([a8d1357](https://github.com/review-yeti-ai/review-yeti-bot/commit/a8d1357bb71010411464134b52546be96fbbfd56))

## [1.9.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.6...v1.9.7) (2026-08-21)


### Bug Fixes

* **review:** remove v1.9.6 conflict markers ([#216](https://github.com/review-yeti-ai/review-yeti-bot/issues/216)) ([c4eb036](https://github.com/review-yeti-ai/review-yeti-bot/commit/c4eb036ea7813ac67f1afeef56745cb30694105c))

## [1.9.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.5...v1.9.6) (2026-08-21)


### Bug Fixes

* **review:** preserve structured reasoning output ([a842ed0](https://github.com/review-yeti-ai/review-yeti-bot/commit/a842ed0a0e598edf4be8122c769e735122fc9206))
* **review:** preserve structured reasoning output ([df6bf74](https://github.com/review-yeti-ai/review-yeti-bot/commit/df6bf74370bcab87f7495cd43ffc5b2ed08e9cf3))
* **review:** route format recovery through policy model ([#212](https://github.com/review-yeti-ai/review-yeti-bot/issues/212)) ([2bfb4e2](https://github.com/review-yeti-ai/review-yeti-bot/commit/2bfb4e2f955b7e3094c3e4ae07569f43f4f382d4))

## [1.9.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.4...v1.9.5) (2026-08-21)


### Bug Fixes

* **review:** recover unparseable final transport output ([#210](https://github.com/review-yeti-ai/review-yeti-bot/issues/210)) ([ae0af0a](https://github.com/review-yeti-ai/review-yeti-bot/commit/ae0af0a6540475d75dc8ec4e1c5ade2957d0042e))

## [1.9.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.3...v1.9.4) (2026-08-21)


### Bug Fixes

* **release:** check out dispatched tag ([ae43414](https://github.com/review-yeti-ai/review-yeti-bot/commit/ae4341466669a81cde567fde63d785433b033fa4))
* **release:** check out dispatched tag ([97cc5e7](https://github.com/review-yeti-ai/review-yeti-bot/commit/97cc5e72613e9e664e2cb48d8c26e93bedeaed5b))
* **release:** decouple action promotion from DOKS ([fca1a88](https://github.com/review-yeti-ai/review-yeti-bot/commit/fca1a88b6813f475332e245bb77b49e5638ac044))
* **release:** decouple action promotion from DOKS ([cf4a91b](https://github.com/review-yeti-ai/review-yeti-bot/commit/cf4a91b32ca938cba58ae3d9c67d5be1e98826a1))
* **release:** remove obsolete doks deployment contract ([deb6f0c](https://github.com/review-yeti-ai/review-yeti-bot/commit/deb6f0c402c4c1fdaecbc25bfaa60cbaadc0a63d))
* **release:** remove obsolete DOKS deployment contract ([a440814](https://github.com/review-yeti-ai/review-yeti-bot/commit/a4408146ab109ed61b90c72f003b98ba9812a0ba))

## [1.9.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.2...v1.9.3) (2026-08-21)


### Bug Fixes

* **release:** use hosted deploy runner ([bd8a36c](https://github.com/review-yeti-ai/review-yeti-bot/commit/bd8a36cbd1e687b555d305c5f15784fdc5000700))
* **release:** use hosted deploy runner ([21c5a7b](https://github.com/review-yeti-ai/review-yeti-bot/commit/21c5a7ba208f63148716d28147f556e769cb2e56))

## [1.9.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.1...v1.9.2) (2026-08-21)


### Bug Fixes

* **release:** compare manifest to package version ([503e272](https://github.com/review-yeti-ai/review-yeti-bot/commit/503e272b103c469c320e81d95a37b2c8be38b756))
* **release:** compare manifest to package version ([aa5688f](https://github.com/review-yeti-ai/review-yeti-bot/commit/aa5688f674e640f5d156369f5f2b9cbaac871278))

## [1.9.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.9.0...v1.9.1) (2026-08-21)


### Bug Fixes

* **review:** bound panel completions and fail over malformed lanes ([056e8fe](https://github.com/review-yeti-ai/review-yeti-bot/commit/056e8feec8388bc22b322b6245c19bcf1cf861a5))
* **review:** bound panel completions and fail over unusable lanes ([43351ca](https://github.com/review-yeti-ai/review-yeti-bot/commit/43351cafe0fae1116bb3159427b42ddf1e0b6627))

## [1.9.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.8.5...v1.9.0) (2026-08-21)


### Features

* **release:** automate reviewed conventional semver releases ([5e10556](https://github.com/review-yeti-ai/review-yeti-bot/commit/5e10556b251f29d329e028e735e6352ad8d5afe7))


### Bug Fixes

* **release:** allow Release Please to open PRs ([c80ce1d](https://github.com/review-yeti-ai/review-yeti-bot/commit/c80ce1d1d1bcef2400ada5cc84ebb9e0e0c038c5))
* **release:** close provider classification and webhook test drift ([d67bfad](https://github.com/review-yeti-ai/review-yeti-bot/commit/d67bfaddfe1961b716188ec783db3e19696fc3ac))
* **release:** close provider classification and webhook test drift ([d116a29](https://github.com/review-yeti-ai/review-yeti-bot/commit/d116a291e3840d2dea1f7ad7c0ce52b4457804fe))
* **review:** use inactivity timeout for streams ([2a4f624](https://github.com/review-yeti-ai/review-yeti-bot/commit/2a4f624cbda33250d509312cb3bb626d319b8345))
* **review:** use inactivity timeout for streams ([78721eb](https://github.com/review-yeti-ai/review-yeti-bot/commit/78721eb58bf3f0c4dd256900f08348bff6edc33c))
