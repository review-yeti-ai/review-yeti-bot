# Changelog

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
