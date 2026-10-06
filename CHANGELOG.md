# Changelog

## [1.119.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.119.0...v1.119.1) (2026-10-06)


### Bug Fixes

* address deferred review findings and remove the one-off container prune job ([0264441](https://github.com/review-yeti-ai/review-yeti-bot/commit/0264441dc0cba73411792c33f17cce25f5b5c5db))

## [1.119.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.118.1...v1.119.0) (2026-10-06)


### Features

* **analytics:** modern Tremor UX dashboard, repository memory pivot platform, and swarm context compaction ([#1322](https://github.com/review-yeti-ai/review-yeti-bot/issues/1322)) ([e9bb294](https://github.com/review-yeti-ai/review-yeti-bot/commit/e9bb2944a9577024e3cd2f9021aacc9fee690eda))
* classify verified deletion evidence with advisory JEV questions (REL-1081) ([#1245](https://github.com/review-yeti-ai/review-yeti-bot/issues/1245)) ([ce0b4bd](https://github.com/review-yeti-ai/review-yeti-bot/commit/ce0b4bde27e4d916c0cd2e65c81a7cbe4c9edc9c))
* **composed:** early exit on max review findings and diff-only bypass for lockfiles ([#1221](https://github.com/review-yeti-ai/review-yeti-bot/issues/1221)) ([836e485](https://github.com/review-yeti-ai/review-yeti-bot/commit/836e48518948546d77c4699588ef586082b29678))
* **composed:** exclude binary archives from task planning and scale multi-path turn ceiling ([#1145](https://github.com/review-yeti-ai/review-yeti-bot/issues/1145)) ([75b65c6](https://github.com/review-yeti-ai/review-yeti-bot/commit/75b65c647aad2cb88081c9d5acbf230f965532fc))
* **composed:** swarm subagent context isolation, findings decomposition, and early blocker exit ([#1224](https://github.com/review-yeti-ai/review-yeti-bot/issues/1224)) ([88ccbd8](https://github.com/review-yeti-ai/review-yeti-bot/commit/88ccbd853d55c47bc46a0df5b7b4b51030992b33))
* **dashboard:** interactive review management portal and analytics dashboard ([#1280](https://github.com/review-yeti-ai/review-yeti-bot/issues/1280)) ([4bc6243](https://github.com/review-yeti-ai/review-yeti-bot/commit/4bc6243243595fee5b6e6aa325bd79e37f7e6f21))
* **grounding:** bound Zoekt index memory, add per-repo canary and a container memory floor (REL-1282) ([#1271](https://github.com/review-yeti-ai/review-yeti-bot/issues/1271)) ([02bd6a4](https://github.com/review-yeti-ai/review-yeti-bot/commit/02bd6a4822ecb5fa3430c618adbffc89fada7c65))
* **harness:** implement DOKS agentic harness lifecycle (API-3330, API-3333) ([#1093](https://github.com/review-yeti-ai/review-yeti-bot/issues/1093)) ([042c9f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/042c9f89c00c2f4ab999e50eb7d6508b75eec0b8))
* **infra:** add review-yeti.example.com custom domain and automated edge deployment workflow ([#1328](https://github.com/review-yeti-ai/review-yeti-bot/issues/1328)) ([a8ee9f9](https://github.com/review-yeti-ai/review-yeti-bot/commit/a8ee9f95e58425631e1fa751a0b9d32b2fd8d1ac))
* **live:** interactive 4-tier swarm and infrastructure topology visualizer with hover inspection ([#1325](https://github.com/review-yeti-ai/review-yeti-bot/issues/1325)) ([26b865b](https://github.com/review-yeti-ai/review-yeti-bot/commit/26b865b276b562b478189144b5200970177c5e05))
* **live:** progressive streaming swarm dataviz with per-task tokens and budget tracking (Refs: REL-1287) ([9395fbf](https://github.com/review-yeti-ai/review-yeti-bot/commit/9395fbf7d51bf640becb9fba48ddafb659402f23))
* make optional JEV classification part of review planning (REL-1081) ([#1253](https://github.com/review-yeti-ai/review-yeti-bot/issues/1253)) ([ff4eacd](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff4eacdee0272e97b3061e64248bbec43f74e44d))
* **mcp:** add native resources, SSE subscriptions, and advanced review tools ([#952](https://github.com/review-yeti-ai/review-yeti-bot/issues/952)) ([dc4bcb4](https://github.com/review-yeti-ai/review-yeti-bot/commit/dc4bcb490b9664c60050971c7f76aef8217c0c3a))
* **mcp:** bidirectional MCP wiring, DeepSeek review harness, and engine selection ([#976](https://github.com/review-yeti-ai/review-yeti-bot/issues/976)) ([a0f4065](https://github.com/review-yeti-ai/review-yeti-bot/commit/a0f406524e89bbcc4ffdd7531c2c3cca259f20a7))
* **mcp:** expand public MCP server with active jobs, cloudflare status, billable runtime, metrics, and cache purge ([f8b43d3](https://github.com/review-yeti-ai/review-yeti-bot/commit/f8b43d36cf6ac317532327ad1927fe70590d456c))
* **mcp:** expose review run timing on get_review_status ([#1099](https://github.com/review-yeti-ai/review-yeti-bot/issues/1099)) ([5d6bf9d](https://github.com/review-yeti-ai/review-yeti-bot/commit/5d6bf9d7d10cbb1e89ab6a40053fbafeabf86dd9))
* **mcp:** remote Model Context Protocol endpoint and 8-tool catalog on action dispatch [no-linear] ([#922](https://github.com/review-yeti-ai/review-yeti-bot/issues/922)) ([b6fec94](https://github.com/review-yeti-ai/review-yeti-bot/commit/b6fec9410453077c0bdf7019c0092d0f6ce5ffd1))
* **mcp:** support public read MCP access and /mcp route ([4e62699](https://github.com/review-yeti-ai/review-yeti-bot/commit/4e62699d9d1418405c38aafa26c7adc05624fbc4))
* **mcp:** surface compute_plane in getCloudflareStatus ([4afc868](https://github.com/review-yeti-ai/review-yeti-bot/commit/4afc8687c4e586c3d13b9225b7a6fc7aa8618886))
* **operator:** add configurable reconciler concurrency and panel persona task composition ([#1140](https://github.com/review-yeti-ai/review-yeti-bot/issues/1140)) ([c0e5d86](https://github.com/review-yeti-ai/review-yeti-bot/commit/c0e5d86d93612cc38e2787ead38946d7f0e21183))
* **operator:** decouple reconcile concurrency from worker admission (ADR 0720) ([#1183](https://github.com/review-yeti-ai/review-yeti-bot/issues/1183)) ([1abf669](https://github.com/review-yeti-ai/review-yeti-bot/commit/1abf66908efbc1db6dad536b0f8b671c7cc3c559))
* **operator:** forward REVIEW_YETI_DIFF_SHRINK to app-gate worker Jobs (REL-1079) ([#1017](https://github.com/review-yeti-ai/review-yeti-bot/issues/1017)) ([8ca7302](https://github.com/review-yeti-ai/review-yeti-bot/commit/8ca73020d9ac4f7b76a202f0a6da7174fbd427c4))
* **operator:** project Jev (TypeSafe) transport and shadow flag to the publishing worker (REL-1086) ([#1000](https://github.com/review-yeti-ai/review-yeti-bot/issues/1000)) ([f5ad773](https://github.com/review-yeti-ai/review-yeti-bot/commit/f5ad773306f07d67d6cea4fc4529b7d3990424af))
* **operator:** record worker exit forensics and spread worker pods (REL-1038) ([#981](https://github.com/review-yeti-ai/review-yeti-bot/issues/981)) ([8383c8a](https://github.com/review-yeti-ai/review-yeti-bot/commit/8383c8afe9150fc40763861e34e03f894ae22166))
* **orchestrator:** add Cloudflare serverless orchestrator alongside k8s-operator ([0147062](https://github.com/review-yeti-ai/review-yeti-bot/commit/0147062037a35474823ea43a27d0debc560d6a7f))
* **orchestrator:** add merge-group webhook attestation with composite delta hazard scan ([#1243](https://github.com/review-yeti-ai/review-yeti-bot/issues/1243)) ([8613ca7](https://github.com/review-yeti-ai/review-yeti-bot/commit/8613ca79adc7619b74823d489b35f1eab7954115))
* **orchestrator:** publish GitHub PR reviews and inline suggestions from review workflow ([c8d2438](https://github.com/review-yeti-ai/review-yeti-bot/commit/c8d2438a7f78c67567bba9809a3fc20048e635c3))
* page original diffs and pinned deleted source (REL-1077) ([#1244](https://github.com/review-yeti-ai/review-yeti-bot/issues/1244)) ([5b925b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/5b925b729693c2f4589081286c6d3a9cecbe05b7))
* **panel:** optional moderator skip on empty, fully covered runs; shadow eligibility on every run (REL-1139) ([#1088](https://github.com/review-yeti-ai/review-yeti-bot/issues/1088)) ([87d1c06](https://github.com/review-yeti-ai/review-yeti-bot/commit/87d1c063d8fac8d4852ab638f82e93d550be4ae2))
* **policy:** require resolution of P2 advisory findings before merge ([aa06014](https://github.com/review-yeti-ai/review-yeti-bot/commit/aa06014debd31004dfa7d3e7548f65f868489d92))
* **publish:** tag release images with their semver version ([#904](https://github.com/review-yeti-ai/review-yeti-bot/issues/904)) ([20ec37e](https://github.com/review-yeti-ai/review-yeti-bot/commit/20ec37ee1e9dfb6712f5c1558e0de2e2b4d8b45e))
* **REL-1160:** add durable review continuation execution ([9f87db3](https://github.com/review-yeti-ai/review-yeti-bot/commit/9f87db39835d4be9b405e57f9f328400b8d80989))
* **REL-1160:** default review continuations to true ([#1113](https://github.com/review-yeti-ai/review-yeti-bot/issues/1113)) ([2d97587](https://github.com/review-yeti-ai/review-yeti-bot/commit/2d975872299eedb475eacbdb0dd11709abc3862f))
* **REL-1198:** retain P2 findings across bounded incomplete review recovery ([#1148](https://github.com/review-yeti-ai/review-yeti-bot/issues/1148)) ([4ee1efd](https://github.com/review-yeti-ai/review-yeti-bot/commit/4ee1efde138b2f0441316808915aedb6a8598252))
* **REL-1250:** portable runner families + bounded build heap + same-SHA A/B hook ([#1259](https://github.com/review-yeti-ai/review-yeti-bot/issues/1259)) ([d7907c3](https://github.com/review-yeti-ai/review-yeti-bot/commit/d7907c34fe6cee82d3daa6633766f8e8c9a51ab8))
* retain content-free terminal review telemetry ([#1210](https://github.com/review-yeti-ai/review-yeti-bot/issues/1210)) ([ee6af90](https://github.com/review-yeti-ai/review-yeti-bot/commit/ee6af90532fdf94adad1e76e12078ba9317e62ce))
* **review:** apply v2 advisory profiles in composed reviews ([#1392](https://github.com/review-yeti-ai/review-yeti-bot/issues/1392)) ([739ee7d](https://github.com/review-yeti-ai/review-yeti-bot/commit/739ee7d7e2c774806ef07e28216cf3bd07d7d9db))
* **review:** delta-scoped incremental re-review behind REVIEW_YETI_INCREMENTAL_DELTA ([#1403](https://github.com/review-yeti-ai/review-yeti-bot/issues/1403)) ([d777b3b](https://github.com/review-yeti-ai/review-yeti-bot/commit/d777b3bec8dcb898c67c1bcde6b7f4bcba95184f))
* **review:** deterministic diff shrinking behind REVIEW_YETI_DIFF_SHRINK (REL-1079) ([#1009](https://github.com/review-yeti-ai/review-yeti-bot/issues/1009)) ([4970ec7](https://github.com/review-yeti-ai/review-yeti-bot/commit/4970ec759b2787a3dd7519e0a95c4b2332ff0359))
* **review:** incremental re-review on synchronize behind REVIEW_YETI_INCREMENTAL (REL-1084) ([#1028](https://github.com/review-yeti-ai/review-yeti-bot/issues/1028)) ([7d99027](https://github.com/review-yeti-ai/review-yeti-bot/commit/7d99027f019037333772b5ecb980d00a56d56994))
* **review:** Jev triage in shadow mode behind REVIEW_YETI_JEV_SHADOW (REL-1081) ([#1007](https://github.com/review-yeti-ai/review-yeti-bot/issues/1007)) ([4f27e81](https://github.com/review-yeti-ai/review-yeti-bot/commit/4f27e81a20615fd91cc4e2004d60b3fa0d57b96c))
* **review:** let non-authoritative runs rest on a qualifying WorkerReviewEvidence prior (REL-1084, REL-1085) ([#1061](https://github.com/review-yeti-ai/review-yeti-bot/issues/1061)) ([92df15f](https://github.com/review-yeti-ai/review-yeti-bot/commit/92df15f97f31b0ef73212917a84bdadeb8414cd4))
* **review:** map-reduce review for huge diffs behind REVIEW_YETI_MAP_REDUCE (REL-1083) ([#1038](https://github.com/review-yeti-ai/review-yeti-bot/issues/1038)) ([c505acd](https://github.com/review-yeti-ai/review-yeti-bot/commit/c505acd241c01867e3e0a5c1fff33bc526f28cb4))
* **review:** native passthrough mode — check passes without full panel [UAT-1740] ([#1382](https://github.com/review-yeti-ai/review-yeti-bot/issues/1382)) ([9a8de42](https://github.com/review-yeti-ai/review-yeti-bot/commit/9a8de42f4ff7fa382a9e2ef58897c629be00f3a2))
* **review:** passthrough posts service-owned SHIP check (REL-1330) ([#1383](https://github.com/review-yeti-ai/review-yeti-bot/issues/1383)) ([a64d9ba](https://github.com/review-yeti-ai/review-yeti-bot/commit/a64d9ba0d4198821ce95088e7350cdf75581242c))
* **review:** per-file verdict cache behind REVIEW_YETI_VERDICT_CACHE (REL-1085) ([#1036](https://github.com/review-yeti-ai/review-yeti-bot/issues/1036)) ([1f0affa](https://github.com/review-yeti-ai/review-yeti-bot/commit/1f0affabee05daf6c28a6d66bcd98255af07b3fd))
* **review:** preserve evidence through graceful closeout ([#1203](https://github.com/review-yeti-ai/review-yeti-bot/issues/1203)) ([aab6297](https://github.com/review-yeti-ai/review-yeti-bot/commit/aab62978342df73c62f10877ffe9fdb357dd24cf))
* **review:** retain immutable composed tasks under the native fence ([#1181](https://github.com/review-yeti-ai/review-yeti-bot/issues/1181)) ([8f884bc](https://github.com/review-yeti-ai/review-yeti-bot/commit/8f884bceec4bd0ec41375629fbb316aaddb510e1))
* **review:** risk-ordered review budget per lane behind REVIEW_YETI_BUDGET (REL-1082) ([#1026](https://github.com/review-yeti-ai/review-yeti-bot/issues/1026)) ([b0d249b](https://github.com/review-yeti-ai/review-yeti-bot/commit/b0d249bfb13dbb217b9c78c4d9b9d84891a81ddd))
* **telemetry:** ground analytics endpoints, memory ledger, and edge routes in authentic realtime D1 and R2 data ([#1367](https://github.com/review-yeti-ai/review-yeti-bot/issues/1367)) ([4863e18](https://github.com/review-yeti-ai/review-yeti-bot/commit/4863e18c2d2a2cc36bb93ed59e5a4163ce9919df))
* **telemetry:** push worker metrics to VictoriaMetrics at exit (REL-1104) ([#1043](https://github.com/review-yeti-ai/review-yeti-bot/issues/1043)) ([1d61d4a](https://github.com/review-yeti-ai/review-yeti-bot/commit/1d61d4ac67422226c0e573d495ec80187fcadb05))
* **transport:** admit a third, digest-pinned review destination ([#886](https://github.com/review-yeti-ai/review-yeti-bot/issues/886)) ([2491e84](https://github.com/review-yeti-ai/review-yeti-bot/commit/2491e8453c16ccda1948914b46653bea3379b7ed))
* **transport:** admit Fireworks as a review destination ([#894](https://github.com/review-yeti-ai/review-yeti-bot/issues/894)) ([2d2804c](https://github.com/review-yeti-ai/review-yeti-bot/commit/2d2804cafaaaee0b55b2716469de796c67e7ecc2))


### Bug Fixes

* **action:** fail with a clear error when the dispatch endpoint is not supplied ([#1357](https://github.com/review-yeti-ai/review-yeti-bot/issues/1357)) ([d4b0adb](https://github.com/review-yeti-ai/review-yeti-bot/commit/d4b0adb1bf66e8db86e99ccad81fab223da1a6b9))
* **action:** infra lane failures in the Action pipeline are INCOMPLETE and re-attempted, never BLOCK (REL-1113) ([#1064](https://github.com/review-yeti-ai/review-yeti-bot/issues/1064)) ([4c251aa](https://github.com/review-yeti-ai/review-yeti-bot/commit/4c251aa1c4698577771553d9a4c15fd0307a099a))
* **action:** ride out gateway 429s on the shared rate-limit schedule ([#1360](https://github.com/review-yeti-ai/review-yeti-bot/issues/1360)) ([2334460](https://github.com/review-yeti-ai/review-yeti-bot/commit/2334460c47f184faab53a087c6eea3320b9dac0e))
* **API-3377:** retain findings on graceful composed retries ([#1227](https://github.com/review-yeti-ai/review-yeti-bot/issues/1227)) ([ca0f206](https://github.com/review-yeti-ai/review-yeti-bot/commit/ca0f20673daea09315b4a4f6bd2ca6a9031f4258))
* **app-gate:** verify durable completion receipt before operator success ([#1109](https://github.com/review-yeti-ai/review-yeti-bot/issues/1109)) ([14237cb](https://github.com/review-yeti-ai/review-yeti-bot/commit/14237cbcbbf103ee5d17cd3778b460c79a9f5faa))
* **auth:** remove the built-in admin password and fail closed without ADMIN_PASSWORD ([#1293](https://github.com/review-yeti-ai/review-yeti-bot/issues/1293)) ([bdfef11](https://github.com/review-yeti-ai/review-yeti-bot/commit/bdfef11eec0bb33e6b90c7a05bde311184d64276))
* bound schema bootstrap and stabilize qualification fixtures ([#1232](https://github.com/review-yeti-ai/review-yeti-bot/issues/1232)) ([a8dad15](https://github.com/review-yeti-ai/review-yeti-bot/commit/a8dad1599e2bfccba4782c20a736af652c7854f1))
* **chart:** install the controller-gen PRReviewJob CRD instead of a hand copy (REL-1097) ([#1023](https://github.com/review-yeti-ai/review-yeti-bot/issues/1023)) ([335c963](https://github.com/review-yeti-ai/review-yeti-bot/commit/335c963ced975d9f0ae0a8464cf6164a720799bf))
* **ci:** admit public self-review at ready or explicit request ([#1189](https://github.com/review-yeti-ai/review-yeti-bot/issues/1189)) ([d1e24be](https://github.com/review-yeti-ai/review-yeti-bot/commit/d1e24beed7ee36487e46611b60bf2a8d67a81b3b))
* **ci:** bump the anonymity ratchet for the two files [#1333](https://github.com/review-yeti-ai/review-yeti-bot/issues/1333) grew ([#1337](https://github.com/review-yeti-ai/review-yeti-bot/issues/1337)) ([466ecc4](https://github.com/review-yeti-ai/review-yeti-bot/commit/466ecc489339481b2177d426fa5b80ab5f4fa332))
* **ci:** close the release-tag expression in the image summary ([906da00](https://github.com/review-yeti-ai/review-yeti-bot/commit/906da0039fc2dcf87918521c9b2ec2d7c52e6550))
* **ci:** pin embedded Go qualification and safe failure evidence ([#1204](https://github.com/review-yeti-ai/review-yeti-bot/issues/1204)) ([ab9a865](https://github.com/review-yeti-ai/review-yeti-bot/commit/ab9a86530d98969db96bad017e62ffabdf512a22))
* **ci:** preserve draft validation on ready transition ([#1218](https://github.com/review-yeti-ai/review-yeti-bot/issues/1218)) ([e643eab](https://github.com/review-yeti-ai/review-yeti-bot/commit/e643eabfd29d747ad0cc2f3c6e79741919678e74))
* **ci:** restore Dockerfile.bot matching Dockerfile for multiarch builds ([#957](https://github.com/review-yeti-ai/review-yeti-bot/issues/957)) ([731408b](https://github.com/review-yeti-ai/review-yeti-bot/commit/731408bcd5fd81e63998471a283bddaa68022e7f))
* **ci:** run ordinary quality checks on public drafts ([#1195](https://github.com/review-yeti-ai/review-yeti-bot/issues/1195)) ([1565bd6](https://github.com/review-yeti-ai/review-yeti-bot/commit/1565bd660ff9518eeae661a34992bbf510239848))
* **ci:** update the anonymity ratchet for the analytics de-org change ([#1336](https://github.com/review-yeti-ai/review-yeti-bot/issues/1336)) ([7354562](https://github.com/review-yeti-ai/review-yeti-bot/commit/7354562af2bfa6253454ea3f1253474361086abc))
* classify review completion persistence stages ([#932](https://github.com/review-yeti-ai/review-yeti-bot/issues/932)) ([526ba8e](https://github.com/review-yeti-ai/review-yeti-bot/commit/526ba8e5e2d68f816abb98e1819b9f8285a4c21f))
* classify unreported malformed review tasks as no verdict ([#1134](https://github.com/review-yeti-ai/review-yeti-bot/issues/1134)) ([71cda35](https://github.com/review-yeti-ai/review-yeti-bot/commit/71cda356b306395f9bc3dfd44ee6e4fd5476d4e2))
* complete oversized PR reviews with bounded GitHub file evidence ([0cdff47](https://github.com/review-yeti-ai/review-yeti-bot/commit/0cdff47170ed0435ad245c308258d27bc66a0424))
* **composed:** approve a diff with nothing analyzable on the composed path too ([#899](https://github.com/review-yeti-ai/review-yeti-bot/issues/899)) ([b711d28](https://github.com/review-yeti-ai/review-yeti-bot/commit/b711d28ed8b94ca3d14d445f8880d81f7dc429f5))
* **composed:** clamp oversized plan text instead of failing the review ([d7d4caf](https://github.com/review-yeti-ai/review-yeti-bot/commit/d7d4cafd4a83e2232f026fd42d89d84a88cb2f49))
* **composed:** fold capitalized task ids into the roster format ([#906](https://github.com/review-yeti-ai/review-yeti-bot/issues/906)) ([063c3dc](https://github.com/review-yeti-ai/review-yeti-bot/commit/063c3dc5fe45b80c35aa50eada0abffaf4c571c1))
* **composed:** keep later lanes running when one task has no verdict ([#911](https://github.com/review-yeti-ai/review-yeti-bot/issues/911)) ([dbca42a](https://github.com/review-yeti-ai/review-yeti-bot/commit/dbca42a2019063b18d7bf0c5e37b00f2a346fd72))
* **composed:** keep security coverage without failing the review ([#926](https://github.com/review-yeti-ai/review-yeti-bot/issues/926)) ([e516b1b](https://github.com/review-yeti-ai/review-yeti-bot/commit/e516b1bb4cda440807e33b253b6c0a503a7f6aa7))
* **composed:** name a spent turn budget separately from a missing verdict ([#918](https://github.com/review-yeti-ai/review-yeti-bot/issues/918)) ([c4433a8](https://github.com/review-yeti-ai/review-yeti-bot/commit/c4433a8452637c219f313da0413a4c64b94c081c))
* **composed:** review the real diff when a plan names other paths ([3a5365a](https://github.com/review-yeti-ai/review-yeti-bot/commit/3a5365a0c633b8ad14ad2faf0394dad9fb8de787))
* **composed:** type an unreported lane as an unreported lane ([#928](https://github.com/review-yeti-ai/review-yeti-bot/issues/928)) ([9c77d91](https://github.com/review-yeti-ai/review-yeti-bot/commit/9c77d91790d1b96d924e11967fa650eb5309bf8b))
* defer unused installation client loading in token auth ([#1241](https://github.com/review-yeti-ai/review-yeti-bot/issues/1241)) ([279b7e1](https://github.com/review-yeti-ai/review-yeti-bot/commit/279b7e15ffc5c0e4f847fdca5090585c2ecfddfe))
* derive authoritative review roster from changed paths ([#963](https://github.com/review-yeti-ai/review-yeti-bot/issues/963)) ([5817500](https://github.com/review-yeti-ai/review-yeti-bot/commit/581750084b6ee20b288378cabae7b75366d4a08b))
* **dispatch:** admit manual central retries durably ([#961](https://github.com/review-yeti-ai/review-yeti-bot/issues/961)) ([3af9c26](https://github.com/review-yeti-ai/review-yeti-bot/commit/3af9c263f56dd84265f3704181476c6fcf3ef92b))
* **dispatch:** authorize exact manual recovery workflow ([#953](https://github.com/review-yeti-ai/review-yeti-bot/issues/953)) ([0b439e6](https://github.com/review-yeti-ai/review-yeti-bot/commit/0b439e622d45805d811267218b04d660d152df54))
* **dispatch:** cancel the PRReviewJob created after a mid-claim supersede (REL-1095) ([#1022](https://github.com/review-yeti-ai/review-yeti-bot/issues/1022)) ([0344531](https://github.com/review-yeti-ai/review-yeti-bot/commit/0344531ca9403b6897b3e659fb454910507d7abf))
* **dispatcher:** actually cancel superseded PRReviewJobs (REL-1073) ([#996](https://github.com/review-yeti-ai/review-yeti-bot/issues/996)) ([4f84afd](https://github.com/review-yeti-ai/review-yeti-bot/commit/4f84afdac0ffce151dd2927c79328427fff2ed02))
* **dispatcher:** require durable cancellation acknowledgement [REL-1157] ([559d566](https://github.com/review-yeti-ai/review-yeti-bot/commit/559d56650cc73ff20ccc7acf6dd5e69535699d65))
* **dispatch:** expose receipts for terminal gate verdicts and reorder worker supersession check ([#1138](https://github.com/review-yeti-ai/review-yeti-bot/issues/1138)) ([d8bc465](https://github.com/review-yeti-ai/review-yeti-bot/commit/d8bc465377e2fd45d31b142e534530d29728cdf4))
* **dispatch:** honor expedited MCP priority [REL-1189] ([f54c00c](https://github.com/review-yeti-ai/review-yeti-bot/commit/f54c00ce0a988b90200011459f78d6d42a59cf41))
* **dispatch:** honor global passthrough for native review admissions ([#1378](https://github.com/review-yeti-ai/review-yeti-bot/issues/1378)) ([7dd0d53](https://github.com/review-yeti-ai/review-yeti-bot/commit/7dd0d5352f9e654b67f6565edc16956670d52c6c))
* **dispatch:** limit public app to installation lookup ([d27d2e1](https://github.com/review-yeti-ai/review-yeti-bot/commit/d27d2e16b050a79ee51c560ddbe72e404c709e64))
* **dispatch:** make the review job dispatcher safe to run with 2+ replicas (REL-1053) ([#984](https://github.com/review-yeti-ai/review-yeti-bot/issues/984)) ([aaec888](https://github.com/review-yeti-ai/review-yeti-bot/commit/aaec8888486fb7293ce585bae378cc3e2521b828))
* **dispatch:** preserve legacy App-gate receipts (API-3371) ([#1130](https://github.com/review-yeti-ai/review-yeti-bot/issues/1130)) ([b2a7f96](https://github.com/review-yeti-ai/review-yeti-bot/commit/b2a7f9606a9392709dd07f7f93d3df8253f4a9af))
* **dispatch:** reconcile lost review generations ([#966](https://github.com/review-yeti-ai/review-yeti-bot/issues/966)) ([5136b68](https://github.com/review-yeti-ai/review-yeti-bot/commit/5136b68b86b3c3daf529f5f2a7299567bcd4827e))
* **dispatch:** recover partial review generation state ([#968](https://github.com/review-yeti-ai/review-yeti-bot/issues/968)) ([53c04b2](https://github.com/review-yeti-ai/review-yeti-bot/commit/53c04b2a0fd33fc5d342309f63ab145bcde5faec))
* **dispatch:** recover proven legacy incomplete review generations [UAT-1704] ([#1136](https://github.com/review-yeti-ai/review-yeti-bot/issues/1136)) ([a1727ab](https://github.com/review-yeti-ai/review-yeti-bot/commit/a1727abce9d00ce72d122b525f648f1308a84653))
* **dispatch:** route public target through dedicated app ([3e99027](https://github.com/review-yeti-ai/review-yeti-bot/commit/3e99027533b89a3783610e4c4e94f628cfecaa47))
* **dispatch:** route public target through dedicated app ([22f4560](https://github.com/review-yeti-ai/review-yeti-bot/commit/22f456051e94d90cf880b562f53ea6b0fd0a50ac))
* enforce 15-minute review deadline ([#1184](https://github.com/review-yeti-ai/review-yeti-bot/issues/1184)) ([2a1f1c0](https://github.com/review-yeti-ai/review-yeti-bot/commit/2a1f1c0e485e03a5e7591e683535cf34fccc7fa9))
* **gateway:** bypass the Bifrost response cache on every model call (REL-1134) ([#1076](https://github.com/review-yeti-ai/review-yeti-bot/issues/1076)) ([bafd0c6](https://github.com/review-yeti-ai/review-yeti-bot/commit/bafd0c68e04c6817f399eff10eae43b0d75a5f38))
* **gateway:** opt Review Yeti out of gateway-injected MCP tools (REL-1115) ([#1058](https://github.com/review-yeti-ai/review-yeti-bot/issues/1058)) ([e51de21](https://github.com/review-yeti-ai/review-yeti-bot/commit/e51de210ea6c69bdd3bf59bcf1997f851c261666))
* **gateway:** request streamed usage so reviews stop reporting 0 tokens (REL-1105) ([#1045](https://github.com/review-yeti-ai/review-yeti-bot/issues/1045)) ([d1b59b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/d1b59b7396e4ac0637b2e649e7361007ad6abb72))
* **gateway:** respect provider Retry-After before composed retries ([#1335](https://github.com/review-yeti-ai/review-yeti-bot/issues/1335)) ([ef7bfb0](https://github.com/review-yeti-ai/review-yeti-bot/commit/ef7bfb058df58940f1db5a9a4fcacf321cfed251))
* **github:** bounded retry for transient GitHub responses (REL-1103) ([#1041](https://github.com/review-yeti-ai/review-yeti-bot/issues/1041)) ([0a2a98d](https://github.com/review-yeti-ai/review-yeti-bot/commit/0a2a98dbaaa2c2a8a3066057915fc7c20ab79b16))
* **image:** ship the bot domain index in the bot image ([#916](https://github.com/review-yeti-ai/review-yeti-bot/issues/916)) ([0aa4011](https://github.com/review-yeti-ai/review-yeti-bot/commit/0aa401104e1d42e8dca96d6eac5105bfce8b9c36))
* **jev:** accept the live score contract and derive risk level by argmax (REL-1100) ([#1030](https://github.com/review-yeti-ai/review-yeti-bot/issues/1030)) ([c982c8c](https://github.com/review-yeti-ai/review-yeti-bot/commit/c982c8cc9455288f876960e5353d95e8811fa795))
* **jev:** give every builtin charter a lane focus in the triage shadow (REL-1126) ([#1070](https://github.com/review-yeti-ai/review-yeti-bot/issues/1070)) ([b53f473](https://github.com/review-yeti-ai/review-yeti-bot/commit/b53f473e08288ca3e96f49160f5b7733618061cd))
* **k8s:** treat terminal PRReviewJobs as already cancelled when the CRD rejects the patch ([#1255](https://github.com/review-yeti-ai/review-yeti-bot/issues/1255)) ([6ca4686](https://github.com/review-yeti-ai/review-yeti-bot/commit/6ca4686988715b63fc74c61cb9fdd18fe047bc41))
* keep composed WORK task context truthful ([#1275](https://github.com/review-yeti-ai/review-yeti-bot/issues/1275)) ([215ef9a](https://github.com/review-yeti-ai/review-yeti-bot/commit/215ef9ae0c657d0d8879661dd34c8fd3ee04b7c6))
* keep deleted diff paths out of head tree evidence ([#1268](https://github.com/review-yeti-ai/review-yeti-bot/issues/1268)) ([3c5f516](https://github.com/review-yeti-ai/review-yeti-bot/commit/3c5f516886d218333a3813db59e1366f50d2c50d))
* keep the pinned deployment endpoints and record the remaining references ([5021d7a](https://github.com/review-yeti-ai/review-yeti-bot/commit/5021d7a69f361406b5562c5b80c3e1328a0b5b50))
* **live:** specify SwarmTaskItem descriptions in fallback topology tasks ([ac73d70](https://github.com/review-yeti-ai/review-yeti-bot/commit/ac73d707203f19e41e6d075f3228822f22e6a40a))
* make authoritative completion delivery retry-safe ([#934](https://github.com/review-yeti-ai/review-yeti-bot/issues/934)) ([b34324c](https://github.com/review-yeti-ai/review-yeti-bot/commit/b34324c7f67d08edbb86f164b4c8b2f7da233a7d))
* **mcp:** align compute_plane aliases in getCloudflareStatus ([b916915](https://github.com/review-yeti-ai/review-yeti-bot/commit/b9169152553e636c307caa5be89675884ee38fe6))
* **mcp:** align zero-run savings and dynamic window scaling in runtime reports ([d5b4aff](https://github.com/review-yeti-ai/review-yeti-bot/commit/d5b4afff28df400d30d7e16dd135582eb38979b7))
* **mcp:** clarify shadowParity dataSource in getCloudflareStatus ([5b43b53](https://github.com/review-yeti-ai/review-yeti-bot/commit/5b43b53951e4b1b0555a0a80cfb001b689709bd1))
* **mcp:** fail closed across review status projections ([#1147](https://github.com/review-yeti-ai/review-yeti-bot/issues/1147)) ([5d4743c](https://github.com/review-yeti-ai/review-yeti-bot/commit/5d4743c39c32a365ef889b7464fc26d811a2f557))
* **mcp:** govern exact-head review triggers ([7521508](https://github.com/review-yeti-ai/review-yeti-bot/commit/75215089b80444897de574c8a7261fce6513a27f))
* **mcp:** govern exact-head review triggers ([8e32692](https://github.com/review-yeti-ai/review-yeti-bot/commit/8e32692d4a762c67ecbe7761b32ad209f2df2412))
* **mcp:** isolate webhook parsing from bounded API routes ([#1167](https://github.com/review-yeti-ai/review-yeti-bot/issues/1167)) ([a545269](https://github.com/review-yeti-ai/review-yeti-bot/commit/a545269034f0e7889d72882792d38cbe58b90751))
* **mcp:** query_active_jobs no longer selects nonexistent review_runs.verdict (REL-1361) ([#1405](https://github.com/review-yeti-ai/review-yeti-bot/issues/1405)) ([96de843](https://github.com/review-yeti-ai/review-yeti-bot/commit/96de843112a2aa912b7215d7a2421ebb2adb284d))
* **mcp:** report current review lifecycle phase truthfully ([#1188](https://github.com/review-yeti-ai/review-yeti-bot/issues/1188)) ([ec5477f](https://github.com/review-yeti-ai/review-yeti-bot/commit/ec5477f9db855a949c7093823158b639fe2fa250))
* **mcp:** settle cancellation gate atomically [REL-1188] ([96a221a](https://github.com/review-yeti-ai/review-yeti-bot/commit/96a221a3ffaf59846b5631f0b2a934f03fe7d412))
* **mcp:** use shared terminal deadline for review trigger ([#1104](https://github.com/review-yeti-ai/review-yeti-bot/issues/1104)) ([d473abe](https://github.com/review-yeti-ai/review-yeti-bot/commit/d473abe017bd7c7b137ddc3fc7a675278e83479f))
* **operator:** protect publishing workers from autoscaler scale-down ([#1166](https://github.com/review-yeti-ai/review-yeti-bot/issues/1166)) ([c62e3dd](https://github.com/review-yeti-ai/review-yeti-bot/commit/c62e3dd6a873b19264ef4313bc753ff84a89b9b5))
* **operator:** regenerate the PRReviewJob CRD so cancelRequested is not pruned (REL-1073) ([#1013](https://github.com/review-yeti-ai/review-yeti-bot/issues/1013)) ([18e3b77](https://github.com/review-yeti-ai/review-yeti-bot/commit/18e3b77dbdc777c950c06acd49a74f0c30e50144))
* **panel:** a diff with nothing to analyze is an approval, not missing evidence ([#889](https://github.com/review-yeti-ai/review-yeti-bot/issues/889)) ([61adab2](https://github.com/review-yeti-ai/review-yeti-bot/commit/61adab26ea08146b503ab27bb951a4ada0591011))
* **panel:** clarify composed PLAN task contracts ([#1215](https://github.com/review-yeti-ai/review-yeti-bot/issues/1215)) ([64c22f1](https://github.com/review-yeti-ai/review-yeti-bot/commit/64c22f1f0ffe96155966c9d9b01b0bd8e9a3edc9))
* **panel:** classify degenerate provider plans as provider_error, not contract ([#959](https://github.com/review-yeti-ai/review-yeti-bot/issues/959)) ([31a50b2](https://github.com/review-yeti-ai/review-yeti-bot/commit/31a50b210ed797bb9b29fd842a832734b4becc6f))
* **panel:** find_files supports globs and searches the full tree (REL-1102) ([#1042](https://github.com/review-yeti-ai/review-yeti-bot/issues/1042)) ([0361061](https://github.com/review-yeti-ai/review-yeti-bot/commit/03610610cdeac3dbf64548e6071f5668ff02109b))
* **panel:** measure lane queue wait from fan-out start; move the cap to laneConcurrency (REL-1133) ([#1080](https://github.com/review-yeti-ai/review-yeti-bot/issues/1080)) ([45a2a71](https://github.com/review-yeti-ai/review-yeti-bot/commit/45a2a71cca295565dc3762326c0da37ef6391e44))
* **panel:** refill composed task slots as turns are refunded ([#1205](https://github.com/review-yeti-ai/review-yeti-bot/issues/1205)) ([02da3d6](https://github.com/review-yeti-ai/review-yeti-bot/commit/02da3d6dfa19466aa70bd1bc688499902b4d568f))
* **panel:** retry the router alias on INCOMPLETE instead of failing closed ([#874](https://github.com/review-yeti-ai/review-yeti-bot/issues/874)) ([8aff2da](https://github.com/review-yeti-ai/review-yeti-bot/commit/8aff2da7d7bfa094b762997324a99ea499469898))
* pause queued reviews during global passthrough ([#1391](https://github.com/review-yeti-ai/review-yeti-bot/issues/1391)) ([a7254e1](https://github.com/review-yeti-ai/review-yeti-bot/commit/a7254e14bd9ad819060b844d779a6069ee41d76b))
* **persistence:** skip already-applied schema DDL so rollouts stop deadlocking live traffic (REL-1127) ([#1073](https://github.com/review-yeti-ai/review-yeti-bot/issues/1073)) ([40f5ffc](https://github.com/review-yeti-ai/review-yeti-bot/commit/40f5ffca412f151732e5cf8f09ff9ac88a46f447))
* **personas:** give arch-lane an architecture charter instead of a governance one ([#888](https://github.com/review-yeti-ai/review-yeti-bot/issues/888)) ([a08995b](https://github.com/review-yeti-ai/review-yeti-bot/commit/a08995b1b315b1fb3d63a9be9703c5b4a7d21c7e))
* **pipeline:** route git submodule changes to architecture persona [no-linear] ([#965](https://github.com/review-yeti-ai/review-yeti-bot/issues/965)) ([9d0efca](https://github.com/review-yeti-ai/review-yeti-bot/commit/9d0efca2720dbdde5d2cce6987b217e535de67a6))
* **pipeline:** use tailnet dns url and bump default lane timeout to 240s ([d6bef33](https://github.com/review-yeti-ai/review-yeti-bot/commit/d6bef3327f00b12ede2b5b3ddf2af986b0bb85b9))
* **preflight:** distinguish SQL and command fixtures from executable sinks ([#1314](https://github.com/review-yeti-ai/review-yeti-bot/issues/1314)) ([f343d64](https://github.com/review-yeti-ai/review-yeti-bot/commit/f343d64aa3e2c990a470ce41c61f70783d1873f9))
* preserve incomplete task evidence at findings stop ([#1229](https://github.com/review-yeti-ai/review-yeti-bot/issues/1229)) ([306abd6](https://github.com/review-yeti-ai/review-yeti-bot/commit/306abd62794e0ecc85ce797ca44e8330099b34c3))
* preserve scoped retrieval evidence and Zoekt budgets (REL-1077) ([#1240](https://github.com/review-yeti-ai/review-yeti-bot/issues/1240)) ([502a6e3](https://github.com/review-yeti-ai/review-yeti-bot/commit/502a6e38cda78a31efa241bec69340d917f6b11d))
* **privacy:** neutralize a private repo name in a lockfile test comment ([#1363](https://github.com/review-yeti-ai/review-yeti-bot/issues/1363)) ([2de0e04](https://github.com/review-yeti-ai/review-yeti-bot/commit/2de0e04602fc4892bf2055f9de9a545053c5c4e0))
* **privacy:** neutralize memory and dashboard examples ([#1343](https://github.com/review-yeti-ai/review-yeti-bot/issues/1343)) ([d45c9fb](https://github.com/review-yeti-ai/review-yeti-bot/commit/d45c9fbf218ccf08bf3b5267059bb1a6a8da03db))
* **privacy:** scrub the deploying organization's identity from the analytics and onboarding surfaces ([#1369](https://github.com/review-yeti-ai/review-yeti-bot/issues/1369)) ([31e0e89](https://github.com/review-yeti-ai/review-yeti-bot/commit/31e0e8931821571c3f8da6d95f8a43c350b0d949))
* publish release multiarch indexes ([#936](https://github.com/review-yeti-ai/review-yeti-bot/issues/936)) ([8601f44](https://github.com/review-yeti-ai/review-yeti-bot/commit/8601f4492a94fd3ea77b3e43db9ae7b985ff089f))
* **publish:** enforce auto_review.ignore_patterns as declared not-applicable (skip, never SHIP) ([#897](https://github.com/review-yeti-ai/review-yeti-bot/issues/897)) ([91751c9](https://github.com/review-yeti-ai/review-yeti-bot/commit/91751c90e58956ca5b30d7a9f7a66497e42de32f))
* **publishing:** size work within admitted lifecycle ([#1193](https://github.com/review-yeti-ai/review-yeti-bot/issues/1193)) ([dd65e3b](https://github.com/review-yeti-ai/review-yeti-bot/commit/dd65e3b5d49882779e0666d02be0f4e5663fdea0))
* **qualification:** admit diffs up to ~80k lines via the pull-files fallback ([#891](https://github.com/review-yeti-ai/review-yeti-bot/issues/891)) ([fd3fc88](https://github.com/review-yeti-ai/review-yeti-bot/commit/fd3fc882e29bd3469d8f80c31dab02f2eb60800a))
* read marker-bound legacy P2 receipts without inventing timestamps ([#1160](https://github.com/review-yeti-ai/review-yeti-bot/issues/1160)) ([4d9ffbc](https://github.com/review-yeti-ai/review-yeti-bot/commit/4d9ffbcdd58bf8c10bd037ef7fe304eb1788dd8d))
* recover composed verdict contracts and retain release record patches ([#1144](https://github.com/review-yeti-ai/review-yeti-bot/issues/1144)) ([9fa7058](https://github.com/review-yeti-ai/review-yeti-bot/commit/9fa70585e8c3cde266aa826cc71be24fd0b5d171))
* recover truncated gateway findings output (REL-1081) ([#1256](https://github.com/review-yeti-ai/review-yeti-bot/issues/1256)) ([2dc92e0](https://github.com/review-yeti-ai/review-yeti-bot/commit/2dc92e02e9d94055b7ae6547bd1c98e017cfbf38))
* **recovery:** remove a redundant refusal that no test could discriminate ([#1364](https://github.com/review-yeti-ai/review-yeti-bot/issues/1364)) ([94b88c5](https://github.com/review-yeti-ai/review-yeti-bot/commit/94b88c5c989bfd500e6364a51a73f8d0a9ee8c57))
* **REL-1019:** name the concrete gate failure cause in the published check ([#975](https://github.com/review-yeti-ai/review-yeti-bot/issues/975)) ([cf0cb45](https://github.com/review-yeti-ai/review-yeti-bot/commit/cf0cb4590956029129ec218df2488f508fb8e243))
* **REL-1025:** workerImage pins digest, not registry — self-host was impossible ([#1034](https://github.com/review-yeti-ai/review-yeti-bot/issues/1034)) ([a6f546f](https://github.com/review-yeti-ai/review-yeti-bot/commit/a6f546f5c27990b80ee2f4c13f55576169302c89))
* **REL-1056:** classify trusted-completion failures, stop retrying contract rejections ([#989](https://github.com/review-yeti-ai/review-yeti-bot/issues/989)) ([1e3cbc9](https://github.com/review-yeti-ai/review-yeti-bot/commit/1e3cbc9a560e4c5b910aa604126cd305bf167727))
* **REL-1069:** readiness reads the OpenAI/Bifrost standard, not vendor names ([#992](https://github.com/review-yeti-ai/review-yeti-bot/issues/992)) ([b48b932](https://github.com/review-yeti-ai/review-yeti-bot/commit/b48b93227bb6c99c5ec4ac0b761c4800d3c351eb))
* **REL-1107:** retry transient identity probes, and say why publishing was refused ([#1049](https://github.com/review-yeti-ai/review-yeti-bot/issues/1049)) ([badf21c](https://github.com/review-yeti-ai/review-yeti-bot/commit/badf21c8b3c05525f2b63c2d3edfe88e84289673))
* **REL-1116:** an aborted signal hung the MCP transport instead of failing it ([#1059](https://github.com/review-yeti-ai/review-yeti-bot/issues/1059)) ([0332e05](https://github.com/review-yeti-ai/review-yeti-bot/commit/0332e05f39d1c20cac94fc046c8ebc2de5316511))
* **REL-1116:** bound the BODY read, and correct two false claims in [#1059](https://github.com/review-yeti-ai/review-yeti-bot/issues/1059) ([#1066](https://github.com/review-yeti-ai/review-yeti-bot/issues/1066)) ([ac7515b](https://github.com/review-yeti-ai/review-yeti-bot/commit/ac7515b2c5aa91c419477a15acf39b5cd36c5156))
* **REL-1198:** authorize bounded MCP recovery and preserve review history ([#1154](https://github.com/review-yeti-ai/review-yeti-bot/issues/1154)) ([3faf1d0](https://github.com/review-yeti-ai/review-yeti-bot/commit/3faf1d0ffbe2d4c9e41b6b201d33c3ed5e996554))
* **REL-1198:** preserve failed-partition response diagnostics ([#1201](https://github.com/review-yeti-ai/review-yeti-bot/issues/1201)) ([d588bca](https://github.com/review-yeti-ai/review-yeti-bot/commit/d588bcaf4192b15c116c061f40e6e2effea4c334))
* **REL-1206:** cancel active composed model requests ([#1175](https://github.com/review-yeti-ai/review-yeti-bot/issues/1175)) ([1305fcf](https://github.com/review-yeti-ai/review-yeti-bot/commit/1305fcff4de29ea58a4d56a6e8d2b7febbe4c22b))
* **REL-1250:** retain small inspected source through review compaction ([#1282](https://github.com/review-yeti-ai/review-yeti-bot/issues/1282)) ([81afe66](https://github.com/review-yeti-ai/review-yeti-bot/commit/81afe664b264c8b2b289018575d87bec28aaaab9))
* **REL-1265:** re-review disputed tasks with immutable evidence ([#1258](https://github.com/review-yeti-ai/review-yeti-bot/issues/1258)) ([be35c71](https://github.com/review-yeti-ai/review-yeti-bot/commit/be35c71b7ab16a60728e91761e1a197e64d9ea60))
* **REL-1265:** restore publication build and isolated analytics contracts ([#1290](https://github.com/review-yeti-ai/review-yeti-bot/issues/1290)) ([dcd8fc6](https://github.com/review-yeti-ai/review-yeti-bot/commit/dcd8fc67e39797baa3d45b472ad9b77d8b293396))
* **REL-1265:** retain composed evidence on signed ready retries ([#1333](https://github.com/review-yeti-ai/review-yeti-bot/issues/1333)) ([832e77f](https://github.com/review-yeti-ai/review-yeti-bot/commit/832e77fe977135c92054d837b9d106fa80b8c00f))
* **REL-1287:** bounded source context and immutable archive recovery ([#1267](https://github.com/review-yeti-ai/review-yeti-bot/issues/1267)) ([4a70e4a](https://github.com/review-yeti-ai/review-yeti-bot/commit/4a70e4a6683fc70906cc850340dbcf04d9bb19a6))
* **release:** guard all continuation token aliases ([#1120](https://github.com/review-yeti-ai/review-yeti-bot/issues/1120)) ([4a0f1c3](https://github.com/review-yeti-ai/review-yeti-bot/commit/4a0f1c31f7a97e6949d7658ec7b17c5420d7bcb9))
* **release:** recognize merged release commits ([#972](https://github.com/review-yeti-ai/review-yeti-bot/issues/972)) ([8cf1d22](https://github.com/review-yeti-ai/review-yeti-bot/commit/8cf1d22bee035cfe6b1550e0c7830468f5bb0d02))
* reserve composed task finalization turns ([#1131](https://github.com/review-yeti-ai/review-yeti-bot/issues/1131)) ([a21d445](https://github.com/review-yeti-ai/review-yeti-bot/commit/a21d4455d2e0fab39d71bf6228336ff8d7ce10cd))
* restore neutral public defaults and edge telemetry contracts ([#1370](https://github.com/review-yeti-ai/review-yeti-bot/issues/1370)) ([f59e14e](https://github.com/review-yeti-ai/review-yeti-bot/commit/f59e14e4b7e686ff3ad4cf45d76b02aadf396ea9))
* retry a stalled or malformed lane alone; degrade the assignment cap ([#1354](https://github.com/review-yeti-ai/review-yeti-bot/issues/1354)) ([16b3c77](https://github.com/review-yeti-ai/review-yeti-bot/commit/16b3c77fc730a1dd4d9d495271d0e47232e9d0d2))
* **review:** admit bounded complete lockfile context from trusted policy ([#1332](https://github.com/review-yeti-ai/review-yeti-bot/issues/1332)) ([4c555d3](https://github.com/review-yeti-ai/review-yeti-bot/commit/4c555d39ea88f82d5c0e2a182490aec6ca381ef4))
* **review:** admit centrally verified docs-only gates ([#942](https://github.com/review-yeti-ai/review-yeti-bot/issues/942)) ([51ea489](https://github.com/review-yeti-ai/review-yeti-bot/commit/51ea48971283275980e95753b577a778df7617d8))
* **review:** attribute publishing panel progress ([#1178](https://github.com/review-yeti-ai/review-yeti-bot/issues/1178)) ([456501e](https://github.com/review-yeti-ai/review-yeti-bot/commit/456501e39c1cef3482d47095e6e537f44e967703))
* **review:** batch related source reads within one investigation turn ([#1185](https://github.com/review-yeti-ai/review-yeti-bot/issues/1185)) ([3be9333](https://github.com/review-yeti-ai/review-yeti-bot/commit/3be9333a501d97f0781e8be9cfff15852a3a742f))
* **review:** bind authoritative execution to admitted personas ([#938](https://github.com/review-yeti-ai/review-yeti-bot/issues/938)) ([df4bbf3](https://github.com/review-yeti-ai/review-yeti-bot/commit/df4bbf3c06a9e27c57df912ed71ad825e54cab44))
* **review:** bind external review authority to repository identity [no-linear] ([#1376](https://github.com/review-yeti-ai/review-yeti-bot/issues/1376)) ([ea4c5ff](https://github.com/review-yeti-ai/review-yeti-bot/commit/ea4c5fffaf6dfae4b88fe46ce38b004d84d2f16f))
* **review:** bind merge-group receipt to the group, not the whole queue ([#1404](https://github.com/review-yeti-ai/review-yeti-bot/issues/1404)) ([ab65542](https://github.com/review-yeti-ai/review-yeti-bot/commit/ab65542a64d8799e6717afc4f40f7274e246362f))
* **review:** bound hosted completion output [REL-976] ([#1101](https://github.com/review-yeti-ai/review-yeti-bot/issues/1101)) ([5cad233](https://github.com/review-yeti-ai/review-yeti-bot/commit/5cad2334c61e89d0c9b44cc1b7ec2e50affe1795))
* **review:** bound reconstructed diff CPU ([eb0565b](https://github.com/review-yeti-ai/review-yeti-bot/commit/eb0565b09b1e62f471bbb1a2d0dc35ba34efc4e8))
* **review:** budget large exact-diff completion reads ([#982](https://github.com/review-yeti-ai/review-yeti-bot/issues/982)) ([3557909](https://github.com/review-yeti-ai/review-yeti-bot/commit/355790954566b089bfafa5fa92b2dcb56d2a9b26))
* **review:** close the Gate at once on a no-persona coverage failure instead of rejecting the completion with 422 (REL-1122) ([#1074](https://github.com/review-yeti-ai/review-yeti-bot/issues/1074)) ([c10a3ae](https://github.com/review-yeti-ai/review-yeti-bot/commit/c10a3aed7744eb16cdec4bda9e7a976a3f2e804e))
* **review:** complete oversized PR evidence ([1a21c75](https://github.com/review-yeti-ai/review-yeti-bot/commit/1a21c75104eb82e3623c250aac45d928e01539ad))
* **review:** compute 406 diffs from git on worker and trusted side (REL-1080) ([#1010](https://github.com/review-yeti-ai/review-yeti-bot/issues/1010)) ([91362da](https://github.com/review-yeti-ai/review-yeti-bot/commit/91362dad69ca5a54ee52fee47f9b594af807b10c))
* **review:** derive the prior review's verdict instead of reading result.verdict (REL-1084, REL-1085) ([#1047](https://github.com/review-yeti-ai/review-yeti-bot/issues/1047)) ([8431510](https://github.com/review-yeti-ai/review-yeti-bot/commit/843151056711b005dcccf39b9ca758e66001c542))
* **review:** disclose patch truncation and omitted patches (REL-1092) ([#1019](https://github.com/review-yeti-ai/review-yeti-bot/issues/1019)) ([820df2b](https://github.com/review-yeti-ai/review-yeti-bot/commit/820df2bb4830ae5ae4cb42edeaca33c66317c799))
* **review:** do not refuse mix.lock over an unchanged entry's legal app/package name divergence ([#1371](https://github.com/review-yeti-ai/review-yeti-bot/issues/1371)) ([d722723](https://github.com/review-yeti-ai/review-yeti-bot/commit/d722723ef641ff9bbae9868103e683d81afbef15))
* **review:** exempt registry-verified lockfile-only diffs as no reviewable content (REL-972) ([#993](https://github.com/review-yeti-ai/review-yeti-bot/issues/993)) ([f973d7e](https://github.com/review-yeti-ai/review-yeti-bot/commit/f973d7e9abd534535e7a84b46ac85ca8c3ae5495))
* **review:** fence composed task progress on durable retention ACKs ([#1345](https://github.com/review-yeti-ai/review-yeti-bot/issues/1345)) ([ffce45b](https://github.com/review-yeti-ai/review-yeti-bot/commit/ffce45b864e31ce68a1e748072d68bfe98cc7fcb))
* **review:** honor DSH composed fallback in DOKS gate ([#1124](https://github.com/review-yeti-ai/review-yeti-bot/issues/1124)) ([9367045](https://github.com/review-yeti-ai/review-yeti-bot/commit/9367045d17e5a970b17018f1a36d92d79c4a9683))
* **review:** identify submodule gitlinks from diff patch headers [no-linear] ([#978](https://github.com/review-yeti-ai/review-yeti-bot/issues/978)) ([b8e6793](https://github.com/review-yeti-ai/review-yeti-bot/commit/b8e6793ed95f7c99d68f997131dfa93f80ee32d4))
* **review:** infra lane failures are INCOMPLETE and re-attempted, never a BLOCK verdict (REL-1113) ([#1056](https://github.com/review-yeti-ai/review-yeti-bot/issues/1056)) ([2320ad4](https://github.com/review-yeti-ai/review-yeti-bot/commit/2320ad4aff12a6096e3ace6370fd2dc766a4cddc))
* **review:** log why a prior is refused and judge its findings at published severity (REL-1084, REL-1085) ([#1055](https://github.com/review-yeti-ai/review-yeti-bot/issues/1055)) ([e67e64a](https://github.com/review-yeti-ai/review-yeti-bot/commit/e67e64aca4f83bd50276080488613ada864c5a24))
* **review:** map-reduce only past what one call can hold (REL-1083) ([#1046](https://github.com/review-yeti-ai/review-yeti-bot/issues/1046)) ([5c45219](https://github.com/review-yeti-ai/review-yeti-bot/commit/5c452190d053a1946487d6f86944971cd10b0205))
* **review:** name an omitted lockfile patch and drop wrong advice (REL-1099) ([#1024](https://github.com/review-yeti-ai/review-yeti-bot/issues/1024)) ([00d2ebf](https://github.com/review-yeti-ai/review-yeti-bot/commit/00d2ebfc594209cede2e31f06ec151243aa7885c))
* **review:** never silently filter a changed lockfile; summarize an oversized one (REL-1141) ([#1089](https://github.com/review-yeti-ai/review-yeti-bot/issues/1089)) ([b75ced6](https://github.com/review-yeti-ai/review-yeti-bot/commit/b75ced6aebb3f21cc264584a3814599b35e2ee60))
* **review:** one security-sensitive path predicate with lockfiles and toolchain pins (REL-1135) ([#1081](https://github.com/review-yeti-ai/review-yeti-bot/issues/1081)) ([1cdc927](https://github.com/review-yeti-ai/review-yeti-bot/commit/1cdc92797350b4ebdf68cf2ea3c1e8f4f65d39c7))
* **review:** preserve admitted deadlines across configuration changes ([#1200](https://github.com/review-yeti-ai/review-yeti-bot/issues/1200)) ([44bfb1e](https://github.com/review-yeti-ai/review-yeti-bot/commit/44bfb1eba0a16a8adc3dd3b116b0a517725b1597))
* **review:** preserve admitted worker deadline through grounding ([#1171](https://github.com/review-yeti-ai/review-yeti-bot/issues/1171)) ([d2d4ea5](https://github.com/review-yeti-ai/review-yeti-bot/commit/d2d4ea527ac712b74d88e9497c5b25fa2f6f74ad))
* **review:** preserve bounded retries for composed infrastructure failures ([#1368](https://github.com/review-yeti-ai/review-yeti-bot/issues/1368)) ([bf092d6](https://github.com/review-yeti-ai/review-yeti-bot/commit/bf092d6ba499e4f10746222b22c2fd3424598720))
* **review:** preserve full release-record depth and truthful execution disclosure ([#1156](https://github.com/review-yeti-ai/review-yeti-bot/issues/1156)) ([8715842](https://github.com/review-yeti-ai/review-yeti-bot/commit/871584238553157e128814b1f17ed756a723a543))
* **review:** preserve reasoning headroom in hosted reviews ([#1116](https://github.com/review-yeti-ai/review-yeti-bot/issues/1116)) ([528a81e](https://github.com/review-yeti-ai/review-yeti-bot/commit/528a81e82ac5b59cc622d4b5506ca169d4230864))
* **review:** preserve source receipts through graceful recovery [no-linear] ([#1380](https://github.com/review-yeti-ai/review-yeti-bot/issues/1380)) ([af671a3](https://github.com/review-yeti-ai/review-yeti-bot/commit/af671a388b6fc5d32826700aead7ac9c38b111d5))
* **review:** preserve terminal SSE metadata and provider errors ([#1202](https://github.com/review-yeti-ai/review-yeti-bot/issues/1202)) ([fa3fde2](https://github.com/review-yeti-ai/review-yeti-bot/commit/fa3fde2370c4d2a71c6409b7f257b54f7b9999c2))
* **review:** preserve typed panel failure classification ([#1212](https://github.com/review-yeti-ai/review-yeti-bot/issues/1212)) ([a63f09a](https://github.com/review-yeti-ai/review-yeti-bot/commit/a63f09abace6546448ab3b16bc99a660314bafee))
* **review:** publish finding threads before retirement and diagnose blocked tasks ([#1372](https://github.com/review-yeti-ai/review-yeti-bot/issues/1372)) ([f419575](https://github.com/review-yeti-ai/review-yeti-bot/commit/f41957579c307cc7ea75ceb3c9f6c71a9c2bd8dd))
* **review:** read admitted legacy retained findings after supersession ([#1158](https://github.com/review-yeti-ai/review-yeti-bot/issues/1158)) ([2b871f6](https://github.com/review-yeti-ai/review-yeti-bot/commit/2b871f6681ab810a721d5c793970e15dd94874be))
* **review:** read changed-file context at the exact head ([#1172](https://github.com/review-yeti-ai/review-yeti-bot/issues/1172)) ([40926cf](https://github.com/review-yeti-ai/review-yeti-bot/commit/40926cf139a24b35e223afcdd130663d9c321b19))
* **review:** reconcile Gate-bound abandoned failure publication ([#1254](https://github.com/review-yeti-ai/review-yeti-bot/issues/1254)) ([c89167d](https://github.com/review-yeti-ai/review-yeti-bot/commit/c89167d9a02c01c94d154cffbc5736f3269826d3))
* **review:** record delivered source for composed tasks [no-linear] ([#1374](https://github.com/review-yeti-ai/review-yeti-bot/issues/1374)) ([9acac96](https://github.com/review-yeti-ai/review-yeti-bot/commit/9acac96f175c3dd3dc349497d6c8dd324ec58b31))
* **review:** recoverable-panel roster bounds and gate publication order ([#931](https://github.com/review-yeti-ai/review-yeti-bot/issues/931)) ([e6b79a9](https://github.com/review-yeti-ai/review-yeti-bot/commit/e6b79a9170e11c28c7799afd29ede8ff05189873))
* **review:** report composed task coverage in checks ([#1128](https://github.com/review-yeti-ai/review-yeti-bot/issues/1128)) ([3fe7a67](https://github.com/review-yeti-ai/review-yeti-bot/commit/3fe7a677e15018d513b6dbb75e07b87ac0a87933))
* **review:** report retry admission only when confirmed ([#1269](https://github.com/review-yeti-ai/review-yeti-bot/issues/1269)) ([d4a3e99](https://github.com/review-yeti-ai/review-yeti-bot/commit/d4a3e99c66912523d78e70f5ed8c3b4a66f7b9ab))
* **review:** require P2 findings and make required findings converge ([#1356](https://github.com/review-yeti-ai/review-yeti-bot/issues/1356)) ([aa05e94](https://github.com/review-yeti-ai/review-yeti-bot/commit/aa05e94798d6dfef04fb0f1b6f19fca33bb2dc01))
* **review:** restore P2 as advisory so only P0/P1 block the check (REL-1282) ([#1281](https://github.com/review-yeti-ai/review-yeti-bot/issues/1281)) ([fd68404](https://github.com/review-yeti-ai/review-yeti-bot/commit/fd6840488ad695ebed274c19516b041b597e8d64))
* **review:** retain sanitized task finalization diagnostics ([#1142](https://github.com/review-yeti-ai/review-yeti-bot/issues/1142)) ([862a6d8](https://github.com/review-yeti-ai/review-yeti-bot/commit/862a6d8cea3824d94ddb7219aa09c24fd6ccc527))
* **review:** retry undici fetch failures instead of quarantining every lane ([#1111](https://github.com/review-yeti-ai/review-yeti-bot/issues/1111)) ([e897b28](https://github.com/review-yeti-ai/review-yeti-bot/commit/e897b289563b4906a7acc4c322ceec748c856d12))
* **review:** review toolchain pins and new-package lockfiles instead of failing with no persona (REL-1136) ([#1085](https://github.com/review-yeti-ai/review-yeti-bot/issues/1085)) ([eda42eb](https://github.com/review-yeti-ai/review-yeti-bot/commit/eda42ebbcc06a1a6cfd2f03abb8d24e148b477a4))
* **review:** route .mdx and gitlink-only diffs to a lane instead of failing (REL-1058) ([#987](https://github.com/review-yeti-ai/review-yeti-bot/issues/987)) ([60e045a](https://github.com/review-yeti-ai/review-yeti-bot/commit/60e045a6e4556a95ec03120da20484795fe8d96d))
* **review:** route public worker credentials ([7650866](https://github.com/review-yeti-ai/review-yeti-bot/commit/7650866176ef1bc644b9480e9503c97789fde61b))
* **review:** route public worker credentials ([bf33999](https://github.com/review-yeti-ai/review-yeti-bot/commit/bf339990ad92decf2087242fa77afbacf503fb03))
* **review:** route uncovered data/config and refuse docs-only passes over excluded files (REL-972) ([#998](https://github.com/review-yeti-ai/review-yeti-bot/issues/998)) ([d54eb20](https://github.com/review-yeti-ai/review-yeti-bot/commit/d54eb2086b0176ced0cf7370129db2c28607886a))
* **review:** route uncovered HTML pages and accept re-keyed lockfile entries instead of failing with no persona (REL-1118) ([#1068](https://github.com/review-yeti-ai/review-yeti-bot/issues/1068)) ([ef922ca](https://github.com/review-yeti-ai/review-yeti-bot/commit/ef922ca2bde4833ae64fe05383cb22e4f230723d))
* **review:** route uncovered source beside an applying lane to the required lane (REL-1088) ([#1008](https://github.com/review-yeti-ai/review-yeti-bot/issues/1008)) ([a9bafb1](https://github.com/review-yeti-ai/review-yeti-bot/commit/a9bafb1d4750fb84d171d217684887abf396cf95))
* **review:** run composed tasks concurrently within the shared turn budget ([#1190](https://github.com/review-yeti-ai/review-yeti-bot/issues/1190)) ([1179588](https://github.com/review-yeti-ai/review-yeti-bot/commit/1179588f249110e88106c700c1d8e8a73255991d))
* **review:** scope retry timing and restore operator snapshots ([#1164](https://github.com/review-yeti-ai/review-yeti-bot/issues/1164)) ([6cdd1c4](https://github.com/review-yeti-ai/review-yeti-bot/commit/6cdd1c4a32667b8b7343e4371e469db41ebbf574))
* **review:** split oversized hunks without losing bounded coverage ([#1230](https://github.com/review-yeti-ai/review-yeti-bot/issues/1230)) ([c37e03c](https://github.com/review-yeti-ai/review-yeti-bot/commit/c37e03cfa1a52bd6f35cd828ba6178b04b46510d))
* **review:** stop a retried composed task from aborting the whole review ([#1362](https://github.com/review-yeti-ai/review-yeti-bot/issues/1362)) ([23590e8](https://github.com/review-yeti-ai/review-yeti-bot/commit/23590e8d3eb69d88cb6524de6602d1b6853274af))
* **review:** summarize Elixir mix.lock instead of refusing it ([#1334](https://github.com/review-yeti-ai/review-yeti-bot/issues/1334)) ([#1361](https://github.com/review-yeti-ai/review-yeti-bot/issues/1361)) ([f4ee55f](https://github.com/review-yeti-ai/review-yeti-bot/commit/f4ee55f8ef4acd972a4dddb7ae80cc9b7f4f2b5e))
* **review:** thrown panel infrastructure failures are INCOMPLETE and re-attempted, never "Failed live" (REL-1124) ([#1078](https://github.com/review-yeti-ai/review-yeti-bot/issues/1078)) ([2848598](https://github.com/review-yeti-ai/review-yeti-bot/commit/2848598df904c6b7ac89c02ff14a96324e1a7640))
* route env config files to review personas ([#1127](https://github.com/review-yeti-ai/review-yeti-bot/issues/1127)) ([2295f3b](https://github.com/review-yeti-ai/review-yeti-bot/commit/2295f3b4cb9d29c943303cf652590cc669d46c58))
* scope review status timing to the current gate attempt ([#1163](https://github.com/review-yeti-ai/review-yeti-bot/issues/1163)) ([90325c8](https://github.com/review-yeti-ai/review-yeti-bot/commit/90325c8e27a81b91312d7b2af5c2ad45a03a4898))
* share native wire contract and bind terminal diagnostics ([#1151](https://github.com/review-yeti-ai/review-yeti-bot/issues/1151)) ([5fca7f6](https://github.com/review-yeti-ai/review-yeti-bot/commit/5fca7f618e0865378befaf95fb60a10f866b26a3))
* **telemetry:** count every provider call in token accounting (REL-1132) ([#1071](https://github.com/review-yeti-ai/review-yeti-bot/issues/1071)) ([21bf661](https://github.com/review-yeti-ai/review-yeti-bot/commit/21bf661f3108d1292bd1cbc535003d3f3f4cc2ea))
* **telemetry:** sanitized error.cause on transport failures, W5 charsSaved per lane, reconciled Jev cost (REL-1138) ([#1087](https://github.com/review-yeti-ai/review-yeti-bot/issues/1087)) ([f1374d9](https://github.com/review-yeti-ai/review-yeti-bot/commit/f1374d9897aa5266404adee340f31d331bbc3484))
* **test:** own suite and run scratch lifecycle (REL-1209) ([#1168](https://github.com/review-yeti-ai/review-yeti-bot/issues/1168)) ([92fc4ab](https://github.com/review-yeti-ai/review-yeti-bot/commit/92fc4ab1e9840c9fef70e1071f170bc96c9e8056))
* **transport:** remove Fireworks as a Review Yeti provider (REL-1162) ([#1094](https://github.com/review-yeti-ai/review-yeti-bot/issues/1094)) ([ae67e7a](https://github.com/review-yeti-ai/review-yeti-bot/commit/ae67e7a5fa01669768a8a7ec4548eb38da975853))
* validate finding thread PR input before repository routing ([5064dfc](https://github.com/review-yeti-ai/review-yeti-bot/commit/5064dfcd4242d6928bd09e01d777bd89e9175685))
* validate finding thread PR input before strict identity routing ([1c9e77b](https://github.com/review-yeti-ai/review-yeti-bot/commit/1c9e77b465e24691127f58111332125dfe4cf809))
* **worker:** coordinate provider concurrency across reviews and ride out 429s ([#1355](https://github.com/review-yeti-ai/review-yeti-bot/issues/1355)) ([ade7e99](https://github.com/review-yeti-ai/review-yeti-bot/commit/ade7e99449168b35ffe1ec8046c4b974288d73c4))
* **worker:** end a SIGTERM-cancelled superseded run as cancelled, not a failure (REL-1093) ([#1021](https://github.com/review-yeti-ai/review-yeti-bot/issues/1021)) ([6c264bf](https://github.com/review-yeti-ai/review-yeti-bot/commit/6c264bf79d15454ee976ad527c048db8774f0047))
* **worker:** end a stale-head review as superseded instead of failed (REL-1057) ([#986](https://github.com/review-yeti-ai/review-yeti-bot/issues/986)) ([f42d324](https://github.com/review-yeti-ai/review-yeti-bot/commit/f42d324fc097f7f9095aa4ceaf21029517c0c9cd))
* **worker:** enforce one admitted review deadline ([#1179](https://github.com/review-yeti-ai/review-yeti-bot/issues/1179)) ([f40d399](https://github.com/review-yeti-ai/review-yeti-bot/commit/f40d399c50a6f898741a00a415737740c9491a56))
* **worker:** verify runtime manifest file integrity ([#1208](https://github.com/review-yeti-ai/review-yeti-bot/issues/1208)) ([77fbfcc](https://github.com/review-yeti-ai/review-yeti-bot/commit/77fbfcc263e6f47e7235f3d0aa87169f3b9b7b98))


### Performance

* **panel:** run up to 8 lanes at once and log per-run phase timing (REL-1133) ([#1075](https://github.com/review-yeti-ai/review-yeti-bot/issues/1075)) ([1910cb6](https://github.com/review-yeti-ai/review-yeti-bot/commit/1910cb68506069bc360657a96efc1919cb5a1cd5))


### Reverts

* **gateway:** stop bypassing the Bifrost response cache (REL-1134) ([#1082](https://github.com/review-yeti-ai/review-yeti-bot/issues/1082)) ([7c6fb52](https://github.com/review-yeti-ai/review-yeti-bot/commit/7c6fb52faa2d4b15c10c630ded45dce11ddd036f))

## [1.118.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.118.0...v1.118.1) (2026-10-03)


### Bug Fixes

* **action:** fail with a clear error when the dispatch endpoint is not supplied ([#1357](https://github.com/review-yeti-ai/review-yeti-bot/issues/1357)) ([aa903da](https://github.com/review-yeti-ai/review-yeti-bot/commit/aa903da2565ba7ed4032d1bdfd05d265253376f1))

## [1.118.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.117.2...v1.118.0) (2026-10-03)


### Features

* **live:** progressive streaming swarm dataviz with per-task tokens and budget tracking (Refs: REL-1287) ([cb6cbde](https://github.com/review-yeti-ai/review-yeti-bot/commit/cb6cbdef281f0ada5f2e7a57bf6058647b061fbe))


### Bug Fixes

* keep the pinned deployment endpoints and record the remaining references ([eff1ec4](https://github.com/review-yeti-ai/review-yeti-bot/commit/eff1ec4d1327e57314f7b9401863dab5cdaad6bf))

## [1.117.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.117.1...v1.117.2) (2026-10-02)


### Bug Fixes

* **gateway:** respect provider Retry-After before composed retries ([#1335](https://github.com/review-yeti-ai/review-yeti-bot/issues/1335)) ([2971d6e](https://github.com/review-yeti-ai/review-yeti-bot/commit/2971d6ed37335666ad2748bcaf64e1e7eb081588))

## [1.117.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.117.0...v1.117.1) (2026-10-02)


### Bug Fixes

* **review:** admit bounded complete lockfile context from trusted policy ([#1332](https://github.com/review-yeti-ai/review-yeti-bot/issues/1332)) ([c315db1](https://github.com/review-yeti-ai/review-yeti-bot/commit/c315db17116bd0838d2d4d9e567d50464527d465))

## [1.117.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.116.4...v1.117.0) (2026-10-02)


### Features

* **analytics:** modern Tremor UX dashboard, repository memory pivot platform, and swarm context compaction ([#1322](https://github.com/review-yeti-ai/review-yeti-bot/issues/1322)) ([d62ed82](https://github.com/review-yeti-ai/review-yeti-bot/commit/d62ed82c352c5dae0f8e2b7df6470a787a73bb1e))
* **infra:** add review-yeti.example.com custom domain and automated edge deployment workflow ([#1328](https://github.com/review-yeti-ai/review-yeti-bot/issues/1328)) ([84e99a4](https://github.com/review-yeti-ai/review-yeti-bot/commit/84e99a42b7a6a71a412ce25e4ac5ed3373b2cbd9))
* **live:** interactive 4-tier swarm and infrastructure topology visualizer with hover inspection ([#1325](https://github.com/review-yeti-ai/review-yeti-bot/issues/1325)) ([1e33ca7](https://github.com/review-yeti-ai/review-yeti-bot/commit/1e33ca73becfbadc13225760127cb3f10748d10b))


### Bug Fixes

* **ci:** bump the anonymity ratchet for the two files [#1333](https://github.com/review-yeti-ai/review-yeti-bot/issues/1333) grew ([#1337](https://github.com/review-yeti-ai/review-yeti-bot/issues/1337)) ([1cab903](https://github.com/review-yeti-ai/review-yeti-bot/commit/1cab903ba359c80e37bfd629f47df9aa5e2c9cab))
* **ci:** update the anonymity ratchet for the analytics de-org change ([#1336](https://github.com/review-yeti-ai/review-yeti-bot/issues/1336)) ([a5142c1](https://github.com/review-yeti-ai/review-yeti-bot/commit/a5142c1b29bb9c67e6f37ce02ea7d5b2152e4ef1))
* **REL-1265:** retain composed evidence on signed ready retries ([#1333](https://github.com/review-yeti-ai/review-yeti-bot/issues/1333)) ([bf7570e](https://github.com/review-yeti-ai/review-yeti-bot/commit/bf7570e73c9187de235bd3cfdfc16d10f119d9cd))

## [1.116.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.116.3...v1.116.4) (2026-10-02)


### Bug Fixes

* **preflight:** distinguish SQL and command fixtures from executable sinks ([#1314](https://github.com/review-yeti-ai/review-yeti-bot/issues/1314)) ([d2acf2b](https://github.com/review-yeti-ai/review-yeti-bot/commit/d2acf2baa7293407de86b0bb9d0ee7b9b8fdd5c6))

## [1.116.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.116.2...v1.116.3) (2026-10-02)


### Bug Fixes

* **auth:** remove the built-in admin password and fail closed without ADMIN_PASSWORD ([#1293](https://github.com/review-yeti-ai/review-yeti-bot/issues/1293)) ([8b3ab78](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b3ab78284927b08776315d87024ed861e3b646f))

## [1.116.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.116.1...v1.116.2) (2026-10-02)


### Bug Fixes

* **REL-1287:** bounded source context and immutable archive recovery ([#1267](https://github.com/review-yeti-ai/review-yeti-bot/issues/1267)) ([810b365](https://github.com/review-yeti-ai/review-yeti-bot/commit/810b36593a8ce8553da9ce3d82d5a7e018654c89))

## [1.116.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.116.0...v1.116.1) (2026-10-02)


### Bug Fixes

* **REL-1265:** re-review disputed tasks with immutable evidence ([#1258](https://github.com/review-yeti-ai/review-yeti-bot/issues/1258)) ([0d177d3](https://github.com/review-yeti-ai/review-yeti-bot/commit/0d177d383f25a121377f39b64fd450c86ae669e2))

## [1.116.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.115.2...v1.116.0) (2026-10-02)


### Features

* **dashboard:** interactive review management portal and analytics dashboard ([#1280](https://github.com/review-yeti-ai/review-yeti-bot/issues/1280)) ([3a377ff](https://github.com/review-yeti-ai/review-yeti-bot/commit/3a377ff138450c74dc09d73b3002a8be7ec14a86))


### Bug Fixes

* **REL-1250:** retain small inspected source through review compaction ([#1282](https://github.com/review-yeti-ai/review-yeti-bot/issues/1282)) ([f732aac](https://github.com/review-yeti-ai/review-yeti-bot/commit/f732aac7e1f003d36163b56023f07eb947233fea))
* **REL-1265:** restore publication build and isolated analytics contracts ([#1290](https://github.com/review-yeti-ai/review-yeti-bot/issues/1290)) ([c221e44](https://github.com/review-yeti-ai/review-yeti-bot/commit/c221e448cbdc279200685178d89e21e3dc6caceb))
* **review:** restore P2 as advisory so only P0/P1 block the check (REL-1282) ([#1281](https://github.com/review-yeti-ai/review-yeti-bot/issues/1281)) ([7de5424](https://github.com/review-yeti-ai/review-yeti-bot/commit/7de5424096b11203987a394f737f3909abfcc5d0))

## [1.115.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.115.1...v1.115.2) (2026-10-02)


### Bug Fixes

* keep composed WORK task context truthful ([#1275](https://github.com/review-yeti-ai/review-yeti-bot/issues/1275)) ([ff35bc6](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff35bc6117fb93fd0ca25222230ad16081722a35))

## [1.115.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.115.0...v1.115.1) (2026-10-02)


### Bug Fixes

* **review:** report retry admission only when confirmed ([#1269](https://github.com/review-yeti-ai/review-yeti-bot/issues/1269)) ([4b921c3](https://github.com/review-yeti-ai/review-yeti-bot/commit/4b921c37bfcfeed709aad64097789f2562e2e188))

## [1.115.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.114.1...v1.115.0) (2026-10-02)


### Features

* **grounding:** bound Zoekt index memory, add per-repo canary and a container memory floor (REL-1282) ([#1271](https://github.com/review-yeti-ai/review-yeti-bot/issues/1271)) ([2560a26](https://github.com/review-yeti-ai/review-yeti-bot/commit/2560a2639c2704103a15d75f09aee4597398ff2e))

## [1.114.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.114.0...v1.114.1) (2026-10-02)


### Bug Fixes

* keep deleted diff paths out of head tree evidence ([#1268](https://github.com/review-yeti-ai/review-yeti-bot/issues/1268)) ([ecfe7c1](https://github.com/review-yeti-ai/review-yeti-bot/commit/ecfe7c1e44df5a337bf8c5a8f7e5d664e8f3a861))

## [1.114.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.113.0...v1.114.0) (2026-10-02)


### Features

* **REL-1250:** portable runner families + bounded build heap + same-SHA A/B hook ([#1259](https://github.com/review-yeti-ai/review-yeti-bot/issues/1259)) ([91c42b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/91c42b7865076eb1273b2565e4d5c462f14e8290))

## [1.113.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.112.2...v1.113.0) (2026-10-02)


### Features

* make optional JEV classification part of review planning (REL-1081) ([#1253](https://github.com/review-yeti-ai/review-yeti-bot/issues/1253)) ([bdd868e](https://github.com/review-yeti-ai/review-yeti-bot/commit/bdd868e75da184eb73fd98bd869b770e21b812c0))

## [1.112.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.112.1...v1.112.2) (2026-10-02)


### Bug Fixes

* **review:** split oversized hunks without losing bounded coverage ([#1230](https://github.com/review-yeti-ai/review-yeti-bot/issues/1230)) ([398dd08](https://github.com/review-yeti-ai/review-yeti-bot/commit/398dd08a471ed66df32f9fcd70c5f0ec6019d846))

## [1.112.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.112.0...v1.112.1) (2026-10-02)


### Bug Fixes

* recover truncated gateway findings output (REL-1081) ([#1256](https://github.com/review-yeti-ai/review-yeti-bot/issues/1256)) ([22a0d44](https://github.com/review-yeti-ai/review-yeti-bot/commit/22a0d441d12313e5445ec1526ae7e4eb0ef9646d))

## [1.112.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.111.0...v1.112.0) (2026-10-02)


### Features

* **policy:** require resolution of P2 advisory findings before merge ([444622d](https://github.com/review-yeti-ai/review-yeti-bot/commit/444622d6eeda9dee9a9cb42a1f50cd96da74bb27))


### Bug Fixes

* **k8s:** treat terminal PRReviewJobs as already cancelled when the CRD rejects the patch ([#1255](https://github.com/review-yeti-ai/review-yeti-bot/issues/1255)) ([b9c9f52](https://github.com/review-yeti-ai/review-yeti-bot/commit/b9c9f5292ee7a581342c2bd92a1ab78d211fe477))
* **review:** reconcile Gate-bound abandoned failure publication ([#1254](https://github.com/review-yeti-ai/review-yeti-bot/issues/1254)) ([b265a56](https://github.com/review-yeti-ai/review-yeti-bot/commit/b265a568d8001e3a662f721f65237303516e1ce8))

## [1.111.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.110.0...v1.111.0) (2026-10-01)


### Features

* classify verified deletion evidence with advisory JEV questions (REL-1081) ([#1245](https://github.com/review-yeti-ai/review-yeti-bot/issues/1245)) ([c39ef3d](https://github.com/review-yeti-ai/review-yeti-bot/commit/c39ef3d54c30b37f8ec52cb95836b176b4df4772))

## [1.110.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.109.0...v1.110.0) (2026-10-01)


### Features

* **orchestrator:** publish GitHub PR reviews and inline suggestions from review workflow ([907b633](https://github.com/review-yeti-ai/review-yeti-bot/commit/907b6333577c3696bc94a832dcc3858980b5be4d))

## [1.109.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.108.0...v1.109.0) (2026-10-01)


### Features

* page original diffs and pinned deleted source (REL-1077) ([#1244](https://github.com/review-yeti-ai/review-yeti-bot/issues/1244)) ([9c7c4df](https://github.com/review-yeti-ai/review-yeti-bot/commit/9c7c4df6c3ab58540e59ea25e8bda5f32870b160))

## [1.108.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.107.0...v1.108.0) (2026-10-01)


### Features

* **orchestrator:** add merge-group webhook attestation with composite delta hazard scan ([#1243](https://github.com/review-yeti-ai/review-yeti-bot/issues/1243)) ([792fa99](https://github.com/review-yeti-ai/review-yeti-bot/commit/792fa999b0e3fa2c1a7c5be23b2963c8267b8d4e))

## [1.107.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.106.0...v1.107.0) (2026-10-01)


### Features

* **mcp:** support public read MCP access and /mcp route ([49d10a0](https://github.com/review-yeti-ai/review-yeti-bot/commit/49d10a0f47905fef311bcdb4ba36490b37ec89f5))
* **orchestrator:** add Cloudflare serverless orchestrator alongside k8s-operator ([ff9c54e](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff9c54ea1300add4cf5bf5d69eee242ccb578f12))


### Bug Fixes

* defer unused installation client loading in token auth ([#1241](https://github.com/review-yeti-ai/review-yeti-bot/issues/1241)) ([fd4fb6e](https://github.com/review-yeti-ai/review-yeti-bot/commit/fd4fb6e1c42692cf66704cbca66946e97ff87e7a))
* preserve scoped retrieval evidence and Zoekt budgets (REL-1077) ([#1240](https://github.com/review-yeti-ai/review-yeti-bot/issues/1240)) ([32eb060](https://github.com/review-yeti-ai/review-yeti-bot/commit/32eb0602d9bb1a26a8f7196b762ce36a8a748f56))

## [1.106.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.105.1...v1.106.0) (2026-10-01)


### Features

* retain content-free terminal review telemetry ([#1210](https://github.com/review-yeti-ai/review-yeti-bot/issues/1210)) ([42e89e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/42e89e46c05866e476593885b162259b731e4b89))

## [1.105.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.105.0...v1.105.1) (2026-10-01)


### Bug Fixes

* **mcp:** align compute_plane aliases in getCloudflareStatus ([8703f63](https://github.com/review-yeti-ai/review-yeti-bot/commit/8703f6344dc8df039c4177ae19c96d6d69e4935e))

## [1.105.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.104.4...v1.105.0) (2026-10-01)


### Features

* **mcp:** surface compute_plane in getCloudflareStatus ([6c960d7](https://github.com/review-yeti-ai/review-yeti-bot/commit/6c960d701d94d83387dffa17e1c025a8913b8797))

## [1.104.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.104.3...v1.104.4) (2026-10-01)


### Bug Fixes

* **mcp:** align zero-run savings and dynamic window scaling in runtime reports ([7a4c5a6](https://github.com/review-yeti-ai/review-yeti-bot/commit/7a4c5a60fafddc15a1231990a970b701f3b743d4))
* **mcp:** clarify shadowParity dataSource in getCloudflareStatus ([40a7f99](https://github.com/review-yeti-ai/review-yeti-bot/commit/40a7f99ee0334b83f1e67417efdcaecc4ec73e55))

## [1.104.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.104.2...v1.104.3) (2026-10-01)


### Bug Fixes

* bound schema bootstrap and stabilize qualification fixtures ([#1232](https://github.com/review-yeti-ai/review-yeti-bot/issues/1232)) ([8b24f57](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b24f57922f04822de15d4e8cf7f22ec5b94e12c))

## [1.104.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.104.1...v1.104.2) (2026-10-01)


### Bug Fixes

* preserve incomplete task evidence at findings stop ([#1229](https://github.com/review-yeti-ai/review-yeti-bot/issues/1229)) ([2cbb810](https://github.com/review-yeti-ai/review-yeti-bot/commit/2cbb810e070e2449a793bd405a886777af66832c))

## [1.104.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.104.0...v1.104.1) (2026-10-01)


### Bug Fixes

* **API-3377:** retain findings on graceful composed retries ([#1227](https://github.com/review-yeti-ai/review-yeti-bot/issues/1227)) ([75c5afb](https://github.com/review-yeti-ai/review-yeti-bot/commit/75c5afb27f8590775639f2d7593bf5b4a5a9d936))

## [1.104.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.103.3...v1.104.0) (2026-10-01)


### Features

* **composed:** early exit on max review findings and diff-only bypass for lockfiles ([#1221](https://github.com/review-yeti-ai/review-yeti-bot/issues/1221)) ([eeb5d81](https://github.com/review-yeti-ai/review-yeti-bot/commit/eeb5d81706a474d2f417b84b271ed69a5e80a11f))
* **composed:** swarm subagent context isolation, findings decomposition, and early blocker exit ([#1224](https://github.com/review-yeti-ai/review-yeti-bot/issues/1224)) ([f2f8895](https://github.com/review-yeti-ai/review-yeti-bot/commit/f2f8895175280432bfc5d6d94c4307816cb111ba))

## [1.103.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.103.2...v1.103.3) (2026-10-01)


### Bug Fixes

* **ci:** preserve draft validation on ready transition ([#1218](https://github.com/review-yeti-ai/review-yeti-bot/issues/1218)) ([2da96c5](https://github.com/review-yeti-ai/review-yeti-bot/commit/2da96c531946e35adf396346f1a6b41f8194f0fb))

## [1.103.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.103.1...v1.103.2) (2026-10-01)


### Bug Fixes

* **panel:** clarify composed PLAN task contracts ([#1215](https://github.com/review-yeti-ai/review-yeti-bot/issues/1215)) ([ff8d0f3](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff8d0f32d316b3c254c107360b715757f5d8adcb))

## [1.103.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.103.0...v1.103.1) (2026-10-01)


### Bug Fixes

* **worker:** verify runtime manifest file integrity ([#1208](https://github.com/review-yeti-ai/review-yeti-bot/issues/1208)) ([72f08c0](https://github.com/review-yeti-ai/review-yeti-bot/commit/72f08c01f3b587e902d70b31632acc5e258e5a1b))

## [1.103.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.102.1...v1.103.0) (2026-10-01)


### Features

* **review:** retain immutable composed tasks under the native fence ([#1181](https://github.com/review-yeti-ai/review-yeti-bot/issues/1181)) ([2ede42f](https://github.com/review-yeti-ai/review-yeti-bot/commit/2ede42fd1cebd611b89dde11e95bcc42a58143f1))

## [1.102.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.102.0...v1.102.1) (2026-10-01)


### Bug Fixes

* **review:** preserve typed panel failure classification ([#1212](https://github.com/review-yeti-ai/review-yeti-bot/issues/1212)) ([720c5e2](https://github.com/review-yeti-ai/review-yeti-bot/commit/720c5e23be214723834601264f5fd31e27f6d1a6))

## [1.102.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.9...v1.102.0) (2026-10-01)


### Features

* **review:** preserve evidence through graceful closeout ([#1203](https://github.com/review-yeti-ai/review-yeti-bot/issues/1203)) ([29a864f](https://github.com/review-yeti-ai/review-yeti-bot/commit/29a864fee8e607514039d59902085c85451301d0))

## [1.101.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.8...v1.101.9) (2026-10-01)


### Bug Fixes

* **review:** preserve terminal SSE metadata and provider errors ([#1202](https://github.com/review-yeti-ai/review-yeti-bot/issues/1202)) ([d137fc3](https://github.com/review-yeti-ai/review-yeti-bot/commit/d137fc3c326b428f3d1041372a95f34b397dc083))

## [1.101.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.7...v1.101.8) (2026-10-01)


### Bug Fixes

* **ci:** pin embedded Go qualification and safe failure evidence ([#1204](https://github.com/review-yeti-ai/review-yeti-bot/issues/1204)) ([d059560](https://github.com/review-yeti-ai/review-yeti-bot/commit/d0595608a7e4e59a4e0fd487057cd004c80516e6))

## [1.101.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.6...v1.101.7) (2026-10-01)


### Bug Fixes

* **ci:** run ordinary quality checks on public drafts ([#1195](https://github.com/review-yeti-ai/review-yeti-bot/issues/1195)) ([2a4ddf3](https://github.com/review-yeti-ai/review-yeti-bot/commit/2a4ddf369d54de2f231dc7beafa09f18f7654408))
* **panel:** refill composed task slots as turns are refunded ([#1205](https://github.com/review-yeti-ai/review-yeti-bot/issues/1205)) ([944ebaa](https://github.com/review-yeti-ai/review-yeti-bot/commit/944ebaa8a9f1d4f6e1551b5318a2e587e483cb21))

## [1.101.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.5...v1.101.6) (2026-10-01)


### Bug Fixes

* **review:** preserve admitted deadlines across configuration changes ([#1200](https://github.com/review-yeti-ai/review-yeti-bot/issues/1200)) ([9073967](https://github.com/review-yeti-ai/review-yeti-bot/commit/9073967490922a2413790c817b46db066e6f89b7))
* **review:** run composed tasks concurrently within the shared turn budget ([#1190](https://github.com/review-yeti-ai/review-yeti-bot/issues/1190)) ([ce858b0](https://github.com/review-yeti-ai/review-yeti-bot/commit/ce858b00e5bef7f10a94c7875d6c5e7673481a54))

## [1.101.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.4...v1.101.5) (2026-10-01)


### Bug Fixes

* **mcp:** report current review lifecycle phase truthfully ([#1188](https://github.com/review-yeti-ai/review-yeti-bot/issues/1188)) ([ebae015](https://github.com/review-yeti-ai/review-yeti-bot/commit/ebae01592bcd00bab0ed43c3e817a46d4b663a69))

## [1.101.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.3...v1.101.4) (2026-10-01)


### Bug Fixes

* **publishing:** size work within admitted lifecycle ([#1193](https://github.com/review-yeti-ai/review-yeti-bot/issues/1193)) ([ec4cbd3](https://github.com/review-yeti-ai/review-yeti-bot/commit/ec4cbd33509431b253548c58b3f3419337512d8e))

## [1.101.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.2...v1.101.3) (2026-10-01)


### Bug Fixes

* enforce 15-minute review deadline ([#1184](https://github.com/review-yeti-ai/review-yeti-bot/issues/1184)) ([a557775](https://github.com/review-yeti-ai/review-yeti-bot/commit/a55777530a54cd75736815405e02613f1c3f68e3))

## [1.101.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.1...v1.101.2) (2026-10-01)


### Bug Fixes

* **ci:** admit public self-review at ready or explicit request ([#1189](https://github.com/review-yeti-ai/review-yeti-bot/issues/1189)) ([ab8f557](https://github.com/review-yeti-ai/review-yeti-bot/commit/ab8f5574c79eb2be53ff9fa7c2b2550567b39fc6))

## [1.101.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.101.0...v1.101.1) (2026-10-01)


### Bug Fixes

* **review:** batch related source reads within one investigation turn ([#1185](https://github.com/review-yeti-ai/review-yeti-bot/issues/1185)) ([b680f7a](https://github.com/review-yeti-ai/review-yeti-bot/commit/b680f7a1be82372eb99d8e59635ecd96181d2f4d))

## [1.101.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.14...v1.101.0) (2026-10-01)


### Features

* **operator:** decouple reconcile concurrency from worker admission (ADR 0720) ([#1183](https://github.com/review-yeti-ai/review-yeti-bot/issues/1183)) ([6013ccc](https://github.com/review-yeti-ai/review-yeti-bot/commit/6013cccd4297f80576e33fef6c2d11c77c59ac35))

## [1.100.14](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.13...v1.100.14) (2026-09-30)


### Bug Fixes

* **worker:** enforce one admitted review deadline ([#1179](https://github.com/review-yeti-ai/review-yeti-bot/issues/1179)) ([da05f8c](https://github.com/review-yeti-ai/review-yeti-bot/commit/da05f8cd43c75770a5a24688a0cc415fe764389f))

## [1.100.13](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.12...v1.100.13) (2026-09-30)


### Bug Fixes

* **review:** attribute publishing panel progress ([#1178](https://github.com/review-yeti-ai/review-yeti-bot/issues/1178)) ([afbc4b4](https://github.com/review-yeti-ai/review-yeti-bot/commit/afbc4b45724d7330fa6854f9dee53b3e4688b9be))

## [1.100.12](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.11...v1.100.12) (2026-09-30)


### Bug Fixes

* **review:** read changed-file context at the exact head ([#1172](https://github.com/review-yeti-ai/review-yeti-bot/issues/1172)) ([d251e93](https://github.com/review-yeti-ai/review-yeti-bot/commit/d251e937f3afff59d31d11989a69975af8fdd0a0))

## [1.100.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.10...v1.100.11) (2026-09-30)


### Bug Fixes

* **REL-1206:** cancel active composed model requests ([#1175](https://github.com/review-yeti-ai/review-yeti-bot/issues/1175)) ([12243fa](https://github.com/review-yeti-ai/review-yeti-bot/commit/12243fa325a03a1fca08d651949f2c1c0ed10620))

## [1.100.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.9...v1.100.10) (2026-09-30)


### Bug Fixes

* scope review status timing to the current gate attempt ([#1163](https://github.com/review-yeti-ai/review-yeti-bot/issues/1163)) ([bb197df](https://github.com/review-yeti-ai/review-yeti-bot/commit/bb197df31604bd02257f71585d944302162b7b67))

## [1.100.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.8...v1.100.9) (2026-09-30)


### Bug Fixes

* **review:** preserve admitted worker deadline through grounding ([#1171](https://github.com/review-yeti-ai/review-yeti-bot/issues/1171)) ([d5357c2](https://github.com/review-yeti-ai/review-yeti-bot/commit/d5357c2c215e47488312d4c570ce2ce3f5cd9c88))
* **test:** own suite and run scratch lifecycle (REL-1209) ([#1168](https://github.com/review-yeti-ai/review-yeti-bot/issues/1168)) ([67f3678](https://github.com/review-yeti-ai/review-yeti-bot/commit/67f3678f9605c28e2e9a7759a0fdf7c9bb610967))

## [1.100.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.7...v1.100.8) (2026-09-30)


### Bug Fixes

* **mcp:** isolate webhook parsing from bounded API routes ([#1167](https://github.com/review-yeti-ai/review-yeti-bot/issues/1167)) ([592f8db](https://github.com/review-yeti-ai/review-yeti-bot/commit/592f8dbc1add65c4bf68f95d58840a466982ec0e))

## [1.100.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.6...v1.100.7) (2026-09-30)


### Bug Fixes

* **operator:** protect publishing workers from autoscaler scale-down ([#1166](https://github.com/review-yeti-ai/review-yeti-bot/issues/1166)) ([5589843](https://github.com/review-yeti-ai/review-yeti-bot/commit/5589843b5086b3a7bacc4a121373da96b84352b0))

## [1.100.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.5...v1.100.6) (2026-09-30)


### Bug Fixes

* **review:** scope retry timing and restore operator snapshots ([#1164](https://github.com/review-yeti-ai/review-yeti-bot/issues/1164)) ([7b6eb34](https://github.com/review-yeti-ai/review-yeti-bot/commit/7b6eb3481fc7c484e62b9b56deb487e32bfc8d9a))

## [1.100.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.4...v1.100.5) (2026-09-30)


### Bug Fixes

* read marker-bound legacy P2 receipts without inventing timestamps ([#1160](https://github.com/review-yeti-ai/review-yeti-bot/issues/1160)) ([be04746](https://github.com/review-yeti-ai/review-yeti-bot/commit/be047466313483dd3f7b58460dc32b76a76f644f))

## [1.100.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.3...v1.100.4) (2026-09-30)


### Bug Fixes

* **review:** read admitted legacy retained findings after supersession ([#1158](https://github.com/review-yeti-ai/review-yeti-bot/issues/1158)) ([9e1cacd](https://github.com/review-yeti-ai/review-yeti-bot/commit/9e1cacd17825085154591bfd05a80e83ae531eaf))

## [1.100.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.2...v1.100.3) (2026-09-30)


### Bug Fixes

* **review:** preserve full release-record depth and truthful execution disclosure ([#1156](https://github.com/review-yeti-ai/review-yeti-bot/issues/1156)) ([4719323](https://github.com/review-yeti-ai/review-yeti-bot/commit/4719323cf170db5a9ad14290bf36531bc62c1d2f))

## [1.100.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.1...v1.100.2) (2026-09-30)


### Bug Fixes

* **REL-1198:** authorize bounded MCP recovery and preserve review history ([#1154](https://github.com/review-yeti-ai/review-yeti-bot/issues/1154)) ([d23ac03](https://github.com/review-yeti-ai/review-yeti-bot/commit/d23ac03473a8d8230f295afde73d2ab4c329129f))

## [1.100.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.100.0...v1.100.1) (2026-09-30)


### Bug Fixes

* share native wire contract and bind terminal diagnostics ([#1151](https://github.com/review-yeti-ai/review-yeti-bot/issues/1151)) ([fb98a22](https://github.com/review-yeti-ai/review-yeti-bot/commit/fb98a226c64f280e8ebf58111edf4afffb918f88))

## [1.100.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.99.2...v1.100.0) (2026-09-30)


### Features

* **REL-1198:** retain P2 findings across bounded incomplete review recovery ([#1148](https://github.com/review-yeti-ai/review-yeti-bot/issues/1148)) ([3692774](https://github.com/review-yeti-ai/review-yeti-bot/commit/3692774fc9591152358c34324522baad631193f6))

## [1.99.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.99.1...v1.99.2) (2026-09-30)


### Bug Fixes

* recover composed verdict contracts and retain release record patches ([#1144](https://github.com/review-yeti-ai/review-yeti-bot/issues/1144)) ([d7dad81](https://github.com/review-yeti-ai/review-yeti-bot/commit/d7dad818d656d8664e4083a80983c2ab7c64b362))

## [1.99.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.99.0...v1.99.1) (2026-09-30)


### Bug Fixes

* **mcp:** fail closed across review status projections ([#1147](https://github.com/review-yeti-ai/review-yeti-bot/issues/1147)) ([87e1492](https://github.com/review-yeti-ai/review-yeti-bot/commit/87e149240d28d4ee43fc9dbd23e87fe03928eb5a))

## [1.99.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.98.1...v1.99.0) (2026-09-30)


### Features

* **composed:** exclude binary archives from task planning and scale multi-path turn ceiling ([#1145](https://github.com/review-yeti-ai/review-yeti-bot/issues/1145)) ([80dae26](https://github.com/review-yeti-ai/review-yeti-bot/commit/80dae26eef2e09181fca8f3f28a1a711585aaab7))

## [1.98.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.98.0...v1.98.1) (2026-09-30)


### Bug Fixes

* **review:** retain sanitized task finalization diagnostics ([#1142](https://github.com/review-yeti-ai/review-yeti-bot/issues/1142)) ([e5215f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/e5215f82be617ea05f5df65f230b543e0d719eb2))

## [1.98.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.12...v1.98.0) (2026-09-30)


### Features

* **operator:** add configurable reconciler concurrency and panel persona task composition ([#1140](https://github.com/review-yeti-ai/review-yeti-bot/issues/1140)) ([46bfc20](https://github.com/review-yeti-ai/review-yeti-bot/commit/46bfc200f2a515c0fa9e8a7a20c5864cf9f65b08))

## [1.97.12](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.11...v1.97.12) (2026-09-29)


### Bug Fixes

* **dispatch:** expose receipts for terminal gate verdicts and reorder worker supersession check ([#1138](https://github.com/review-yeti-ai/review-yeti-bot/issues/1138)) ([40fc5da](https://github.com/review-yeti-ai/review-yeti-bot/commit/40fc5da5e56da1972a768e35abaa3a5bdfa05497))

## [1.97.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.10...v1.97.11) (2026-09-29)


### Bug Fixes

* **dispatch:** recover proven legacy incomplete review generations [UAT-1704] ([#1136](https://github.com/review-yeti-ai/review-yeti-bot/issues/1136)) ([4988953](https://github.com/review-yeti-ai/review-yeti-bot/commit/4988953285004494567482135e6cb2f6ddc8df70))

## [1.97.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.9...v1.97.10) (2026-09-29)


### Bug Fixes

* classify unreported malformed review tasks as no verdict ([#1134](https://github.com/review-yeti-ai/review-yeti-bot/issues/1134)) ([9b48222](https://github.com/review-yeti-ai/review-yeti-bot/commit/9b4822224cee47f445708de8eb5c6af204c9dca9))

## [1.97.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.8...v1.97.9) (2026-09-29)


### Bug Fixes

* reserve composed task finalization turns ([#1131](https://github.com/review-yeti-ai/review-yeti-bot/issues/1131)) ([3fe7b7a](https://github.com/review-yeti-ai/review-yeti-bot/commit/3fe7b7a741f6a8594335740a898c72ff745e44b9))

## [1.97.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.7...v1.97.8) (2026-09-29)


### Bug Fixes

* **review:** report composed task coverage in checks ([#1128](https://github.com/review-yeti-ai/review-yeti-bot/issues/1128)) ([6304f9f](https://github.com/review-yeti-ai/review-yeti-bot/commit/6304f9fd5b8d2aa250a7eec87f2a72d0ab470f26))
* route env config files to review personas ([#1127](https://github.com/review-yeti-ai/review-yeti-bot/issues/1127)) ([699c90a](https://github.com/review-yeti-ai/review-yeti-bot/commit/699c90a676afe5a3036a5d825e2282a922072146))

## [1.97.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.6...v1.97.7) (2026-09-29)


### Bug Fixes

* **review:** honor DSH composed fallback in DOKS gate ([#1124](https://github.com/review-yeti-ai/review-yeti-bot/issues/1124)) ([e5ece67](https://github.com/review-yeti-ai/review-yeti-bot/commit/e5ece67ca5362b45828adab59e955d4e940d67a8))

## [1.97.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.5...v1.97.6) (2026-09-29)


### Bug Fixes

* **dispatch:** honor expedited MCP priority [REL-1189] ([ec27a16](https://github.com/review-yeti-ai/review-yeti-bot/commit/ec27a16a76dcedd366ebee0a22766243a7e3f7d9))

## [1.97.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.4...v1.97.5) (2026-09-29)


### Bug Fixes

* **mcp:** settle cancellation gate atomically [REL-1188] ([5679342](https://github.com/review-yeti-ai/review-yeti-bot/commit/5679342d48d813b8542ec0e7fc0993516ca784d3))

## [1.97.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.3...v1.97.4) (2026-09-29)


### Bug Fixes

* **release:** guard all continuation token aliases ([#1120](https://github.com/review-yeti-ai/review-yeti-bot/issues/1120)) ([05bd8a7](https://github.com/review-yeti-ai/review-yeti-bot/commit/05bd8a765631e4bc6f5ee48c05552e6da16b7ff7))

## [1.97.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.2...v1.97.3) (2026-09-29)


### Bug Fixes

* **app-gate:** verify durable completion receipt before operator success ([#1109](https://github.com/review-yeti-ai/review-yeti-bot/issues/1109)) ([ae33eff](https://github.com/review-yeti-ai/review-yeti-bot/commit/ae33effd7221f47116bddd377df67f4119b13070))

## [1.97.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.1...v1.97.2) (2026-09-29)


### Bug Fixes

* **review:** preserve reasoning headroom in hosted reviews ([#1116](https://github.com/review-yeti-ai/review-yeti-bot/issues/1116)) ([f459929](https://github.com/review-yeti-ai/review-yeti-bot/commit/f459929a72f0391620be87ba7dfae284c6edeb85))

## [1.97.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.97.0...v1.97.1) (2026-09-29)


### Bug Fixes

* **review:** retry undici fetch failures instead of quarantining every lane ([#1111](https://github.com/review-yeti-ai/review-yeti-bot/issues/1111)) ([7b4f422](https://github.com/review-yeti-ai/review-yeti-bot/commit/7b4f42235d8856176973a81e3fbb0896f8936528))

## [1.97.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.96.1...v1.97.0) (2026-09-29)


### Features

* **REL-1160:** default review continuations to true ([#1113](https://github.com/review-yeti-ai/review-yeti-bot/issues/1113)) ([3ac76d1](https://github.com/review-yeti-ai/review-yeti-bot/commit/3ac76d141c080353d8cde63b46c2058ed8c12395))

## [1.96.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.96.0...v1.96.1) (2026-09-29)


### Bug Fixes

* **dispatcher:** require durable cancellation acknowledgement [REL-1157] ([894ca1a](https://github.com/review-yeti-ai/review-yeti-bot/commit/894ca1a13a6a71fba138d78bffa5d1b00241f95b))
* **review:** bound hosted completion output [REL-976] ([#1101](https://github.com/review-yeti-ai/review-yeti-bot/issues/1101)) ([d342b95](https://github.com/review-yeti-ai/review-yeti-bot/commit/d342b951121c6e44f0a097ba79b73eb9dc74dddb))

## [1.96.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.95.0...v1.96.0) (2026-09-29)


### Features

* **REL-1160:** add durable review continuation execution ([23d4b6a](https://github.com/review-yeti-ai/review-yeti-bot/commit/23d4b6a2ea097b7426918f6e0e8da006d7f3ba35))

## [1.95.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.94.1...v1.95.0) (2026-09-29)


### Features

* **mcp:** expose review run timing on get_review_status ([#1099](https://github.com/review-yeti-ai/review-yeti-bot/issues/1099)) ([caaf714](https://github.com/review-yeti-ai/review-yeti-bot/commit/caaf7140d7d8f36443250836cc2b4e8287da0eb9))


### Bug Fixes

* **mcp:** use shared terminal deadline for review trigger ([#1104](https://github.com/review-yeti-ai/review-yeti-bot/issues/1104)) ([e7f836f](https://github.com/review-yeti-ai/review-yeti-bot/commit/e7f836fc0a348875920a494738f5c373d7ebe74a))

## [1.94.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.94.0...v1.94.1) (2026-09-28)


### Bug Fixes

* **transport:** remove Fireworks as a Review Yeti provider (REL-1162) ([#1094](https://github.com/review-yeti-ai/review-yeti-bot/issues/1094)) ([1858a86](https://github.com/review-yeti-ai/review-yeti-bot/commit/1858a86ffa10dcf8d3ca8c2adc86696ac6de5e01))

## [1.94.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.93.1...v1.94.0) (2026-09-28)


### Features

* **harness:** implement DOKS agentic harness lifecycle (API-3330, API-3333) ([#1093](https://github.com/review-yeti-ai/review-yeti-bot/issues/1093)) ([871217a](https://github.com/review-yeti-ai/review-yeti-bot/commit/871217ae59c1243aca088f7c1556000f647a5fe8))

## [1.93.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.93.0...v1.93.1) (2026-09-27)


### Bug Fixes

* **pipeline:** use tailnet dns url and bump default lane timeout to 240s ([6e74453](https://github.com/review-yeti-ai/review-yeti-bot/commit/6e74453f6f8ff51a787d1fd209246d70c5c34e54))

## [1.93.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.9...v1.93.0) (2026-09-26)


### Features

* **panel:** optional moderator skip on empty, fully covered runs; shadow eligibility on every run (REL-1139) ([#1088](https://github.com/review-yeti-ai/review-yeti-bot/issues/1088)) ([ec1e2e0](https://github.com/review-yeti-ai/review-yeti-bot/commit/ec1e2e0ff15808c20386198e81c74b7d118dd759))


### Bug Fixes

* **review:** never silently filter a changed lockfile; summarize an oversized one (REL-1141) ([#1089](https://github.com/review-yeti-ai/review-yeti-bot/issues/1089)) ([b5d5d51](https://github.com/review-yeti-ai/review-yeti-bot/commit/b5d5d5151106376fee05ece317284f629869a4f6))
* **review:** thrown panel infrastructure failures are INCOMPLETE and re-attempted, never "Failed live" (REL-1124) ([#1078](https://github.com/review-yeti-ai/review-yeti-bot/issues/1078)) ([d01b521](https://github.com/review-yeti-ai/review-yeti-bot/commit/d01b5214e7eeb65f44c15e319ccd555bad795e39))
* **telemetry:** sanitized error.cause on transport failures, W5 charsSaved per lane, reconciled Jev cost (REL-1138) ([#1087](https://github.com/review-yeti-ai/review-yeti-bot/issues/1087)) ([dbd1b0d](https://github.com/review-yeti-ai/review-yeti-bot/commit/dbd1b0dc89f4690df19bcf56c95391ffa5937762))

## [1.92.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.8...v1.92.9) (2026-09-25)


### Bug Fixes

* **review:** one security-sensitive path predicate with lockfiles and toolchain pins (REL-1135) ([#1081](https://github.com/review-yeti-ai/review-yeti-bot/issues/1081)) ([d589ef6](https://github.com/review-yeti-ai/review-yeti-bot/commit/d589ef65ab779a10d8734b6074e12698aab6cb81))

## [1.92.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.7...v1.92.8) (2026-09-25)


### Reverts

* **gateway:** stop bypassing the Bifrost response cache (REL-1134) ([#1082](https://github.com/review-yeti-ai/review-yeti-bot/issues/1082)) ([9977271](https://github.com/review-yeti-ai/review-yeti-bot/commit/9977271a0783bede3655444ff61cfcb7702b5fce))

## [1.92.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.6...v1.92.7) (2026-09-25)


### Bug Fixes

* **persistence:** skip already-applied schema DDL so rollouts stop deadlocking live traffic (REL-1127) ([#1073](https://github.com/review-yeti-ai/review-yeti-bot/issues/1073)) ([3d2c87a](https://github.com/review-yeti-ai/review-yeti-bot/commit/3d2c87acc95f13463e8677cc41f2d0db23129166))

## [1.92.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.5...v1.92.6) (2026-09-25)


### Bug Fixes

* **review:** close the Gate at once on a no-persona coverage failure instead of rejecting the completion with 422 (REL-1122) ([#1074](https://github.com/review-yeti-ai/review-yeti-bot/issues/1074)) ([2269793](https://github.com/review-yeti-ai/review-yeti-bot/commit/2269793718dc818de9867b9d42f05e79a78acedf))

## [1.92.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.4...v1.92.5) (2026-09-25)


### Bug Fixes

* **jev:** give every builtin charter a lane focus in the triage shadow (REL-1126) ([#1070](https://github.com/review-yeti-ai/review-yeti-bot/issues/1070)) ([99e560f](https://github.com/review-yeti-ai/review-yeti-bot/commit/99e560f25bc1dd74f60d391b7dd9507e85d4d39b))

## [1.92.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.3...v1.92.4) (2026-09-25)


### Bug Fixes

* **review:** route uncovered HTML pages and accept re-keyed lockfile entries instead of failing with no persona (REL-1118) ([#1068](https://github.com/review-yeti-ai/review-yeti-bot/issues/1068)) ([24313e6](https://github.com/review-yeti-ai/review-yeti-bot/commit/24313e693c492f23375561cf5536ef2ac4566170))

## [1.92.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.2...v1.92.3) (2026-09-25)


### Bug Fixes

* **REL-1116:** bound the BODY read, and correct two false claims in [#1059](https://github.com/review-yeti-ai/review-yeti-bot/issues/1059) ([#1066](https://github.com/review-yeti-ai/review-yeti-bot/issues/1066)) ([5192c41](https://github.com/review-yeti-ai/review-yeti-bot/commit/5192c411b1b5fb517dacbf587da3dedb0f7c4052))

## [1.92.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.1...v1.92.2) (2026-09-25)


### Bug Fixes

* **action:** infra lane failures in the Action pipeline are INCOMPLETE and re-attempted, never BLOCK (REL-1113) ([#1064](https://github.com/review-yeti-ai/review-yeti-bot/issues/1064)) ([9a78c76](https://github.com/review-yeti-ai/review-yeti-bot/commit/9a78c768a0d9e5f1e6b07d0a6d7999b687269e51))

## [1.92.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.92.0...v1.92.1) (2026-09-24)


### Bug Fixes

* **REL-1116:** an aborted signal hung the MCP transport instead of failing it ([#1059](https://github.com/review-yeti-ai/review-yeti-bot/issues/1059)) ([60c3fb8](https://github.com/review-yeti-ai/review-yeti-bot/commit/60c3fb8c047d37a49aa46e2b705ac4eea08cdbdf))

## [1.92.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.91.4...v1.92.0) (2026-09-24)


### Features

* **review:** let non-authoritative runs rest on a qualifying WorkerReviewEvidence prior (REL-1084, REL-1085) ([#1061](https://github.com/review-yeti-ai/review-yeti-bot/issues/1061)) ([ac1a5d8](https://github.com/review-yeti-ai/review-yeti-bot/commit/ac1a5d84f03dbb04624a2bdb82b14dcd25c561ae))

## [1.91.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.91.3...v1.91.4) (2026-09-24)


### Bug Fixes

* **gateway:** opt Review Yeti out of gateway-injected MCP tools (REL-1115) ([#1058](https://github.com/review-yeti-ai/review-yeti-bot/issues/1058)) ([f723356](https://github.com/review-yeti-ai/review-yeti-bot/commit/f723356809d7cd28ed06c9706279c25634e0b16c))

## [1.91.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.91.2...v1.91.3) (2026-09-24)


### Bug Fixes

* **review:** log why a prior is refused and judge its findings at published severity (REL-1084, REL-1085) ([#1055](https://github.com/review-yeti-ai/review-yeti-bot/issues/1055)) ([7935cf4](https://github.com/review-yeti-ai/review-yeti-bot/commit/7935cf40aa349e384c9b168de911e98d3a10bd61))

## [1.91.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.91.1...v1.91.2) (2026-09-24)


### Bug Fixes

* **gateway:** request streamed usage so reviews stop reporting 0 tokens (REL-1105) ([#1045](https://github.com/review-yeti-ai/review-yeti-bot/issues/1045)) ([5883edb](https://github.com/review-yeti-ai/review-yeti-bot/commit/5883edb079c9a1c2b1da64448232bf9a39b4f876))

## [1.91.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.91.0...v1.91.1) (2026-09-24)


### Bug Fixes

* **REL-1107:** retry transient identity probes, and say why publishing was refused ([#1049](https://github.com/review-yeti-ai/review-yeti-bot/issues/1049)) ([9f0ed7d](https://github.com/review-yeti-ai/review-yeti-bot/commit/9f0ed7df06d016f118e37480f283f2ad5312eb6a))

## [1.91.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.90.3...v1.91.0) (2026-09-24)


### Features

* **telemetry:** push worker metrics to VictoriaMetrics at exit (REL-1104) ([#1043](https://github.com/review-yeti-ai/review-yeti-bot/issues/1043)) ([d81be45](https://github.com/review-yeti-ai/review-yeti-bot/commit/d81be456759a775aa66932caecca5efe3194216c))

## [1.90.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.90.2...v1.90.3) (2026-09-24)


### Bug Fixes

* **review:** derive the prior review's verdict instead of reading result.verdict (REL-1084, REL-1085) ([#1047](https://github.com/review-yeti-ai/review-yeti-bot/issues/1047)) ([03b736f](https://github.com/review-yeti-ai/review-yeti-bot/commit/03b736fb42dc0501597d2b7bee225181011d36ce))

## [1.90.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.90.1...v1.90.2) (2026-09-24)


### Bug Fixes

* **github:** bounded retry for transient GitHub responses (REL-1103) ([#1041](https://github.com/review-yeti-ai/review-yeti-bot/issues/1041)) ([729d35c](https://github.com/review-yeti-ai/review-yeti-bot/commit/729d35c51b204cec9416eed4715621a255ed4e00))
* **review:** map-reduce only past what one call can hold (REL-1083) ([#1046](https://github.com/review-yeti-ai/review-yeti-bot/issues/1046)) ([0b50303](https://github.com/review-yeti-ai/review-yeti-bot/commit/0b503033eb02a58cac4f4f88725b2f9677255962))

## [1.90.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.90.0...v1.90.1) (2026-09-24)


### Bug Fixes

* **panel:** find_files supports globs and searches the full tree (REL-1102) ([#1042](https://github.com/review-yeti-ai/review-yeti-bot/issues/1042)) ([c31f964](https://github.com/review-yeti-ai/review-yeti-bot/commit/c31f9640b595f28e61729a82a391ec262e481f25))

## [1.90.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.89.0...v1.90.0) (2026-09-24)


### Features

* **review:** map-reduce review for huge diffs behind REVIEW_YETI_MAP_REDUCE (REL-1083) ([#1038](https://github.com/review-yeti-ai/review-yeti-bot/issues/1038)) ([1808c5d](https://github.com/review-yeti-ai/review-yeti-bot/commit/1808c5d9eae7e1e97d36662b2855f6a126eb853c))

## [1.89.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.88.0...v1.89.0) (2026-09-24)


### Features

* **review:** per-file verdict cache behind REVIEW_YETI_VERDICT_CACHE (REL-1085) ([#1036](https://github.com/review-yeti-ai/review-yeti-bot/issues/1036)) ([b2dddff](https://github.com/review-yeti-ai/review-yeti-bot/commit/b2dddff6829784d65fd486423d90ade025a33de0))

## [1.88.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.87.1...v1.88.0) (2026-09-24)


### Features

* **review:** risk-ordered review budget per lane behind REVIEW_YETI_BUDGET (REL-1082) ([#1026](https://github.com/review-yeti-ai/review-yeti-bot/issues/1026)) ([e8e428f](https://github.com/review-yeti-ai/review-yeti-bot/commit/e8e428f7334039072f9105cf3d1b0d9eaffbde2b))

## [1.87.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.87.0...v1.87.1) (2026-09-24)


### Bug Fixes

* **jev:** accept the live score contract and derive risk level by argmax (REL-1100) ([#1030](https://github.com/review-yeti-ai/review-yeti-bot/issues/1030)) ([8b5703b](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b5703b6aa0065fef8c15a253ed2c8cd29cbc906))

## [1.87.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.86.3...v1.87.0) (2026-09-24)


### Features

* **review:** incremental re-review on synchronize behind REVIEW_YETI_INCREMENTAL (REL-1084) ([#1028](https://github.com/review-yeti-ai/review-yeti-bot/issues/1028)) ([86307eb](https://github.com/review-yeti-ai/review-yeti-bot/commit/86307eb9a6c4d0de817726f36a9e6f6e521ce5d8))

## [1.86.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.86.2...v1.86.3) (2026-09-24)


### Bug Fixes

* **chart:** install the controller-gen PRReviewJob CRD instead of a hand copy (REL-1097) ([#1023](https://github.com/review-yeti-ai/review-yeti-bot/issues/1023)) ([d75da9d](https://github.com/review-yeti-ai/review-yeti-bot/commit/d75da9def82c90c435a6e8fb3834a56ecd2a4c44))
* **review:** name an omitted lockfile patch and drop wrong advice (REL-1099) ([#1024](https://github.com/review-yeti-ai/review-yeti-bot/issues/1024)) ([f301323](https://github.com/review-yeti-ai/review-yeti-bot/commit/f3013236dcc325c13b578c39ef504430faa787fe))

## [1.86.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.86.1...v1.86.2) (2026-09-24)


### Bug Fixes

* **dispatch:** cancel the PRReviewJob created after a mid-claim supersede (REL-1095) ([#1022](https://github.com/review-yeti-ai/review-yeti-bot/issues/1022)) ([7b44451](https://github.com/review-yeti-ai/review-yeti-bot/commit/7b4445111792ef40e560bd2b7d1f455c05edecef))

## [1.86.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.86.0...v1.86.1) (2026-09-24)


### Bug Fixes

* **review:** disclose patch truncation and omitted patches (REL-1092) ([#1019](https://github.com/review-yeti-ai/review-yeti-bot/issues/1019)) ([3f67a54](https://github.com/review-yeti-ai/review-yeti-bot/commit/3f67a544729bcf221d2ceedd8677a92521378908))

## [1.86.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.85.0...v1.86.0) (2026-09-24)


### Features

* **operator:** forward REVIEW_YETI_DIFF_SHRINK to app-gate worker Jobs (REL-1079) ([#1017](https://github.com/review-yeti-ai/review-yeti-bot/issues/1017)) ([3338625](https://github.com/review-yeti-ai/review-yeti-bot/commit/33386254666f8d82933ee534db83907fa978da50))

## [1.85.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.12...v1.85.0) (2026-09-24)


### Features

* **review:** Jev triage in shadow mode behind REVIEW_YETI_JEV_SHADOW (REL-1081) ([#1007](https://github.com/review-yeti-ai/review-yeti-bot/issues/1007)) ([1ca61fb](https://github.com/review-yeti-ai/review-yeti-bot/commit/1ca61fb19e987833e01382fed397a3a9ec2a340b))

## [1.84.12](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.11...v1.84.12) (2026-09-24)


### Bug Fixes

* **review:** compute 406 diffs from git on worker and trusted side (REL-1080) ([#1010](https://github.com/review-yeti-ai/review-yeti-bot/issues/1010)) ([ada674a](https://github.com/review-yeti-ai/review-yeti-bot/commit/ada674a1afa30d2d592a116d29b17d2466bf29e8))

## [1.84.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.10...v1.84.11) (2026-09-24)


### Bug Fixes

* **operator:** regenerate the PRReviewJob CRD so cancelRequested is not pruned (REL-1073) ([#1013](https://github.com/review-yeti-ai/review-yeti-bot/issues/1013)) ([92cbca9](https://github.com/review-yeti-ai/review-yeti-bot/commit/92cbca9bec60d00e5eb3664e1905b80e0327e9e0))

## [1.84.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.9...v1.84.10) (2026-09-24)


### Bug Fixes

* **review:** route uncovered source beside an applying lane to the required lane (REL-1088) ([#1008](https://github.com/review-yeti-ai/review-yeti-bot/issues/1008)) ([dbbf56c](https://github.com/review-yeti-ai/review-yeti-bot/commit/dbbf56c3a7122f4a044c744016a9c9a46ae27ebe))

## [1.84.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.8...v1.84.9) (2026-09-24)


### Bug Fixes

* **dispatcher:** actually cancel superseded PRReviewJobs (REL-1073) ([#996](https://github.com/review-yeti-ai/review-yeti-bot/issues/996)) ([a5babbb](https://github.com/review-yeti-ai/review-yeti-bot/commit/a5babbb454b8ae2b5eba2ee79eb80481626d5f30))

## [1.84.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.7...v1.84.8) (2026-09-24)


### Bug Fixes

* **REL-1069:** readiness reads the OpenAI/Bifrost standard, not vendor names ([#992](https://github.com/review-yeti-ai/review-yeti-bot/issues/992)) ([32fc6f3](https://github.com/review-yeti-ai/review-yeti-bot/commit/32fc6f37e582cbebde7c257f93afc291e5e1a6f2))

## [1.84.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.6...v1.84.7) (2026-09-23)


### Bug Fixes

* **review:** exempt registry-verified lockfile-only diffs as no reviewable content (REL-972) ([#993](https://github.com/review-yeti-ai/review-yeti-bot/issues/993)) ([f5468b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/f5468b7b0e1ae9c87aa7c94b683abcbc111c9502))

## [1.84.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.5...v1.84.6) (2026-09-23)


### Bug Fixes

* **review:** route .mdx and gitlink-only diffs to a lane instead of failing (REL-1058) ([#987](https://github.com/review-yeti-ai/review-yeti-bot/issues/987)) ([32183c5](https://github.com/review-yeti-ai/review-yeti-bot/commit/32183c5c5b3fdd249ce20b25483ad33bc3a2e7c5))

## [1.84.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.4...v1.84.5) (2026-09-23)


### Bug Fixes

* **REL-1056:** classify trusted-completion failures, stop retrying contract rejections ([#989](https://github.com/review-yeti-ai/review-yeti-bot/issues/989)) ([f1408d5](https://github.com/review-yeti-ai/review-yeti-bot/commit/f1408d5f340040681e39c7343b656d7e5cad7fe0))

## [1.84.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.3...v1.84.4) (2026-09-23)


### Bug Fixes

* **worker:** end a stale-head review as superseded instead of failed (REL-1057) ([#986](https://github.com/review-yeti-ai/review-yeti-bot/issues/986)) ([0140028](https://github.com/review-yeti-ai/review-yeti-bot/commit/01400281b88ab8c47ac3cff52f2a1cf85c6b5d03))

## [1.84.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.2...v1.84.3) (2026-09-23)


### Bug Fixes

* **dispatch:** make the review job dispatcher safe to run with 2+ replicas (REL-1053) ([#984](https://github.com/review-yeti-ai/review-yeti-bot/issues/984)) ([1944593](https://github.com/review-yeti-ai/review-yeti-bot/commit/1944593a0c46ca01614e98a96ba8506f1adbd977))

## [1.84.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.1...v1.84.2) (2026-09-23)


### Bug Fixes

* **review:** budget large exact-diff completion reads ([#982](https://github.com/review-yeti-ai/review-yeti-bot/issues/982)) ([b2c5666](https://github.com/review-yeti-ai/review-yeti-bot/commit/b2c5666b153099479ea1f3cc0387255e93b92036))

## [1.84.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.84.0...v1.84.1) (2026-09-23)


### Bug Fixes

* **review:** identify submodule gitlinks from diff patch headers [no-linear] ([#978](https://github.com/review-yeti-ai/review-yeti-bot/issues/978)) ([39b2ea9](https://github.com/review-yeti-ai/review-yeti-bot/commit/39b2ea9aa08d8778659b69f503d03db6db3c93bf))

## [1.84.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.9...v1.84.0) (2026-09-23)


### Features

* **mcp:** bidirectional MCP wiring, DeepSeek review harness, and engine selection ([#976](https://github.com/review-yeti-ai/review-yeti-bot/issues/976)) ([2aad7c7](https://github.com/review-yeti-ai/review-yeti-bot/commit/2aad7c70723d032101dcbc840a2f752a6b562c52))

## [1.83.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.8...v1.83.9) (2026-09-23)


### Bug Fixes

* **release:** recognize merged release commits ([#972](https://github.com/review-yeti-ai/review-yeti-bot/issues/972)) ([a4dc8bf](https://github.com/review-yeti-ai/review-yeti-bot/commit/a4dc8bf635479c17e7fe16d1f68d0179641b2404))

## [1.83.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.7...v1.83.8) (2026-09-23)


### Bug Fixes

* **pipeline:** route git submodule changes to architecture persona [no-linear] ([#965](https://github.com/review-yeti-ai/review-yeti-bot/issues/965)) ([c322e2a](https://github.com/review-yeti-ai/review-yeti-bot/commit/c322e2acbd2b7acd213fde6fbb34cb8c0afeb0ff))

## [1.83.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.6...v1.83.7) (2026-09-22)


### Bug Fixes

* **review:** route public worker credentials ([b0a8622](https://github.com/review-yeti-ai/review-yeti-bot/commit/b0a86229bdbd243669046677e958d9dda0b44fd8))
* **review:** route public worker credentials ([ff8a593](https://github.com/review-yeti-ai/review-yeti-bot/commit/ff8a593382ce4fd4eb9c3834237f8207c8cac982))

## [1.83.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.5...v1.83.6) (2026-09-22)


### Bug Fixes

* **dispatch:** limit public app to installation lookup ([c992bf0](https://github.com/review-yeti-ai/review-yeti-bot/commit/c992bf0de0b28f6d6076924ebe29dcc11a6b1415))
* **dispatch:** route public target through dedicated app ([9d17b7b](https://github.com/review-yeti-ai/review-yeti-bot/commit/9d17b7b2aa8b9aa00e650f1601461b2e9ce509ed))
* **dispatch:** route public target through dedicated app ([b81b82c](https://github.com/review-yeti-ai/review-yeti-bot/commit/b81b82ce8fbee2a17a61a0b064a7e8767a5a7d7f))

## [1.83.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.4...v1.83.5) (2026-09-22)


### Bug Fixes

* **dispatch:** reconcile lost review generations ([#966](https://github.com/review-yeti-ai/review-yeti-bot/issues/966)) ([0b4a7f0](https://github.com/review-yeti-ai/review-yeti-bot/commit/0b4a7f07298138cbf7e38cf1f0a8f8a3188b1a36))

## [1.83.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.3...v1.83.4) (2026-09-22)


### Bug Fixes

* derive authoritative review roster from changed paths ([#963](https://github.com/review-yeti-ai/review-yeti-bot/issues/963)) ([ca5577e](https://github.com/review-yeti-ai/review-yeti-bot/commit/ca5577e8a834d613803f5b1659bd8c9d2d34d5dc))

## [1.83.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.2...v1.83.3) (2026-09-22)


### Bug Fixes

* **dispatch:** admit manual central retries durably ([#961](https://github.com/review-yeti-ai/review-yeti-bot/issues/961)) ([467293a](https://github.com/review-yeti-ai/review-yeti-bot/commit/467293af0a5c35148568379cac4fd0e0b58c90b3))

## [1.83.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.1...v1.83.2) (2026-09-22)


### Bug Fixes

* **panel:** classify degenerate provider plans as provider_error, not contract ([#959](https://github.com/review-yeti-ai/review-yeti-bot/issues/959)) ([c680fe5](https://github.com/review-yeti-ai/review-yeti-bot/commit/c680fe5b182a767a415034c898f1db2be48c6277))

## [1.83.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.83.0...v1.83.1) (2026-09-22)


### Bug Fixes

* **ci:** restore Dockerfile.bot matching Dockerfile for multiarch builds ([#957](https://github.com/review-yeti-ai/review-yeti-bot/issues/957)) ([d6bd76c](https://github.com/review-yeti-ai/review-yeti-bot/commit/d6bd76ccdf7131dff8b86d998fca0eeea3033046))

## [1.83.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.7...v1.83.0) (2026-09-22)


### Features

* **mcp:** add native resources, SSE subscriptions, and advanced review tools ([#952](https://github.com/review-yeti-ai/review-yeti-bot/issues/952)) ([7be9afb](https://github.com/review-yeti-ai/review-yeti-bot/commit/7be9afb85af977cb6ecd085fe98a7b7a011f8cbc))

## [1.82.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.6...v1.82.7) (2026-09-22)


### Bug Fixes

* complete oversized PR reviews with bounded GitHub file evidence ([e33d181](https://github.com/review-yeti-ai/review-yeti-bot/commit/e33d181071b288a993ba2d0866ba6833b87ba14a))
* **review:** bound reconstructed diff CPU ([aaa94ba](https://github.com/review-yeti-ai/review-yeti-bot/commit/aaa94ba6d82ee415c406a2fb9114d4e7ca674779))
* **review:** complete oversized PR evidence ([8352d83](https://github.com/review-yeti-ai/review-yeti-bot/commit/8352d8321e7a8f35615db78e34e533ea912c9376))

## [1.82.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.5...v1.82.6) (2026-09-22)


### Bug Fixes

* **review:** admit centrally verified docs-only gates ([#942](https://github.com/review-yeti-ai/review-yeti-bot/issues/942)) ([b36e65a](https://github.com/review-yeti-ai/review-yeti-bot/commit/b36e65af56b6f93a7d78d2496696c7eb35f0f9af))

## [1.82.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.4...v1.82.5) (2026-09-22)


### Bug Fixes

* **mcp:** govern exact-head review triggers ([5ce2471](https://github.com/review-yeti-ai/review-yeti-bot/commit/5ce24719070563b7c91007c9097045c0c25b1956))
* **mcp:** govern exact-head review triggers ([16f6568](https://github.com/review-yeti-ai/review-yeti-bot/commit/16f65680886ca9fd49d05f2f607ea757c8c6f376))

## [1.82.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.3...v1.82.4) (2026-09-22)


### Bug Fixes

* **review:** bind authoritative execution to admitted personas ([#938](https://github.com/review-yeti-ai/review-yeti-bot/issues/938)) ([f01374e](https://github.com/review-yeti-ai/review-yeti-bot/commit/f01374ef887cb3beae907abaf87f557886e9a101))

## [1.82.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.2...v1.82.3) (2026-09-22)


### Bug Fixes

* publish release multiarch indexes ([#936](https://github.com/review-yeti-ai/review-yeti-bot/issues/936)) ([6fd4357](https://github.com/review-yeti-ai/review-yeti-bot/commit/6fd43570aa9bc661b40644793b3834c40dc38c89))

## [1.82.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.1...v1.82.2) (2026-09-22)


### Bug Fixes

* **review:** recoverable-panel roster bounds and gate publication order ([#931](https://github.com/review-yeti-ai/review-yeti-bot/issues/931)) ([6c0513a](https://github.com/review-yeti-ai/review-yeti-bot/commit/6c0513a1dcc03e704207ef142fd370fcc731b1ca))

## [1.82.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.82.0...v1.82.1) (2026-09-22)


### Bug Fixes

* classify review completion persistence stages ([#932](https://github.com/review-yeti-ai/review-yeti-bot/issues/932)) ([7f49128](https://github.com/review-yeti-ai/review-yeti-bot/commit/7f49128b6d7f7ac817ae0d92f9dd9b7338c27adb))

## [1.82.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.7...v1.82.0) (2026-09-22)


### Features

* **mcp:** remote Model Context Protocol endpoint and 8-tool catalog on action dispatch [no-linear] ([#922](https://github.com/review-yeti-ai/review-yeti-bot/issues/922)) ([0c0115f](https://github.com/review-yeti-ai/review-yeti-bot/commit/0c0115fe53070b837f5c4df8e8a7d3b631905a3c))

## [1.81.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.6...v1.81.7) (2026-09-21)


### Bug Fixes

* **composed:** name a spent turn budget separately from a missing verdict ([#918](https://github.com/review-yeti-ai/review-yeti-bot/issues/918)) ([84aa557](https://github.com/review-yeti-ai/review-yeti-bot/commit/84aa55760ff55e776e4cbdb9eb375a4c5874870b))

## [1.81.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.5...v1.81.6) (2026-09-21)


### Bug Fixes

* **image:** ship the bot domain index in the bot image ([#916](https://github.com/review-yeti-ai/review-yeti-bot/issues/916)) ([dd05b94](https://github.com/review-yeti-ai/review-yeti-bot/commit/dd05b940f06c08cea4c2476e2a29b0589968e653))

## [1.81.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.4...v1.81.5) (2026-09-21)


### Bug Fixes

* **composed:** review the real diff when a plan names other paths ([2ce8cc2](https://github.com/review-yeti-ai/review-yeti-bot/commit/2ce8cc24dd298369a44ada61eeb516a9b598859b))

## [1.81.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.3...v1.81.4) (2026-09-21)


### Bug Fixes

* **ci:** close the release-tag expression in the image summary ([ec0a9fc](https://github.com/review-yeti-ai/review-yeti-bot/commit/ec0a9fca05198131f802107ce04773d2586ba1f1))
* **composed:** fold capitalized task ids into the roster format ([#906](https://github.com/review-yeti-ai/review-yeti-bot/issues/906)) ([696af00](https://github.com/review-yeti-ai/review-yeti-bot/commit/696af00a00afc22175f82dcbd3471ec03499301b))

## [1.81.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.2...v1.81.3) (2026-09-21)


### Bug Fixes

* **composed:** clamp oversized plan text instead of failing the review ([49c62f1](https://github.com/review-yeti-ai/review-yeti-bot/commit/49c62f163184b904aca0a32475473478aaf69e9c))

## [1.81.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.1...v1.81.2) (2026-09-21)


### Bug Fixes

* **composed:** approve a diff with nothing analyzable on the composed path too ([#899](https://github.com/review-yeti-ai/review-yeti-bot/issues/899)) ([139739c](https://github.com/review-yeti-ai/review-yeti-bot/commit/139739c5928b6be419cd3ae50e9d7f38d2d7d84a))

## [1.81.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.81.0...v1.81.1) (2026-09-21)


### Bug Fixes

* **publish:** enforce auto_review.ignore_patterns as declared not-applicable (skip, never SHIP) ([#897](https://github.com/review-yeti-ai/review-yeti-bot/issues/897)) ([1853e43](https://github.com/review-yeti-ai/review-yeti-bot/commit/1853e436741718d3971504b9108a0e56983f1ca8))

## [1.81.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.80.1...v1.81.0) (2026-09-21)


### Features

* **transport:** admit Fireworks as a review destination ([#894](https://github.com/review-yeti-ai/review-yeti-bot/issues/894)) ([fce0569](https://github.com/review-yeti-ai/review-yeti-bot/commit/fce05696b7ea07da40ec8789efdc683c3066697b))

## [1.80.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.80.0...v1.80.1) (2026-09-21)


### Bug Fixes

* **panel:** retry the router alias on INCOMPLETE instead of failing closed ([#874](https://github.com/review-yeti-ai/review-yeti-bot/issues/874)) ([c8824c7](https://github.com/review-yeti-ai/review-yeti-bot/commit/c8824c70d25d5161a4ef185242c5f3b4d59ffa41))
* **personas:** give arch-lane an architecture charter instead of a governance one ([#888](https://github.com/review-yeti-ai/review-yeti-bot/issues/888)) ([d980795](https://github.com/review-yeti-ai/review-yeti-bot/commit/d9807951b061434685462d426ca112d4e7b9b002))
* **qualification:** admit diffs up to ~80k lines via the pull-files fallback ([#891](https://github.com/review-yeti-ai/review-yeti-bot/issues/891)) ([457499b](https://github.com/review-yeti-ai/review-yeti-bot/commit/457499b57ffeeb76a3fa2aded2429407f5b7d59a))

## [1.80.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.79.0...v1.80.0) (2026-09-21)


### Features

* **transport:** admit a third, digest-pinned review destination ([#886](https://github.com/review-yeti-ai/review-yeti-bot/issues/886)) ([543ea14](https://github.com/review-yeti-ai/review-yeti-bot/commit/543ea143835d2f4b500e753678b753cc9243dc7a))

## [1.79.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.78.0...v1.79.0) (2026-09-21)


### Features

* **arbitration:** let callers pin panelSize so a task list cannot loosen the merge gate ([#868](https://github.com/review-yeti-ai/review-yeti-bot/issues/868)) ([907b5d5](https://github.com/review-yeti-ai/review-yeti-bot/commit/907b5d59a1e1a329c1734a65b1fbad6abc0c40cc))
* **panel:** add review task plan data model and validator ([#869](https://github.com/review-yeti-ai/review-yeti-bot/issues/869)) ([e0f2933](https://github.com/review-yeti-ai/review-yeti-bot/commit/e0f293384d6dc998a01481ace53dd9bf3f8e69e0))
* **panel:** add turn-window compaction for the persona tool loop ([#870](https://github.com/review-yeti-ai/review-yeti-bot/issues/870)) ([3fc6855](https://github.com/review-yeti-ai/review-yeti-bot/commit/3fc6855f3f16e354b8b9bf537717334b7ae5dafb))
* **panel:** composed single-context review engine (REVIEW_ENGINE flag) ([#875](https://github.com/review-yeti-ai/review-yeti-bot/issues/875)) ([afb72ec](https://github.com/review-yeti-ai/review-yeti-bot/commit/afb72ecbce5999bb89baf17bd9a18a0127af8eb0))
* **panel:** run the composed engine as non-gating shadow evidence ([#880](https://github.com/review-yeti-ai/review-yeti-bot/issues/880)) ([b1d7d4b](https://github.com/review-yeti-ai/review-yeti-bot/commit/b1d7d4b467136b7021924865612ce849d4939f54))
* **policy:** make review engine selection base-policy driven ([#877](https://github.com/review-yeti-ai/review-yeti-bot/issues/877)) ([1b104f6](https://github.com/review-yeti-ai/review-yeti-bot/commit/1b104f6c91447efd133f47ff2457a5bca91feb9a))
* **pre-checks:** deterministic Symbol Resolution Appendix ([#881](https://github.com/review-yeti-ai/review-yeti-bot/issues/881)) ([69f2e8c](https://github.com/review-yeti-ai/review-yeti-bot/commit/69f2e8c49ee1d291075603feb523498997fd1eca))
* **transport:** support opencode as a review transport (REL-976) ([#885](https://github.com/review-yeti-ai/review-yeti-bot/issues/885)) ([030adfc](https://github.com/review-yeti-ai/review-yeti-bot/commit/030adfcd36cad2a56abb5963505aac7a11724cf7))


### Bug Fixes

* **config:** retire synthetic from the default review roster ([#883](https://github.com/review-yeti-ai/review-yeti-bot/issues/883)) ([407411c](https://github.com/review-yeti-ai/review-yeti-bot/commit/407411c5169d278dededd623322f87be8702184e))
* **generator:** make the provider catalog a single source of truth (REL-985) ([#884](https://github.com/review-yeti-ai/review-yeti-bot/issues/884)) ([6a11efa](https://github.com/review-yeti-ai/review-yeti-bot/commit/6a11efa4e0b25f2d4bb7c29dcb1f106437c30ee6))
* **models:** move review defaults to flash/light and retire glm-5.2 ([#882](https://github.com/review-yeti-ai/review-yeti-bot/issues/882)) ([66fccf9](https://github.com/review-yeti-ai/review-yeti-bot/commit/66fccf9fa2f18844a4346e76020a246cb5b26973))
* **panel:** give the composed engine the transport resilience it lost with fan-out ([#876](https://github.com/review-yeti-ai/review-yeti-bot/issues/876)) ([fd74290](https://github.com/review-yeti-ai/review-yeti-bot/commit/fd74290b5f7da0f2d2218b6a51762bb2b4c48828))
* **panel:** make a persona coverage gap actionable, not an internal error ([#867](https://github.com/review-yeti-ai/review-yeti-bot/issues/867)) ([7252578](https://github.com/review-yeti-ai/review-yeti-bot/commit/725257862a5e5fb5f1fecbd6af960ca019a49b90))
* **panel:** wire the composed deadline, reject unknown policy keys, clamp the env override ([#879](https://github.com/review-yeti-ai/review-yeti-bot/issues/879)) ([4c00e11](https://github.com/review-yeti-ai/review-yeti-bot/commit/4c00e114ba8a2fabd912418ba5fc7fcae34fc705))
* **telemetry:** carry panelWallClockMs and toolCalls across the completion boundary ([#871](https://github.com/review-yeti-ai/review-yeti-bot/issues/871)) ([a0a92f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/a0a92f861c018364f1c020cded9a0aef53788e08))

## [1.78.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.77.0...v1.78.0) (2026-09-18)


### Features

* **gateway:** add Jev (TypeSafe AI System One) client, transport, and test double ([#860](https://github.com/review-yeti-ai/review-yeti-bot/issues/860)) ([3b70099](https://github.com/review-yeti-ai/review-yeti-bot/commit/3b7009946d56411c90ddeef88aa182eb0f04442a))


### Bug Fixes

* **panel:** refine adjudication prompts, persona scoping, gating rules, and test harnesses ([3900458](https://github.com/review-yeti-ai/review-yeti-bot/commit/3900458ed7ce5216871f131418ee46e3c9d14b40))

## [1.77.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.76.3...v1.77.0) (2026-09-18)


### Features

* **publishing:** wire full-repo grounding and zoekt index-build telemetry ([#861](https://github.com/review-yeti-ai/review-yeti-bot/issues/861)) ([a6ab89b](https://github.com/review-yeti-ai/review-yeti-bot/commit/a6ab89bff97c70d17fe68faec8cc4d473546d626))

## [1.76.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.76.2...v1.76.3) (2026-09-18)


### Bug Fixes

* **REL-967:** route config-data JSON/JSONL to a persona instead of failing the panel ([#863](https://github.com/review-yeti-ai/review-yeti-bot/issues/863)) ([4e3b667](https://github.com/review-yeti-ai/review-yeti-bot/commit/4e3b667e081d4b0a62ba153c37e3a7efcaf2759e))

## [1.76.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.76.1...v1.76.2) (2026-09-18)


### Bug Fixes

* **gateway:** reject truncated reasoning-only completions on finish_reason=length ([#856](https://github.com/review-yeti-ai/review-yeti-bot/issues/856)) ([7e9d8a8](https://github.com/review-yeti-ai/review-yeti-bot/commit/7e9d8a8664332bbe52364c2f313fd78b4e2b7c27))

## [1.76.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.76.0...v1.76.1) (2026-09-18)


### Bug Fixes

* **gateway:** name the upstream that actually answered, not always OpenRouter ([#855](https://github.com/review-yeti-ai/review-yeti-bot/issues/855)) ([a2d6674](https://github.com/review-yeti-ai/review-yeti-bot/commit/a2d66741758e2459c569e60de016344645c593c1))

## [1.76.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.75.1...v1.76.0) (2026-09-18)


### Features

* **REL-677:** operator forwards zoekt grounding opt-in to worker Jobs ([#853](https://github.com/review-yeti-ai/review-yeti-bot/issues/853)) ([f9ab179](https://github.com/review-yeti-ai/review-yeti-bot/commit/f9ab179d7f5a0708a5300e97e3b2277139e576a9))

## [1.75.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.75.0...v1.75.1) (2026-09-18)


### Bug Fixes

* **panel:** back off and retry provider transport failures (REL-940) ([#851](https://github.com/review-yeti-ai/review-yeti-bot/issues/851)) ([ebce3d1](https://github.com/review-yeti-ai/review-yeti-bot/commit/ebce3d121f77b0518202dc98e84df651475b74e4))

## [1.75.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.74.0...v1.75.0) (2026-09-17)


### Features

* **REL-677:** wire zoekt index-at-review-time grounding into the publishing worker ([#846](https://github.com/review-yeti-ai/review-yeti-bot/issues/846)) ([8b1ef87](https://github.com/review-yeti-ai/review-yeti-bot/commit/8b1ef8723553d5a9bf73c498b86a30743a4b05b8))

## [1.74.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.73.3...v1.74.0) (2026-09-17)


### Features

* **REL-903:** quiet, metric-counted requeue for reconciler write conflicts ([#845](https://github.com/review-yeti-ai/review-yeti-bot/issues/845)) ([6c75429](https://github.com/review-yeti-ai/review-yeti-bot/commit/6c7542935e274f2fa4ee9a200fb4c350ee49f393))

## [1.73.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.73.2...v1.73.3) (2026-09-17)


### Bug Fixes

* **operator:** publish pre-worker rejections promptly and keep failed worker Jobs for their TTL (REL-896) ([#847](https://github.com/review-yeti-ai/review-yeti-bot/issues/847)) ([18057b9](https://github.com/review-yeti-ai/review-yeti-bot/commit/18057b9e264cbb2ee7b5108fa156370223139625))

## [1.73.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.73.1...v1.73.2) (2026-09-17)


### Bug Fixes

* **REL-896:** tolerate a missing worker Job when releasing or adding its finalizer ([#842](https://github.com/review-yeti-ai/review-yeti-bot/issues/842)) ([563bcb2](https://github.com/review-yeti-ai/review-yeti-bot/commit/563bcb21648404b06196058a4bcea31e33fb53ae))

## [1.73.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.73.0...v1.73.1) (2026-09-17)


### Bug Fixes

* **REL-888:** normalize case-only structured-output drift before the corrective turn ([#838](https://github.com/review-yeti-ai/review-yeti-bot/issues/838)) ([c10a8a4](https://github.com/review-yeti-ai/review-yeti-bot/commit/c10a8a438bce8ad424104b50593cb0cf61bf4e48))

## [1.73.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.11...v1.73.0) (2026-09-17)


### Features

* **panel:** partition changed files into domain lanes and provide zero-diff pull manifest ([9e67b3b](https://github.com/review-yeti-ai/review-yeti-bot/commit/9e67b3b06865c8ff3a7482c762d3a3dd14ee368a))

## [1.72.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.10...v1.72.11) (2026-09-17)


### Bug Fixes

* **REL-896:** patch PRReviewJob finalizers as metadata only; the spec is immutable server-side ([#837](https://github.com/review-yeti-ai/review-yeti-bot/issues/837)) ([814c84f](https://github.com/review-yeti-ai/review-yeti-bot/commit/814c84faf721e53f3f5b57b25c464e4b4909906b))

## [1.72.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.9...v1.72.10) (2026-09-17)


### Bug Fixes

* **REL-896:** reaper acts on the operator's delegated-failure signal before the deadline ([#832](https://github.com/review-yeti-ai/review-yeti-bot/issues/832)) ([46fe175](https://github.com/review-yeti-ai/review-yeti-bot/commit/46fe1757516a93c24b7bfd3f4b012283d0ce5678))

## [1.72.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.8...v1.72.9) (2026-09-17)


### Bug Fixes

* **panel:** redact provider error text before it reaches the log sink (REL-892) ([#826](https://github.com/review-yeti-ai/review-yeti-bot/issues/826)) ([ecf8bb3](https://github.com/review-yeti-ai/review-yeti-bot/commit/ecf8bb304befb1f790be44868c383204c62211fd))
* **tests:** unconditionally unstub fetch after OmniRouteClient redaction tests ([ecf8bb3](https://github.com/review-yeti-ai/review-yeti-bot/commit/ecf8bb304befb1f790be44868c383204c62211fd))

## [1.72.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.7...v1.72.8) (2026-09-17)


### Bug Fixes

* **REL-896:** operator owns PRReviewJob and run-Secret cleanup natively; CI runs the operator tests ([#828](https://github.com/review-yeti-ai/review-yeti-bot/issues/828)) ([21b734d](https://github.com/review-yeti-ai/review-yeti-bot/commit/21b734ddd3c264a5439bb63e68209dbe307ce8f6))

## [1.72.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.6...v1.72.7) (2026-09-17)


### Bug Fixes

* **review:** restore structured failure telemetry on recoverable panel failures ([#821](https://github.com/review-yeti-ai/review-yeti-bot/issues/821)) ([2aa73e8](https://github.com/review-yeti-ai/review-yeti-bot/commit/2aa73e827e6417874c1eda551b9dc71aacb21f53))

## [1.72.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.5...v1.72.6) (2026-09-17)


### Bug Fixes

* **REL-896:** terminalize in-flight review runs when a pull request closes ([#827](https://github.com/review-yeti-ai/review-yeti-bot/issues/827)) ([4fa0d2b](https://github.com/review-yeti-ai/review-yeti-bot/commit/4fa0d2b29752faa76a78b7ea02c0699fa7921650))

## [1.72.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.4...v1.72.5) (2026-09-17)


### Bug Fixes

* **test:** stop reviewRunLifecycle reaper test colliding on the advisory-lock keyspace ([#824](https://github.com/review-yeti-ai/review-yeti-bot/issues/824)) ([345577b](https://github.com/review-yeti-ai/review-yeti-bot/commit/345577badc1c8363cbe159f1ec6034dd27eee13e))

## [1.72.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.3...v1.72.4) (2026-09-16)


### Bug Fixes

* **review:** automatically retry a recoverable-incomplete-panel failure [no-linear] ([#815](https://github.com/review-yeti-ai/review-yeti-bot/issues/815)) ([37c4990](https://github.com/review-yeti-ai/review-yeti-bot/commit/37c4990a035d53169af6f1a16e33691b98f2aa31))

## [1.72.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.2...v1.72.3) (2026-09-16)


### Bug Fixes

* **REL-886:** retry the empty-completion signature against the same alias ([dc22aaf](https://github.com/review-yeti-ai/review-yeti-bot/commit/dc22aaf84e73d98c4fa6da73774afdefef755918))

## [1.72.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.1...v1.72.2) (2026-09-16)


### Bug Fixes

* **review:** classify GitHub HTTP 406 diff reads as contract, not internal_error ([#813](https://github.com/review-yeti-ai/review-yeti-bot/issues/813)) ([1340be1](https://github.com/review-yeti-ai/review-yeti-bot/commit/1340be1855f11cf4024d4268649780535f22dce6))

## [1.72.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.72.0...v1.72.1) (2026-09-16)


### Bug Fixes

* **review:** retire non-publishable runs stuck past their deadline ([#814](https://github.com/review-yeti-ai/review-yeti-bot/issues/814)) ([e7f7af1](https://github.com/review-yeti-ai/review-yeti-bot/commit/e7f7af19dd1a9e21f67b7b7b3e1d9ed9452c15c5))

## [1.72.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.71.0...v1.72.0) (2026-09-16)


### Features

* **gate:** report the findings behind a self-published check as evidence for both conclusions ([#811](https://github.com/review-yeti-ai/review-yeti-bot/issues/811)) ([06f5c10](https://github.com/review-yeti-ai/review-yeti-bot/commit/06f5c102fd0d5ff25c45dfcd3ff164ff3c1a95a9))

## [1.71.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.70.0...v1.71.0) (2026-09-16)


### Features

* **telemetry:** eliminate legacy ct prefixes and remove compile-heavy analyzers ([70b2aa2](https://github.com/review-yeti-ai/review-yeti-bot/commit/70b2aa240b8433c6bf4d8e9a69117ae850e20bcd))

## [1.70.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.69.2...v1.70.0) (2026-09-16)


### Features

* **telemetry:** instrument zoekt and analyzer pre-checks with review_yeti namespace ([d911cc5](https://github.com/review-yeti-ai/review-yeti-bot/commit/d911cc5063d9692c5cb3c2ff60f80386be924c51))

## [1.69.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.69.1...v1.69.2) (2026-09-15)


### Bug Fixes

* **REL-872:** delete internal-infra plan doc from the public repo ([#806](https://github.com/review-yeti-ai/review-yeti-bot/issues/806)) ([5703252](https://github.com/review-yeti-ai/review-yeti-bot/commit/5703252056c90bbdf2f2b54d9a43ca012b2d1975))

## [1.69.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.69.0...v1.69.1) (2026-09-15)


### Bug Fixes

* **API-3260:** treat persona INCOMPLETE as malformed_output and failover ([#805](https://github.com/review-yeti-ai/review-yeti-bot/issues/805)) ([5f17692](https://github.com/review-yeti-ai/review-yeti-bot/commit/5f1769280c7bcddbf11c14111a91e1e40076ec15))

## [1.69.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.68.1...v1.69.0) (2026-09-15)


### Features

* **pre-checks:** replace miller with zoekt symbol pre-checks and sandbox analyzers, ban legacy models ([a405227](https://github.com/review-yeti-ai/review-yeti-bot/commit/a4052270d3c23163862168ecf6215fb257578551))


### Bug Fixes

* **models:** allow legacy models publicly and standardize modern Sept 2026 testing defaults ([ab37931](https://github.com/review-yeti-ai/review-yeti-bot/commit/ab379317011627a732bd632b58b8a7fb8efdaf1c))
* **schema:** make pre_checks optional on v3 schema and allow boolean secrets toggle in prepared storage ([3cc068e](https://github.com/review-yeti-ai/review-yeti-bot/commit/3cc068e75aa0f87c20ee95a02935e18dbb4b46ce))
* **tests:** update zoekt max_symbols expectation and remove internal identifiers from plan doc ([d0faf27](https://github.com/review-yeti-ai/review-yeti-bot/commit/d0faf27d66229cf31da452d348b4b20f8da4f7f3))
* **types:** resolve test and config typing for pre-check test suites ([a331713](https://github.com/review-yeti-ai/review-yeti-bot/commit/a3317137e841915ed2ad816ed4b308a65b6b6961))

## [1.68.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.68.0...v1.68.1) (2026-09-15)


### Bug Fixes

* keep incomplete reviews failed and recoverable (REL-861) ([#801](https://github.com/review-yeti-ai/review-yeti-bot/issues/801)) ([d0ee8f9](https://github.com/review-yeti-ai/review-yeti-bot/commit/d0ee8f938affe379032856dc94c12c33c723d61f))

## [1.68.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.67.0...v1.68.0) (2026-09-14)


### Features

* **gate:** carry the review result on the terminal success and keep it as evidence ([#799](https://github.com/review-yeti-ai/review-yeti-bot/issues/799)) ([11c890e](https://github.com/review-yeti-ai/review-yeti-bot/commit/11c890ebef35b473bf9d73700e3bf009b27c5d95))

## [1.67.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.66.2...v1.67.0) (2026-09-14)


### Features

* **gate:** persist the verified worker completion payload per accepted attempt ([#797](https://github.com/review-yeti-ai/review-yeti-bot/issues/797)) ([c19ea05](https://github.com/review-yeti-ai/review-yeti-bot/commit/c19ea05a92c40daa6315655bb31780d3d2cdffd8))

## [1.66.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.66.1...v1.66.2) (2026-09-14)


### Bug Fixes

* **review:** fail closed on incomplete raw review coverage ([#788](https://github.com/review-yeti-ai/review-yeti-bot/issues/788)) ([82741ca](https://github.com/review-yeti-ai/review-yeti-bot/commit/82741cab65da8d484a9365630c5a3bd97adadf02))

## [1.66.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.66.0...v1.66.1) (2026-09-14)


### Reverts

* **API-3210:** remove cross-org self-review dispatch caller ([#794](https://github.com/review-yeti-ai/review-yeti-bot/issues/794)) ([561cb5a](https://github.com/review-yeti-ai/review-yeti-bot/commit/561cb5a1aad85bcc4de836878245bc458a5c501c))

## [1.66.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.65.1...v1.66.0) (2026-09-14)


### Features

* **gateway:** implement retry resilience, reasoning extraction, and root status route ([#792](https://github.com/review-yeti-ai/review-yeti-bot/issues/792)) ([7716230](https://github.com/review-yeti-ai/review-yeti-bot/commit/77162300512ef8dfc218742a8db9627aff61ed1a))

## [1.65.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.65.0...v1.65.1) (2026-09-14)


### Bug Fixes

* **REL-831:** classify empty provider completions as transient retryables ([#790](https://github.com/review-yeti-ai/review-yeti-bot/issues/790)) ([ae5eb3a](https://github.com/review-yeti-ai/review-yeti-bot/commit/ae5eb3a724ca6daba8e8e5dac92bf7e4ce7514bc))

## [1.65.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.64.0...v1.65.0) (2026-09-14)


### Features

* **review:** add enabled PR transaction boundary ([#787](https://github.com/review-yeti-ai/review-yeti-bot/issues/787)) ([8d793e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/8d793e45fc0634052383f35c4435b2f253cc545c))

## [1.64.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.63.0...v1.64.0) (2026-09-13)


### Features

* add dormant review lifecycle v2 storage ([#785](https://github.com/review-yeti-ai/review-yeti-bot/issues/785)) ([b24bab0](https://github.com/review-yeti-ai/review-yeti-bot/commit/b24bab0f14bea7e729ba03c050b54e0278415e10))

## [1.63.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.62.0...v1.63.0) (2026-09-13)


### Features

* add dormant legacy lifecycle event adapter ([#781](https://github.com/review-yeti-ai/review-yeti-bot/issues/781)) ([055cc0b](https://github.com/review-yeti-ai/review-yeti-bot/commit/055cc0bbc1953078cffc2e460ded6262348bbc7f))

## [1.62.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.61.3...v1.62.0) (2026-09-13)


### Features

* add scoped event gateway auth and PostgreSQL snapshots ([#778](https://github.com/review-yeti-ai/review-yeti-bot/issues/778)) ([752b68f](https://github.com/review-yeti-ai/review-yeti-bot/commit/752b68f431a72140335cb5f4c153ac7beddcfdf7))

## [1.61.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.61.2...v1.61.3) (2026-09-13)


### Bug Fixes

* **worker-helper:** resolve the dispatcher ConfigMap name instead of assuming it ([#779](https://github.com/review-yeti-ai/review-yeti-bot/issues/779)) ([9718cd3](https://github.com/review-yeti-ai/review-yeti-bot/commit/9718cd32386718e7a379e54b4fdced0f8cae60da))

## [1.61.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.61.1...v1.61.2) (2026-09-13)


### Bug Fixes

* **REL-820:** publish terminal gate presentation atomically ([#773](https://github.com/review-yeti-ai/review-yeti-bot/issues/773)) ([9fb7382](https://github.com/review-yeti-ai/review-yeti-bot/commit/9fb7382b08c3be681e138dc11e118114ae754bdd))

## [1.61.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.61.0...v1.61.1) (2026-09-12)


### Bug Fixes

* **events:** reject bare credential authorities ([#774](https://github.com/review-yeti-ai/review-yeti-bot/issues/774)) ([3504b51](https://github.com/review-yeti-ai/review-yeti-bot/commit/3504b518b53ba0b63fa656764302426834b5ddf9))

## [1.61.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.60.2...v1.61.0) (2026-09-12)


### Features

* **events:** publish Review Yeti events to JetStream ([#771](https://github.com/review-yeti-ai/review-yeti-bot/issues/771)) ([8e2bae4](https://github.com/review-yeti-ai/review-yeti-bot/commit/8e2bae4a6cad899c64d5849c37ed09727126354d))

## [1.60.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.60.1...v1.60.2) (2026-09-12)


### Bug Fixes

* **REL-818:** persist legacy worker success ([#768](https://github.com/review-yeti-ai/review-yeti-bot/issues/768)) ([3385b01](https://github.com/review-yeti-ai/review-yeti-bot/commit/3385b01589959f8c8f2b6fb528dd3a47c59a2307))

## [1.60.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.60.0...v1.60.1) (2026-09-12)


### Bug Fixes

* **telemetry:** keep Prometheus counters cumulative (REL-817) ([#766](https://github.com/review-yeti-ai/review-yeti-bot/issues/766)) ([f4ffca4](https://github.com/review-yeti-ai/review-yeti-bot/commit/f4ffca4b58446f86f0037f2281664956352c1d6f))

## [1.60.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.59.3...v1.60.0) (2026-09-12)


### Features

* **config:** support passthrough of skills, knowledge, metrics, and retry analysis ([#757](https://github.com/review-yeti-ai/review-yeti-bot/issues/757)) ([d692b8d](https://github.com/review-yeti-ai/review-yeti-bot/commit/d692b8d18ec9e08c2d4a4eada4c1f12fbbbb52d9))

## [1.59.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.59.2...v1.59.3) (2026-09-12)


### Bug Fixes

* **reaper:** retire the exact audited legacy receipt ([#760](https://github.com/review-yeti-ai/review-yeti-bot/issues/760)) ([c495d65](https://github.com/review-yeti-ai/review-yeti-bot/commit/c495d650afe28edf1a90e15f30cdde128fd52120))

## [1.59.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.59.1...v1.59.2) (2026-09-12)


### Bug Fixes

* **reaper:** release exact legacy receipt selection ([#759](https://github.com/review-yeti-ai/review-yeti-bot/issues/759)) ([10d9497](https://github.com/review-yeti-ai/review-yeti-bot/commit/10d949734808f2e2ec438a824462480196377516))

## [1.59.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.59.0...v1.59.1) (2026-09-12)


### Bug Fixes

* **webhooks:** handle native Review Yeti rerequests ([#753](https://github.com/review-yeti-ai/review-yeti-bot/issues/753)) ([f70894a](https://github.com/review-yeti-ai/review-yeti-bot/commit/f70894a0d138a3978d76cd2bb36b94ea83e05d4d))

## [1.59.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.58.2...v1.59.0) (2026-09-12)


### Features

* **telemetry:** expose dispatcher reaper metrics ([#750](https://github.com/review-yeti-ai/review-yeti-bot/issues/750)) ([dd0c6c0](https://github.com/review-yeti-ai/review-yeti-bot/commit/dd0c6c078b3c48aec096f0d7a2e3781d9b226ae7))

## [1.58.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.58.1...v1.58.2) (2026-09-12)


### Bug Fixes

* **reaper:** retire audited legacy empty-id check ([#751](https://github.com/review-yeti-ai/review-yeti-bot/issues/751)) ([b9eb8d1](https://github.com/review-yeti-ai/review-yeti-bot/commit/b9eb8d1166b37ae52cb2cfce6121095093efb2dc))

## [1.58.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.58.0...v1.58.1) (2026-09-12)


### Bug Fixes

* **reaper:** retire superseded abandoned attempts ([#748](https://github.com/review-yeti-ai/review-yeti-bot/issues/748)) ([939ce6e](https://github.com/review-yeti-ai/review-yeti-bot/commit/939ce6e64aef4bcfd0de38ef58aa7aa1b24ee01a))

## [1.58.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.57.2...v1.58.0) (2026-09-12)


### Features

* **telemetry:** expose OpenTelemetry Prometheus metrics on action dispatch service ([#746](https://github.com/review-yeti-ai/review-yeti-bot/issues/746)) ([71ac940](https://github.com/review-yeti-ai/review-yeti-bot/commit/71ac940e25b7f2a93b38fcbdd76944fc838297c0))

## [1.57.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.57.1...v1.57.2) (2026-09-12)


### Bug Fixes

* **reaper:** expose delivery-mismatch quarantine telemetry and timestamp-fence coverage ([#743](https://github.com/review-yeti-ai/review-yeti-bot/issues/743)) ([c911d8e](https://github.com/review-yeti-ai/review-yeti-bot/commit/c911d8e01f79d1031265c54e097d98dfb4b3d3ac))

## [1.57.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.57.0...v1.57.1) (2026-09-12)


### Bug Fixes

* **reaper:** quarantine mismatched delivery rows [no-linear] ([#740](https://github.com/review-yeti-ai/review-yeti-bot/issues/740)) ([4dd6a6d](https://github.com/review-yeti-ai/review-yeti-bot/commit/4dd6a6dbcff07b2d83bf40450d3be3349ae221d0))

## [1.57.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.11...v1.57.0) (2026-09-12)


### Features

* persist Review Yeti lifecycle outbox ([#717](https://github.com/review-yeti-ai/review-yeti-bot/issues/717)) ([3789c7a](https://github.com/review-yeti-ai/review-yeti-bot/commit/3789c7a115533098f0d9cebc2982f6b52fefd77c))

## [1.56.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.10...v1.56.11) (2026-09-12)


### Bug Fixes

* **reaper:** type epoch lease arithmetic ([#737](https://github.com/review-yeti-ai/review-yeti-bot/issues/737)) ([5373631](https://github.com/review-yeti-ai/review-yeti-bot/commit/5373631e38acea5127bd10f58fb775054060a63f))

## [1.56.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.9...v1.56.10) (2026-09-12)


### Bug Fixes

* **review:** enforce GitHub Check Run title limit ([#735](https://github.com/review-yeti-ai/review-yeti-bot/issues/735)) ([5023b9b](https://github.com/review-yeti-ai/review-yeti-bot/commit/5023b9bba651d344bb404e50bebd885ee0016e5a))

## [1.56.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.8...v1.56.9) (2026-09-12)


### Bug Fixes

* **review:** bound refresh action description ([#733](https://github.com/review-yeti-ai/review-yeti-bot/issues/733)) ([8642b28](https://github.com/review-yeti-ai/review-yeti-bot/commit/8642b28b40726079d3092a08825bab3ae81aadca))

## [1.56.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.7...v1.56.8) (2026-09-11)


### Bug Fixes

* **openrouter:** reject cancellation EOF race ([#730](https://github.com/review-yeti-ai/review-yeti-bot/issues/730)) ([08c3884](https://github.com/review-yeti-ai/review-yeti-bot/commit/08c3884ff0a448801cc1a25d7576908bd4954b32))

## [1.56.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.6...v1.56.7) (2026-09-11)


### Bug Fixes

* **review:** close abandoned recovery contract gaps ([#729](https://github.com/review-yeti-ai/review-yeti-bot/issues/729)) ([72b653b](https://github.com/review-yeti-ai/review-yeti-bot/commit/72b653bdfa187878b064c3f991f54e4fc3ffe324))
* **review:** fail closed abandoned check recovery ([#720](https://github.com/review-yeti-ai/review-yeti-bot/issues/720)) ([1af9548](https://github.com/review-yeti-ai/review-yeti-bot/commit/1af954871fb76cfbde8c4580e1e96b7395fa0942))

## [1.56.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.5...v1.56.6) (2026-09-11)


### Bug Fixes

* doks review reliability, reaper sync, and controller cache lag ([#726](https://github.com/review-yeti-ai/review-yeti-bot/issues/726)) ([d24090d](https://github.com/review-yeti-ai/review-yeti-bot/commit/d24090da829300b158d2c452f99c2ae31c3eb28e))

## [1.56.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.4...v1.56.5) (2026-09-11)


### Bug Fixes

* **REL-814:** double persona turn budget and clarify delivered failure ([#723](https://github.com/review-yeti-ai/review-yeti-bot/issues/723)) ([609b51f](https://github.com/review-yeti-ai/review-yeti-bot/commit/609b51fe3fa63f19f436db6216adc4354d112349))

## [1.56.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.3...v1.56.4) (2026-09-11)


### Bug Fixes

* **operator:** initialize controller-runtime logger ([#722](https://github.com/review-yeti-ai/review-yeti-bot/issues/722)) ([0ae5048](https://github.com/review-yeti-ai/review-yeti-bot/commit/0ae5048ac67b71cbe1f3a3466feb4b27b09bbf9b))

## [1.56.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.2...v1.56.3) (2026-09-11)


### Bug Fixes

* **API-3210:** reconcile durable worker failures immediately ([#718](https://github.com/review-yeti-ai/review-yeti-bot/issues/718)) ([305bf5c](https://github.com/review-yeti-ai/review-yeti-bot/commit/305bf5c3aad1461d54de53c50535fc3f4e383e5c))

## [1.56.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.1...v1.56.2) (2026-09-11)


### Bug Fixes

* **dispatch:** admit exact Review Yeti self-host target ([#716](https://github.com/review-yeti-ai/review-yeti-bot/issues/716)) ([6f08460](https://github.com/review-yeti-ai/review-yeti-bot/commit/6f08460e34656748cf51e3b6a0ab4b8aa0730c9d))

## [1.56.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.56.0...v1.56.1) (2026-09-11)


### Bug Fixes

* **operator:** preserve terminal outcomes and recover failed checks ([#712](https://github.com/review-yeti-ai/review-yeti-bot/issues/712)) ([b7f7222](https://github.com/review-yeti-ai/review-yeti-bot/commit/b7f722218e462c2a87906f85fd9628b807d4a5cd))

## [1.56.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.55.2...v1.56.0) (2026-09-11)


### Features

* **API-3210:** persist Review Yeti recovery diagnostics ([8bfb21b](https://github.com/review-yeti-ai/review-yeti-bot/commit/8bfb21b7b5cc9f846f6208451f07b08f635cb127))

## [1.55.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.55.1...v1.55.2) (2026-09-11)


### Bug Fixes

* **review:** scope generation fence to verified central dispatch ([#708](https://github.com/review-yeti-ai/review-yeti-bot/issues/708)) ([5f9c5cf](https://github.com/review-yeti-ai/review-yeti-bot/commit/5f9c5cf1dd6dba5797d9351cbc1b343ee92cf120))

## [1.55.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.55.0...v1.55.1) (2026-09-11)


### Bug Fixes

* **deploy:** roll dispatcher pods on config changes ([#710](https://github.com/review-yeti-ai/review-yeti-bot/issues/710)) ([f117ffc](https://github.com/review-yeti-ai/review-yeti-bot/commit/f117ffca80687cabd97e0e73e0e6ab52c754751d))

## [1.55.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.54.3...v1.55.0) (2026-09-11)


### Features

* **events:** define Review Yeti event envelope ([#704](https://github.com/review-yeti-ai/review-yeti-bot/issues/704)) ([0f146a9](https://github.com/review-yeti-ai/review-yeti-bot/commit/0f146a97bcd3afbbea6c9cc91392466c9fd7f978))

## [1.54.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.54.2...v1.54.3) (2026-09-11)


### Bug Fixes

* **review:** bind dispatch to durable generation ([#703](https://github.com/review-yeti-ai/review-yeti-bot/issues/703)) ([8d1e46c](https://github.com/review-yeti-ai/review-yeti-bot/commit/8d1e46cd8bb01bcec5f8f849963b071f1b8fceac))

## [1.54.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.54.1...v1.54.2) (2026-09-11)


### Bug Fixes

* **webhook:** ignore irrelevant merge-group actions ([#705](https://github.com/review-yeti-ai/review-yeti-bot/issues/705)) ([3df1b67](https://github.com/review-yeti-ai/review-yeti-bot/commit/3df1b6753ddf13cba16b578e617ab365572eb6f7))

## [1.54.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.54.0...v1.54.1) (2026-09-11)


### Bug Fixes

* **review:** reconcile abandoned runs when checks already exist on head SHA ([#700](https://github.com/review-yeti-ai/review-yeti-bot/issues/700)) ([889d271](https://github.com/review-yeti-ai/review-yeti-bot/commit/889d27111189f2eb407b0ef7e141ca3800daf5fc))

## [1.54.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.53.0...v1.54.0) (2026-09-11)


### Features

* add durable event-driven review CI admission ([#640](https://github.com/review-yeti-ai/review-yeti-bot/issues/640)) ([809a912](https://github.com/review-yeti-ai/review-yeti-bot/commit/809a9121fac96ab4587e2f5ddfc904b5c7813589))

## [1.53.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.9...v1.53.0) (2026-09-11)


### Features

* **operator:** switch prebaked review workers to ephemeral emptyDir workspace ([#697](https://github.com/review-yeti-ai/review-yeti-bot/issues/697)) ([13661bc](https://github.com/review-yeti-ai/review-yeti-bot/commit/13661bcc9e5ec73285d505d2e7e23419e0658b5e))

## [1.52.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.8...v1.52.9) (2026-09-11)


### Bug Fixes

* **memory:** preserve UUID entropy for learning IDs ([7326617](https://github.com/review-yeti-ai/review-yeti-bot/commit/732661797c370cb75788b68e74f8e23dd63af0f3))
* **panel:** retry malformed structured output once ([3c0b4bb](https://github.com/review-yeti-ai/review-yeti-bot/commit/3c0b4bba2f6ac3154537d40ab4d5644393dc6903))
* **panel:** retry malformed structured output once ([0944e34](https://github.com/review-yeti-ai/review-yeti-bot/commit/0944e34397b7fb880a4c49888b3bce8930dea5b5))

## [1.52.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.7...v1.52.8) (2026-09-11)


### Bug Fixes

* **review:** classify native output failures ([#691](https://github.com/review-yeti-ai/review-yeti-bot/issues/691)) ([f244d4c](https://github.com/review-yeti-ai/review-yeti-bot/commit/f244d4ce6a17b6a442c5dd0a9578e1ad4ace5ed0))

## [1.52.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.6...v1.52.7) (2026-09-11)


### Bug Fixes

* **review:** separate bounded native exploration and finalization ([#690](https://github.com/review-yeti-ai/review-yeti-bot/issues/690)) ([9e4b24b](https://github.com/review-yeti-ai/review-yeti-bot/commit/9e4b24b1c1ee21392e7e5fabb30ee05f0112a3f9))

## [1.52.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.5...v1.52.6) (2026-09-11)


### Bug Fixes

* **API-3215:** accept bounded fenced JSON responses ([8400702](https://github.com/review-yeti-ai/review-yeti-bot/commit/8400702318635c48007af4a0e2af9893b52415d1))
* **review:** accept bounded fenced JSON responses ([4574b38](https://github.com/review-yeti-ai/review-yeti-bot/commit/4574b38ac422a9029778c0f37ba0dde5c3d77c5f))

## [1.52.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.4...v1.52.5) (2026-09-11)


### Bug Fixes

* **review:** enforce streaming deadlines and fair worker admission ([#680](https://github.com/review-yeti-ai/review-yeti-bot/issues/680)) ([cef7c64](https://github.com/review-yeti-ai/review-yeti-bot/commit/cef7c645b4acb0451082e000ff062ab990b903da))

## [1.52.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.3...v1.52.4) (2026-09-11)


### Bug Fixes

* **API-3215:** recover strict app-gate output ([#682](https://github.com/review-yeti-ai/review-yeti-bot/issues/682)) ([f26e8f1](https://github.com/review-yeti-ai/review-yeti-bot/commit/f26e8f1854ff3eb10bfca1867713ac3386696ccd))

## [1.52.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.2...v1.52.3) (2026-09-10)


### Bug Fixes

* **dispatch:** prioritize active expiry recovery ([73c7a79](https://github.com/review-yeti-ai/review-yeti-bot/commit/73c7a7935000cd56667730547801be6d1dce06ca))
* **dispatch:** prioritize active expiry recovery ([8799385](https://github.com/review-yeti-ai/review-yeti-bot/commit/8799385e7622876ce589f3667c46b6375480dbf9))

## [1.52.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.1...v1.52.2) (2026-09-10)


### Bug Fixes

* **operator:** preserve FIFO after stale job removal ([8be9ddd](https://github.com/review-yeti-ai/review-yeti-bot/commit/8be9ddd53b3266850298e4797a07bd63c4553723))
* **operator:** preserve FIFO after stale job removal ([d64dc37](https://github.com/review-yeti-ai/review-yeti-bot/commit/d64dc37ac32bcf625412dffb8a087e1e8c504b60))

## [1.52.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.52.0...v1.52.1) (2026-09-10)


### Bug Fixes

* **API-3215:** accept current GitHub App tokens ([#673](https://github.com/review-yeti-ai/review-yeti-bot/issues/673)) ([2666237](https://github.com/review-yeti-ai/review-yeti-bot/commit/26662374c165d1dac038d8727f76eea446e31997))
* **API-3215:** remove duplicate panel helpers ([#676](https://github.com/review-yeti-ai/review-yeti-bot/issues/676)) ([4a2cea8](https://github.com/review-yeti-ai/review-yeti-bot/commit/4a2cea8a1e95f1097c80e8b614fd1eb2d9316d4d))
* **panel:** 5 turns, 3 min idle, drop 90s/150s hard stops ([#674](https://github.com/review-yeti-ai/review-yeti-bot/issues/674)) ([af02db3](https://github.com/review-yeti-ai/review-yeti-bot/commit/af02db3146ee11d449a76fce2e25f72ec7ab2b95))

## [1.52.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.51.2...v1.52.0) (2026-09-10)


### Features

* **panel:** skip file diffs larger than max-file-diff-chars (512KiB) ([#671](https://github.com/review-yeti-ai/review-yeti-bot/issues/671)) ([268da6f](https://github.com/review-yeti-ai/review-yeti-bot/commit/268da6f1c9fa1c4e97462598dc6223a88b91cf50))

## [1.51.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.51.1...v1.51.2) (2026-09-10)


### Bug Fixes

* **panel:** do not inline PR diffs; agents explore by SHA ([#669](https://github.com/review-yeti-ai/review-yeti-bot/issues/669)) ([cdcdb2d](https://github.com/review-yeti-ai/review-yeti-bot/commit/cdcdb2df647718ae388d8aaf0013325a1e7b46c8))

## [1.51.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.51.0...v1.51.1) (2026-09-10)


### Bug Fixes

* **API-3215:** publish one visible Review Yeti check ([bcc4f58](https://github.com/review-yeti-ai/review-yeti-bot/commit/bcc4f58e4a5a3b79e09451c9f5c2e9fb0d30a1bd))

## [1.51.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.50.1...v1.51.0) (2026-09-10)


### Features

* **api:** admit native GitHub App review events [API-3210] ([#663](https://github.com/review-yeti-ai/review-yeti-bot/issues/663)) ([28969f7](https://github.com/review-yeti-ai/review-yeti-bot/commit/28969f71c0064b082b8178c40fd34dd8e34b3399))

## [1.50.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.50.0...v1.50.1) (2026-09-10)


### Bug Fixes

* **release:** make quality gate deterministic [REL-705] ([#661](https://github.com/review-yeti-ai/review-yeti-bot/issues/661)) ([b26fe62](https://github.com/review-yeti-ai/review-yeti-bot/commit/b26fe6248ce866b6e611878f50420663cfaa7d8b))

## [1.50.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.49.1...v1.50.0) (2026-09-10)


### Features

* **engine:** scope persona paths to ecosystems, stage domains runtime, and compact prompt diffs ([#659](https://github.com/review-yeti-ai/review-yeti-bot/issues/659)) ([83efeff](https://github.com/review-yeti-ai/review-yeti-bot/commit/83efeff3c77eaa5c37b1769a9b456382b8f6d9e1))

## [1.49.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.49.0...v1.49.1) (2026-09-10)


### Bug Fixes

* **action:** retry transient DOKS dispatch failures ([#657](https://github.com/review-yeti-ai/review-yeti-bot/issues/657)) ([efcdf84](https://github.com/review-yeti-ai/review-yeti-bot/commit/efcdf841b85755bf1fe73ec5a4d955349bf21249))

## [1.49.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.5...v1.49.0) (2026-09-10)


### Features

* **panel:** eliminate 3s warmup delay and activate ecosystem-based persona path routing ([#637](https://github.com/review-yeti-ai/review-yeti-bot/issues/637)) ([a35ab32](https://github.com/review-yeti-ai/review-yeti-bot/commit/a35ab32821939a55190844b029519e65880a91ae))

## [1.48.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.4...v1.48.5) (2026-09-10)


### Bug Fixes

* **operator:** queue while prior workspace terminates ([#653](https://github.com/review-yeti-ai/review-yeti-bot/issues/653)) ([b81b039](https://github.com/review-yeti-ai/review-yeti-bot/commit/b81b03973b6e17f0f55d15837d4df04eb2f12fe2))

## [1.48.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.3...v1.48.4) (2026-09-10)


### Bug Fixes

* **deploy:** guard Flux-owned worker advances ([#651](https://github.com/review-yeti-ai/review-yeti-bot/issues/651)) ([d5346d1](https://github.com/review-yeti-ai/review-yeti-bot/commit/d5346d1c4e1e8ed57236419fd31259f1678e2e4d))

## [1.48.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.2...v1.48.3) (2026-09-10)


### Bug Fixes

* **review:** preserve findings from malformed approvals ([#649](https://github.com/review-yeti-ai/review-yeti-bot/issues/649)) ([b7c5d33](https://github.com/review-yeti-ai/review-yeti-bot/commit/b7c5d33e4659e0934a8bea68ad984e34fe2fa436))

## [1.48.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.1...v1.48.2) (2026-09-10)


### Bug Fixes

* **review:** classify wrapped provider failures ([#647](https://github.com/review-yeti-ai/review-yeti-bot/issues/647)) ([95bbab1](https://github.com/review-yeti-ai/review-yeti-bot/commit/95bbab1ac9eebd2f35aefcfbf61846fbe34167ab))

## [1.48.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.48.0...v1.48.1) (2026-09-10)


### Bug Fixes

* guard worker upgrades with exact-state receipts ([#645](https://github.com/review-yeti-ai/review-yeti-bot/issues/645)) ([8a01f4c](https://github.com/review-yeti-ai/review-yeti-bot/commit/8a01f4c653eb61fb7f3e77d00158e9b11eadf2ba))

## [1.48.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.47.1...v1.48.0) (2026-09-10)


### Features

* **security:** add rate limiting and harden hmac signature verification ([#642](https://github.com/review-yeti-ai/review-yeti-bot/issues/642)) ([0ca45f6](https://github.com/review-yeti-ai/review-yeti-bot/commit/0ca45f6b6c6cecb9804066c9f42cea6fcfe24f8c))

## [1.47.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.47.0...v1.47.1) (2026-09-09)


### Bug Fixes

* **review:** recover abandoned attempts without replaying workers ([#638](https://github.com/review-yeti-ai/review-yeti-bot/issues/638)) ([ecd789d](https://github.com/review-yeti-ai/review-yeti-bot/commit/ecd789d5836968b1903a81a6333d7d39b947f982))

## [1.47.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.46.0...v1.47.0) (2026-09-09)


### Features

* add opt-in service-owned review gates ([#635](https://github.com/review-yeti-ai/review-yeti-bot/issues/635)) ([1a7f237](https://github.com/review-yeti-ai/review-yeti-bot/commit/1a7f2370d296b41296ee73e41cf25dc40cdccb23))

## [1.46.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.7...v1.46.0) (2026-09-09)


### Features

* **dispatch:** make the terminal review deadline configurable, default 30 minutes (REL-733) ([#634](https://github.com/review-yeti-ai/review-yeti-bot/issues/634)) ([6e7725a](https://github.com/review-yeti-ai/review-yeti-bot/commit/6e7725ab0a8d30753df5619af0e1289b933f77f7))

## [1.45.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.6...v1.45.7) (2026-09-09)


### Bug Fixes

* **REL-732:** GC Review Yeti worker Jobs immediately after finish ([#632](https://github.com/review-yeti-ai/review-yeti-bot/issues/632)) ([4048f8a](https://github.com/review-yeti-ai/review-yeti-bot/commit/4048f8a79d40680e1d81525df52a6775c36a1ed3))

## [1.45.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.5...v1.45.6) (2026-09-09)


### Bug Fixes

* persist worker failures with attempt-bound recovery ([#629](https://github.com/review-yeti-ai/review-yeti-bot/issues/629)) ([ddab4bc](https://github.com/review-yeti-ai/review-yeti-bot/commit/ddab4bcfe0d1b78e3c863dd8323a2c87adc4d3b4))

## [1.45.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.4...v1.45.5) (2026-09-09)


### Bug Fixes

* **dispatch:** retry failed review executions on same head ([#622](https://github.com/review-yeti-ai/review-yeti-bot/issues/622)) ([3de6db5](https://github.com/review-yeti-ai/review-yeti-bot/commit/3de6db5d4d70ac18466c271697326d3d8ddab293))

## [1.45.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.3...v1.45.4) (2026-09-09)


### Bug Fixes

* **deploy:** a dispatcher redeploy must not scale production to zero ([#623](https://github.com/review-yeti-ai/review-yeti-bot/issues/623)) ([0337a94](https://github.com/review-yeti-ai/review-yeti-bot/commit/0337a942abdfe3765683669392072b1762b06f6e))

## [1.45.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.2...v1.45.3) (2026-09-09)


### Bug Fixes

* **scripts:** make the shell scripts run on bash 3.2 [no-linear] ([#620](https://github.com/review-yeti-ai/review-yeti-bot/issues/620)) ([fb5d2a8](https://github.com/review-yeti-ai/review-yeti-bot/commit/fb5d2a8daf5f71ab827bbc028c774ccf3f7812e6))

## [1.45.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.1...v1.45.2) (2026-09-09)


### Bug Fixes

* **REL-543:** verify installation-token publisher identity before writing ([#613](https://github.com/review-yeti-ai/review-yeti-bot/issues/613)) ([761e3ef](https://github.com/review-yeti-ai/review-yeti-bot/commit/761e3ef0fa86bae51c369e5daf2a71518bc89ba1))

## [1.45.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.45.0...v1.45.1) (2026-09-09)


### Bug Fixes

* **reaper:** publish a title the consumer shims can retry [no-linear] ([#616](https://github.com/review-yeti-ai/review-yeti-bot/issues/616)) ([325b12b](https://github.com/review-yeti-ai/review-yeti-bot/commit/325b12b48d586c9318285a23e19b461228a9a0d8))

## [1.45.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.44.3...v1.45.0) (2026-09-09)


### Features

* **panel:** configurable max file size, fast-ship security guards, and prompt caching telemetry ([#612](https://github.com/review-yeti-ai/review-yeti-bot/issues/612)) ([7ad94b8](https://github.com/review-yeti-ai/review-yeti-bot/commit/7ad94b8ebf305dfa1e5ef670db855386e2570332))

## [1.44.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.44.2...v1.44.3) (2026-09-09)


### Bug Fixes

* **dispatch:** the abandoned-run reaper wrote to a column that does not exist ([#610](https://github.com/review-yeti-ai/review-yeti-bot/issues/610)) ([a336193](https://github.com/review-yeti-ai/review-yeti-bot/commit/a33619389bedcb437c8b5f1383922678e7ea6dbb))

## [1.44.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.44.1...v1.44.2) (2026-09-09)


### Bug Fixes

* **dispatch:** a terminally failed run must be retryable on the same head ([#608](https://github.com/review-yeti-ai/review-yeti-bot/issues/608)) ([1ff29e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/1ff29e490610971c96b7b1c531e11d4a23a5e4bf))

## [1.44.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.44.0...v1.44.1) (2026-09-09)


### Bug Fixes

* **ops:** reclaim manifest ownership even when the digest already matches ([#606](https://github.com/review-yeti-ai/review-yeti-bot/issues/606)) ([067802a](https://github.com/review-yeti-ai/review-yeti-bot/commit/067802a1c8cc9d532f612b35d4f6f383a0f5af3f))

## [1.44.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.43.1...v1.44.0) (2026-09-09)


### Features

* **ops:** advance the production worker digest through the manifest, not a hand patch ([#604](https://github.com/review-yeti-ai/review-yeti-bot/issues/604)) ([1d9c164](https://github.com/review-yeti-ai/review-yeti-bot/commit/1d9c164c0fe460587511900fe78e5a8472058d48))

## [1.43.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.43.0...v1.43.1) (2026-09-09)


### Bug Fixes

* **hosted:** resolve repository visibility with the run's own token ([#602](https://github.com/review-yeti-ai/review-yeti-bot/issues/602)) ([94aadae](https://github.com/review-yeti-ai/review-yeti-bot/commit/94aadae737e37a31b46d549923a71b51326b628e))

## [1.43.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.42.4...v1.43.0) (2026-09-09)


### Features

* **review:** implement 5-phase Review Yeti remediation and Zoekt evidence tools ([#598](https://github.com/review-yeti-ai/review-yeti-bot/issues/598)) ([50692f5](https://github.com/review-yeti-ai/review-yeti-bot/commit/50692f5e89245244c43c80728681bf5a83319609))


### Bug Fixes

* **ci:** fix CtReviewConfigV3 evidence optionality and panelEngine typecheck ([#600](https://github.com/review-yeti-ai/review-yeti-bot/issues/600)) ([53c0fa0](https://github.com/review-yeti-ai/review-yeti-bot/commit/53c0fa0055184b697401b3f31ba902a8dce98c44))

## [1.42.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.42.3...v1.42.4) (2026-09-08)


### Performance

* **panel:** optimize prompt caching, scope persona paths, and add pre-flight triage classifier ([#593](https://github.com/review-yeti-ai/review-yeti-bot/issues/593)) ([ca41a3f](https://github.com/review-yeti-ai/review-yeti-bot/commit/ca41a3fb391524c4b8ed57d8a2aac8d9d21013e3))

## [1.42.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.42.2...v1.42.3) (2026-09-08)


### Bug Fixes

* **review:** give the panel repository visibility instead of letting it guess ([#594](https://github.com/review-yeti-ai/review-yeti-bot/issues/594)) ([698dac0](https://github.com/review-yeti-ai/review-yeti-bot/commit/698dac04af6da01e689d3431c62ece9657266d3a))

## [1.42.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.42.1...v1.42.2) (2026-09-08)


### Bug Fixes

* **panel:** give persona find_files/read_file real repository scope ([#590](https://github.com/review-yeti-ai/review-yeti-bot/issues/590)) ([c60bbcf](https://github.com/review-yeti-ai/review-yeti-bot/commit/c60bbcf4ae3cbcc59357bca5062cfd97f4d9bc7f))

## [1.42.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.42.0...v1.42.1) (2026-09-08)


### Bug Fixes

* **review:** downgrade blocking findings that hedge their own premise ([#589](https://github.com/review-yeti-ai/review-yeti-bot/issues/589)) ([c1c7449](https://github.com/review-yeti-ai/review-yeti-bot/commit/c1c7449db0a1bedd2ca753af481fb6b03d1ac8f9))

## [1.42.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.6...v1.42.0) (2026-09-08)


### Features

* publish inline findings with one sticky review overview ([#584](https://github.com/review-yeti-ai/review-yeti-bot/issues/584)) ([192b0f1](https://github.com/review-yeti-ai/review-yeti-bot/commit/192b0f1b569a22c8619e7d389f5e6a7ca769a2b0))

## [1.41.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.5...v1.41.6) (2026-09-08)


### Bug Fixes

* **review:** cluster paraphrased findings and calibrate advisory P1s ([#585](https://github.com/review-yeti-ai/review-yeti-bot/issues/585)) ([28ebd03](https://github.com/review-yeti-ai/review-yeti-bot/commit/28ebd03cc7cc4fc146d02dae2870cacdc0f54d2b))

## [1.41.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.4...v1.41.5) (2026-09-08)


### Bug Fixes

* **publishing:** read diff paths that contain spaces, and stop dropping files silently ([#582](https://github.com/review-yeti-ai/review-yeti-bot/issues/582)) ([24a3a88](https://github.com/review-yeti-ai/review-yeti-bot/commit/24a3a88ed2c62342f18db3578a9160cff01efaae))

## [1.41.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.3...v1.41.4) (2026-09-08)


### Bug Fixes

* **publishing:** repair the diff parser, the blocking count, and publish findings ([#580](https://github.com/review-yeti-ai/review-yeti-bot/issues/580)) ([95831d2](https://github.com/review-yeti-ai/review-yeti-bot/commit/95831d26c2f5f06fe5ae45fc84fdc36a7e192a36))

## [1.41.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.2...v1.41.3) (2026-09-07)


### Bug Fixes

* **doks:** enforce canonical advisory severity policy ([#576](https://github.com/review-yeti-ai/review-yeti-bot/issues/576)) ([efb4d7c](https://github.com/review-yeti-ai/review-yeti-bot/commit/efb4d7c5f388216220c0f3c80e1d1e6e11ce8677))

## [1.41.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.1...v1.41.2) (2026-09-07)


### Bug Fixes

* **doks:** bind publishing panel to Bifrost model ([#574](https://github.com/review-yeti-ai/review-yeti-bot/issues/574)) ([542083f](https://github.com/review-yeti-ai/review-yeti-bot/commit/542083f14e9e5e4c271b176f13c11de19f0319d9))

## [1.41.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.41.0...v1.41.1) (2026-09-07)


### Bug Fixes

* **publishing:** pass the full owner/repo to the qualification loader ([#572](https://github.com/review-yeti-ai/review-yeti-bot/issues/572)) ([44d5da1](https://github.com/review-yeti-ai/review-yeti-bot/commit/44d5da1e1f03c4732c354e61747e4a8757358252))

## [1.41.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.40.1...v1.41.0) (2026-09-07)


### Features

* **mcp:** generic stdio MCP tool execution and downstream impact analysis integration ([#568](https://github.com/review-yeti-ai/review-yeti-bot/issues/568)) ([b8eaa57](https://github.com/review-yeti-ai/review-yeti-bot/commit/b8eaa57cfba94b85964f4ce6f43746c976b232da))

## [1.40.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.40.0...v1.40.1) (2026-09-07)


### Bug Fixes

* **operator:** name which setting rejected an app-gate Job, and stop defaulting admission ([#567](https://github.com/review-yeti-ai/review-yeti-bot/issues/567)) ([8f9f33e](https://github.com/review-yeti-ai/review-yeti-bot/commit/8f9f33eb1ecdbb85dfda80ec0dbebaf5be9e5c2c))

## [1.40.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.39.3...v1.40.0) (2026-09-07)


### Features

* **review:** P2 findings no longer gate a merge ([#563](https://github.com/review-yeti-ai/review-yeti-bot/issues/563)) ([eb6d529](https://github.com/review-yeti-ai/review-yeti-bot/commit/eb6d52959b65e865742b9f225900c8db07f65a65))

## [1.39.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.39.2...v1.39.3) (2026-09-07)


### Bug Fixes

* **deploy:** allow opt-in --force-conflicts so a hand-patched field cannot wedge deploys ([#560](https://github.com/review-yeti-ai/review-yeti-bot/issues/560)) ([45ef6b5](https://github.com/review-yeti-ai/review-yeti-bot/commit/45ef6b5ed2d1de269716ea26c05141252ef1c9c2))
* **publishing:** accept the metadata grant GitHub attaches to every installation token ([#561](https://github.com/review-yeti-ai/review-yeti-bot/issues/561)) ([5d15da4](https://github.com/review-yeti-ai/review-yeti-bot/commit/5d15da443140b3d5b7ef33fd0725a9c00f673ae7))

## [1.39.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.39.1...v1.39.2) (2026-09-07)


### Bug Fixes

* **action:** a publication failure must not discard a computed verdict ([#557](https://github.com/review-yeti-ai/review-yeti-bot/issues/557)) ([30093b5](https://github.com/review-yeti-ai/review-yeti-bot/commit/30093b5344c8d23301543f397c7677e2b8be0bc4))
* **tests:** make the suite build its own prerequisites ([#556](https://github.com/review-yeti-ai/review-yeti-bot/issues/556)) ([d6992e4](https://github.com/review-yeti-ai/review-yeti-bot/commit/d6992e4ad97aa100802be5fbeba23ddd4041ba59))

## [1.39.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.39.0...v1.39.1) (2026-09-07)


### Bug Fixes

* **action:** do not enforce review-publisher identity against an assumption ([#553](https://github.com/review-yeti-ai/review-yeti-bot/issues/553)) ([ceb323f](https://github.com/review-yeti-ai/review-yeti-bot/commit/ceb323fcfce397dd522db54b0cdbe388ca0a8e42))

## [1.39.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.6...v1.39.0) (2026-09-07)


### Features

* **dispatch:** let the job dispatcher mint per-run publish credentials (REL-586) ([#551](https://github.com/review-yeti-ai/review-yeti-bot/issues/551)) ([e5a34f2](https://github.com/review-yeti-ai/review-yeti-bot/commit/e5a34f229ee085315eb97a9278c57c67de01c18d))

## [1.38.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.5...v1.38.6) (2026-09-07)


### Bug Fixes

* **publish:** keep the sticky comment small, and close conversations whose code is gone ([#548](https://github.com/review-yeti-ai/review-yeti-bot/issues/548)) ([64e01a9](https://github.com/review-yeti-ai/review-yeti-bot/commit/64e01a984014d6933593519c438cc1314c9cce0f))

## [1.38.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.4...v1.38.5) (2026-09-06)


### Bug Fixes

* **action:** restore sticky summary comment and resolvable inline review threads ([#546](https://github.com/review-yeti-ai/review-yeti-bot/issues/546)) ([2695a1f](https://github.com/review-yeti-ai/review-yeti-bot/commit/2695a1ffc817022c6c8545463bd10b92c649ef9a))

## [1.38.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.3...v1.38.4) (2026-09-06)


### Bug Fixes

* **dispatch:** close the silent-block hole and drop the default-SA escalation (REL-586) ([#541](https://github.com/review-yeti-ai/review-yeti-bot/issues/541)) ([636f4f5](https://github.com/review-yeti-ai/review-yeti-bot/commit/636f4f5d13e2ea70b7c1086631807042f890138f))

## [1.38.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.2...v1.38.3) (2026-09-06)


### Bug Fixes

* **operator:** make the app-gate lane actually runnable (REL-586) ([#538](https://github.com/review-yeti-ai/review-yeti-bot/issues/538)) ([28e7de4](https://github.com/review-yeti-ai/review-yeti-bot/commit/28e7de49957d474bbd6772186a58e668b71392fc))

## [1.38.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.1...v1.38.2) (2026-09-06)


### Reverts

* **chart:** remove duplicated job-dispatcher resources (REL-586) ([#535](https://github.com/review-yeti-ai/review-yeti-bot/issues/535)) ([46ac2f0](https://github.com/review-yeti-ai/review-yeti-bot/commit/46ac2f054758a856039f761770153c21593c4dd8))

## [1.38.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.38.0...v1.38.1) (2026-09-06)


### Bug Fixes

* **review:** derive active model in PR comment header and default to GLM-5.3-Flash ([#531](https://github.com/review-yeti-ai/review-yeti-bot/issues/531)) ([e938967](https://github.com/review-yeti-ai/review-yeti-bot/commit/e93896791277d1375cfcf315c2a45ad445fd7823))

## [1.38.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.37.0...v1.38.0) (2026-09-06)


### Features

* **dispatch:** provision per-run publish secrets from the installed App (REL-586) ([#530](https://github.com/review-yeti-ai/review-yeti-bot/issues/530)) ([5a1a5ea](https://github.com/review-yeti-ai/review-yeti-bot/commit/5a1a5ea878ac9c89f6d92238deecf6444dae6498))

## [1.37.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.36.0...v1.37.0) (2026-09-06)


### Features

* **dispatch:** mint the publish token from the installed App (REL-586) ([#528](https://github.com/review-yeti-ai/review-yeti-bot/issues/528)) ([d242730](https://github.com/review-yeti-ai/review-yeti-bot/commit/d242730254813568b6b5c7fa2b369f0007405f9c))

## [1.36.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.35.0...v1.36.0) (2026-09-06)


### Features

* **operator:** supply the app-gate transport config from deployment env (REL-586) ([#524](https://github.com/review-yeti-ai/review-yeti-bot/issues/524)) ([cdc9473](https://github.com/review-yeti-ai/review-yeti-bot/commit/cdc947363d8b2a857a9f23523a17a8bd76664a12))

## [1.35.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.34.1...v1.35.0) (2026-09-06)


### Features

* **operator:** admit the app-gate publishing lane with a scoped token (REL-586) ([#522](https://github.com/review-yeti-ai/review-yeti-bot/issues/522)) ([a88085d](https://github.com/review-yeti-ai/review-yeti-bot/commit/a88085d73698e1dbfa5f0f187f933540dae21c7a))

## [1.34.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.34.0...v1.34.1) (2026-09-06)


### Bug Fixes

* **worker:** resolve the publishing lane's installation from App creds, not env (REL-586) ([#520](https://github.com/review-yeti-ai/review-yeti-bot/issues/520)) ([465f3a6](https://github.com/review-yeti-ai/review-yeti-bot/commit/465f3a60cae1bc61290856a32e5cba50a33c19b8))

## [1.34.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.33.0...v1.34.0) (2026-09-06)


### Features

* **worker:** add the fail-closed Bifrost publishing lane (REL-586) ([#518](https://github.com/review-yeti-ai/review-yeti-bot/issues/518)) ([6aa4b2e](https://github.com/review-yeti-ai/review-yeti-bot/commit/6aa4b2ed2564ba3402312e163e4e09f3bce9606e))

## [1.33.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.32.3...v1.33.0) (2026-09-06)


### Features

* **chart:** project the Bifrost gateway credential via the Doppler operator (REL-586) ([#516](https://github.com/review-yeti-ai/review-yeti-bot/issues/516)) ([9d0e8a2](https://github.com/review-yeti-ai/review-yeti-bot/commit/9d0e8a2f4e4663c33676cbb2757b8d352c462046))

## [1.32.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.32.2...v1.32.3) (2026-09-05)


### Bug Fixes

* **incremental-review:** harden carry-forward trust and close coverage gaps (REL-586) ([#514](https://github.com/review-yeti-ai/review-yeti-bot/issues/514)) ([1b791e2](https://github.com/review-yeti-ai/review-yeti-bot/commit/1b791e22b061873c80e156abb8c1f988b1316afd))

## [1.32.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.32.1...v1.32.2) (2026-09-05)


### Bug Fixes

* **ci:** refuse a SKIPPED check only when it is required (REL-586) ([#513](https://github.com/review-yeti-ai/review-yeti-bot/issues/513)) ([b714645](https://github.com/review-yeti-ai/review-yeti-bot/commit/b71464522ebca52522c48732bef8dd8a02cf5618))
* **github:** rename App check run to Review Yeti so it completes the central lane's stuck check (REL-586) ([#512](https://github.com/review-yeti-ai/review-yeti-bot/issues/512)) ([c42d1f8](https://github.com/review-yeti-ai/review-yeti-bot/commit/c42d1f86d329a3e14ee583ea83345adec8ed6d20))
* **review-bot:** harden verdict gate on coverage signals, drop misplaced P2 block (REL-585) ([#510](https://github.com/review-yeti-ai/review-yeti-bot/issues/510)) ([d21e2c5](https://github.com/review-yeti-ai/review-yeti-bot/commit/d21e2c50b1be1aff38e503d444a9848cf113731c))

## [1.32.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.32.0...v1.32.1) (2026-09-05)


### Bug Fixes

* **types:** give PanelFinding.fixOptions its real element type (REL-583) ([#507](https://github.com/review-yeti-ai/review-yeti-bot/issues/507)) ([8ca73c7](https://github.com/review-yeti-ai/review-yeti-bot/commit/8ca73c749efb314a7f546d74a55178d585d44971))

## [1.32.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.31.1...v1.32.0) (2026-09-05)


### Features

* **memory:** support cross-peer recall, domain scoping, lifecycle invalidation, and remember/forget commands ([77f1543](https://github.com/review-yeti-ai/review-yeti-bot/commit/77f1543bd5d91c5354469555fb4913aeca597970))

## [1.31.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.31.0...v1.31.1) (2026-09-05)


### Bug Fixes

* **memory:** align Honcho peer/session payload keys and query array deserialization ([f8594a2](https://github.com/review-yeti-ai/review-yeti-bot/commit/f8594a23aeadf72257a3dd12fbadfe27fd944c9e))

## [1.31.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.30.0...v1.31.0) (2026-09-05)


### Features

* **memory:** implement pluggable memory adapter pattern with Honcho support and documentation ([bcbee79](https://github.com/review-yeti-ai/review-yeti-bot/commit/bcbee79e347a1869ef1bac8ea36dfd6dff2486ae))

## [1.30.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.11...v1.30.0) (2026-09-05)


### Features

* complete developer delight superpowers, community personas, team memory, and docs overhaul ([2df28bb](https://github.com/review-yeti-ai/review-yeti-bot/commit/2df28bb4f8200b76305725c218182b22f57042ba))
* complete developer delight superpowers, community personas, team memory, and docs overhaul ([efef2b9](https://github.com/review-yeti-ai/review-yeti-bot/commit/efef2b9b047fa13449389ecc15cead2523ddd613))


### Bug Fixes

* **types:** align test fixtures and comment publisher signatures with main ([9e59273](https://github.com/review-yeti-ai/review-yeti-bot/commit/9e592739b456a5dd7303afe3d453114e59baf50d))

## [1.29.11](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.10...v1.29.11) (2026-09-05)


### Bug Fixes

* **types:** drop inert per-item identity fields from inline comment requests (REL-573) ([#495](https://github.com/review-yeti-ai/review-yeti-bot/issues/495)) ([eed40de](https://github.com/review-yeti-ai/review-yeti-bot/commit/eed40deba47d10cd8eeadb9234e598a60ccd5dc7))

## [1.29.10](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.9...v1.29.10) (2026-09-05)


### Bug Fixes

* **types:** break the types/live &lt;-&gt; liveStreamBus import cycle (REL-573) ([#493](https://github.com/review-yeti-ai/review-yeti-bot/issues/493)) ([ee5434f](https://github.com/review-yeti-ai/review-yeti-bot/commit/ee5434f289da2af6e2b4907cde1743c48208300e))

## [1.29.9](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.8...v1.29.9) (2026-09-05)


### Bug Fixes

* **live:** drive personaProgress from job:queued/dispatched events (REL-573) ([#491](https://github.com/review-yeti-ai/review-yeti-bot/issues/491)) ([876585c](https://github.com/review-yeti-ai/review-yeti-bot/commit/876585c32c82cfe82812bb25634681d6670b83a0))
* **types:** consolidate duplicated LiveJobSummary and LiveStreamEventData (REL-573) ([#490](https://github.com/review-yeti-ai/review-yeti-bot/issues/490)) ([2cb7b35](https://github.com/review-yeti-ai/review-yeti-bot/commit/2cb7b35b1ffaf3ea90457791b80d8eb296f38346))

## [1.29.8](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.7...v1.29.8) (2026-09-04)


### Bug Fixes

* **types:** rename evaluation harness PersonaFinding to HarnessPersonaFinding (REL-573) ([#488](https://github.com/review-yeti-ai/review-yeti-bot/issues/488)) ([28156b2](https://github.com/review-yeti-ai/review-yeti-bot/commit/28156b2e1fcc012d52e64a7a4c94d672f251065b))

## [1.29.7](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.6...v1.29.7) (2026-09-04)


### Bug Fixes

* **types:** tighten evaluation/config/dashboard product types (REL-573) ([#486](https://github.com/review-yeti-ai/review-yeti-bot/issues/486)) ([f80c127](https://github.com/review-yeti-ai/review-yeti-bot/commit/f80c127d95a948e4a6410c95fae6a08036650759))

## [1.29.6](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.5...v1.29.6) (2026-09-04)


### Bug Fixes

* **types:** consolidate duplicated ProviderConfigRecord and PersonaSetting (REL-573) ([#484](https://github.com/review-yeti-ai/review-yeti-bot/issues/484)) ([b39acc8](https://github.com/review-yeti-ai/review-yeti-bot/commit/b39acc8a24009f1884e426fea1061bb26c23fbe1))

## [1.29.5](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.4...v1.29.5) (2026-09-04)


### Bug Fixes

* **types:** typecheck scripts, repair a dead script import, drop the AbortSignal casts (REL-573) ([#481](https://github.com/review-yeti-ai/review-yeti-bot/issues/481)) ([e1bbe30](https://github.com/review-yeti-ai/review-yeti-bot/commit/e1bbe3028d1c3c05de580367c3e404a623819025))

## [1.29.4](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.3...v1.29.4) (2026-09-04)


### Bug Fixes

* **types:** typecheck tests instead of excluding them (REL-570) ([#479](https://github.com/review-yeti-ai/review-yeti-bot/issues/479)) ([c9028b7](https://github.com/review-yeti-ai/review-yeti-bot/commit/c9028b714d4e5274d40f7c3364df5d8cc61dbfba))

## [1.29.3](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.2...v1.29.3) (2026-09-04)


### Bug Fixes

* **test:** resolve tsc strict-mode errors in W1 test files (REL-570) ([#474](https://github.com/review-yeti-ai/review-yeti-bot/issues/474)) ([2efde5d](https://github.com/review-yeti-ai/review-yeti-bot/commit/2efde5d7e955dc8ffb45766cc50c25993786b4a6))

## [1.29.2](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.1...v1.29.2) (2026-09-04)


### Bug Fixes

* **test:** resolve TypeScript type errors in W3 test file set (REL-570) ([#472](https://github.com/review-yeti-ai/review-yeti-bot/issues/472)) ([e978d7f](https://github.com/review-yeti-ai/review-yeti-bot/commit/e978d7f3a41b08d028ffe4fe7b64feaa6ec2aa9f))

## [1.29.1](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.29.0...v1.29.1) (2026-09-04)


### Bug Fixes

* **test:** gate the helm e2e tests on the binary and bound their subprocess time (REL-570) ([#469](https://github.com/review-yeti-ai/review-yeti-bot/issues/469)) ([2841448](https://github.com/review-yeti-ai/review-yeti-bot/commit/2841448a757da25ad9908040920eb1b18dedf714))

## [1.29.0](https://github.com/review-yeti-ai/review-yeti-bot/compare/v1.28.6...v1.29.0) (2026-09-04)


### Features

* **examples,helm,docs:** add examples gallery, official Helm chart, and operational guides ([#466](https://github.com/review-yeti-ai/review-yeti-bot/issues/466)) ([67fb09e](https://github.com/review-yeti-ai/review-yeti-bot/commit/67fb09efbb675e46dbaa4f2dcbea037aa070fcf5))


### Bug Fixes

* **ci:** stop cancelling main's post-merge validation (REL-570) ([#468](https://github.com/review-yeti-ai/review-yeti-bot/issues/468)) ([0f7d36f](https://github.com/review-yeti-ai/review-yeti-bot/commit/0f7d36f85f0da4167e9be5798ef30d7854ad4829))

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
