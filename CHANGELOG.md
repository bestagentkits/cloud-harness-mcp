## [0.23.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.23.0...v0.23.1) (2026-08-29)


### Bug Fixes

* **runner:** reconcile GitHub repository grants on git_push ([238a117](https://github.com/bestagentkits/cloud-harness-mcp/commit/238a1175664762c73f276d08445bc013b9517547))

# [0.23.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.22.1...v0.23.0) (2026-08-28)


### Features

* **auth:** extend API key max lifetime to 3,650 days for zero-reauth AI clients ([#102](https://github.com/bestagentkits/cloud-harness-mcp/issues/102)) ([f74f957](https://github.com/bestagentkits/cloud-harness-mcp/commit/f74f957f47484bd8365d918811df290c35497069)), closes [#101](https://github.com/bestagentkits/cloud-harness-mcp/issues/101)

## [0.22.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.22.0...v0.22.1) (2026-08-27)


### Bug Fixes

* **api:** populate MCP tool response content text with formatted payload ([8a431b8](https://github.com/bestagentkits/cloud-harness-mcp/commit/8a431b8f28ab70593083dd431d557c18f8b2198a))

# [0.22.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.21.2...v0.22.0) (2026-08-24)


### Features

* **ux:** complete lease recovery, compound publish, pagination and reconnect window ([#89](https://github.com/bestagentkits/cloud-harness-mcp/issues/89), [#90](https://github.com/bestagentkits/cloud-harness-mcp/issues/90), [#91](https://github.com/bestagentkits/cloud-harness-mcp/issues/91), [#94](https://github.com/bestagentkits/cloud-harness-mcp/issues/94)) ([#100](https://github.com/bestagentkits/cloud-harness-mcp/issues/100)) ([cf050f8](https://github.com/bestagentkits/cloud-harness-mcp/commit/cf050f8842512a96078c4851aa788789a203f47f))

## [0.21.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.21.1...v0.21.2) (2026-08-24)


### Bug Fixes

* **security:** prevent symlink escapes and improve local stdio process termination ([#99](https://github.com/bestagentkits/cloud-harness-mcp/issues/99)) ([ba79491](https://github.com/bestagentkits/cloud-harness-mcp/commit/ba79491eb60374bb1099a919b33323650ef398fb))

## [0.21.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.21.0...v0.21.1) (2026-08-24)


### Bug Fixes

* **runner:** ensure large recovery buffer sizing, rootfs read-only protection, and server-owned async signals ([#97](https://github.com/bestagentkits/cloud-harness-mcp/issues/97)) ([b450ee9](https://github.com/bestagentkits/cloud-harness-mcp/commit/b450ee9790e0231fc565d6a24a899ccd36a723e8))

# [0.21.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.20.0...v0.21.0) (2026-08-24)


### Features

* **ux:** implement atomic batch writes, finalize, lease recovery, and extended operations ([#96](https://github.com/bestagentkits/cloud-harness-mcp/issues/96)) ([5e338a6](https://github.com/bestagentkits/cloud-harness-mcp/commit/5e338a6a08b7941322a0d0b61710958df622d219)), closes [#88](https://github.com/bestagentkits/cloud-harness-mcp/issues/88) [#89](https://github.com/bestagentkits/cloud-harness-mcp/issues/89) [#90](https://github.com/bestagentkits/cloud-harness-mcp/issues/90) [#91](https://github.com/bestagentkits/cloud-harness-mcp/issues/91) [#92](https://github.com/bestagentkits/cloud-harness-mcp/issues/92) [#93](https://github.com/bestagentkits/cloud-harness-mcp/issues/93) [#94](https://github.com/bestagentkits/cloud-harness-mcp/issues/94)

# [0.20.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.19.2...v0.20.0) (2026-08-24)


### Features

* **api:** add stdio transport and local-folder workspace mode ([#33](https://github.com/bestagentkits/cloud-harness-mcp/issues/33)) ([5939d29](https://github.com/bestagentkits/cloud-harness-mcp/commit/5939d29483a45df5fca963f5b7ff33100641c4ea))

## [0.19.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.19.1...v0.19.2) (2026-08-24)


### Bug Fixes

* **runner:** reconcile private repo grants before clone retry ([#87](https://github.com/bestagentkits/cloud-harness-mcp/issues/87)) ([02f94b3](https://github.com/bestagentkits/cloud-harness-mcp/commit/02f94b3614bc0c292253629555581082fa652c30)), closes [#86](https://github.com/bestagentkits/cloud-harness-mcp/issues/86) [#86](https://github.com/bestagentkits/cloud-harness-mcp/issues/86)

## [0.19.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.19.0...v0.19.1) (2026-08-23)


### Bug Fixes

* **runner:** meter privileged workspace size via root-capable helper on permission error ([#84](https://github.com/bestagentkits/cloud-harness-mcp/issues/84)) ([22f39bc](https://github.com/bestagentkits/cloud-harness-mcp/commit/22f39bc1eff644d238aba5f4bf86d31b79a80f10))

# [0.19.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.18.0...v0.19.0) (2026-08-23)


### Features

* **runner:** add workspace toolchains, 3-zone storage, privilege grants, and brokered github actions ([#83](https://github.com/bestagentkits/cloud-harness-mcp/issues/83)) ([e52e824](https://github.com/bestagentkits/cloud-harness-mcp/commit/e52e824398aa99b980d6604bc6adb5f7a57caa79))

# [0.18.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.17.0...v0.18.0) (2026-08-23)


### Features

* **mailbox:** add chatgpt capability probe ([af1e1d0](https://github.com/bestagentkits/cloud-harness-mcp/commit/af1e1d0f3bb2d05aa4e0a4e7504d87aa142e4e80))


### Reverts

* **mailbox:** remove accidental probe and release ([5e812be](https://github.com/bestagentkits/cloud-harness-mcp/commit/5e812be7615efd8a1890f8c2e6d72ae37e401526))

# [0.17.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.9...v0.17.0) (2026-08-20)


### Features

* **contracts:** support shorthand push refspecs and normalize canonical destinations ([#76](https://github.com/bestagentkits/cloud-harness-mcp/issues/76)) ([c4dd836](https://github.com/bestagentkits/cloud-harness-mcp/commit/c4dd836ef3cc48826bc4c05000017ee67b3ae359))

## [0.16.9](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.8...v0.16.9) (2026-08-20)


### Bug Fixes

* **runner:** permit script execution on tmpfs mounts for git askpass helper ([#75](https://github.com/bestagentkits/cloud-harness-mcp/issues/75)) ([a667b2c](https://github.com/bestagentkits/cloud-harness-mcp/commit/a667b2c13b4969ce98abd050bb74fbf0a9e678cc))

## [0.16.8](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.7...v0.16.8) (2026-08-20)


### Bug Fixes

* **runner:** pass interactive flag to docker run for clone and git transfer helpers ([#74](https://github.com/bestagentkits/cloud-harness-mcp/issues/74)) ([aeb3fe6](https://github.com/bestagentkits/cloud-harness-mcp/commit/aeb3fe6eb97ac295e83e0dca745fe0597e169260))

## [0.16.7](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.6...v0.16.7) (2026-08-20)


### Bug Fixes

* **github:** inherit contents write permission from installation payload ([#72](https://github.com/bestagentkits/cloud-harness-mcp/issues/72)) ([b95d6be](https://github.com/bestagentkits/cloud-harness-mcp/commit/b95d6bea1c21d37b037852a624137e5cfe82b058))

## [0.16.6](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.5...v0.16.6) (2026-08-19)


### Bug Fixes

* **site:** add dedicated drawer close button and full-screen mobile menu overlay ([#71](https://github.com/bestagentkits/cloud-harness-mcp/issues/71)) ([5015036](https://github.com/bestagentkits/cloud-harness-mcp/commit/501503634811b448b23a7385891dfbe9df3f93ac))

## [0.16.5](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.4...v0.16.5) (2026-08-19)


### Bug Fixes

* **site:** enforce strict specificity for mobile header compact rules and clean duplicate drawer CTA ([#70](https://github.com/bestagentkits/cloud-harness-mcp/issues/70)) ([9f48a12](https://github.com/bestagentkits/cloud-harness-mcp/commit/9f48a122c906b148a89b92ba7d042f31f912100e))

## [0.16.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.3...v0.16.4) (2026-08-19)


### Bug Fixes

* **site:** prevent mobile header overflow on viewports under 860px ([#69](https://github.com/bestagentkits/cloud-harness-mcp/issues/69)) ([4caf772](https://github.com/bestagentkits/cloud-harness-mcp/commit/4caf772a79937aa9564d8e111a5b407442cc7a06))

## [0.16.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.2...v0.16.3) (2026-08-19)


### Bug Fixes

* **site:** prevent mobile header clipping on small screens and add drawer CTA ([#68](https://github.com/bestagentkits/cloud-harness-mcp/issues/68)) ([b736df3](https://github.com/bestagentkits/cloud-harness-mcp/commit/b736df32fdbdb3340f02eadff60f20a6a4c9802f))

## [0.16.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.1...v0.16.2) (2026-08-19)


### Bug Fixes

* **site:** add SVG marker defs and fix mobile responsive navigation wrapping ([#66](https://github.com/bestagentkits/cloud-harness-mcp/issues/66)) ([d4c5686](https://github.com/bestagentkits/cloud-harness-mcp/commit/d4c568608f78a2a4ffee9b8315034bf0d9ac9aff))
* **site:** align Bounded Coding Workflow heading and verify test assertions ([#67](https://github.com/bestagentkits/cloud-harness-mcp/issues/67)) ([c644c56](https://github.com/bestagentkits/cloud-harness-mcp/commit/c644c56871292e390fa22201d4881baffbeccaf2))

## [0.16.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.16.0...v0.16.1) (2026-08-19)


### Bug Fixes

* **github:** fallback to read permissions and forward descriptive error messages ([#64](https://github.com/bestagentkits/cloud-harness-mcp/issues/64)) ([f921830](https://github.com/bestagentkits/cloud-harness-mcp/commit/f9218305496cfb61a06306b441107ae075f99cd3))

# [0.16.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.15.0...v0.16.0) (2026-08-19)


### Bug Fixes

* **dashboard:** wrap github complete in error handler and document Setup URL ([#63](https://github.com/bestagentkits/cloud-harness-mcp/issues/63)) ([c2b5cd0](https://github.com/bestagentkits/cloud-harness-mcp/commit/c2b5cd079128f3f0fe8dbe3ee454610a43e64f5f))
* **test:** harden docker abort cancellation test and finalize cyber marketing site ([#62](https://github.com/bestagentkits/cloud-harness-mcp/issues/62)) ([d88b537](https://github.com/bestagentkits/cloud-harness-mcp/commit/d88b537f28870e806b265ac746f127eb12e9ac4a))


### Features

* **site:** adapt full cyber-engineering HUD content, responsive diagrams, and lock CI deploy gate ([#61](https://github.com/bestagentkits/cloud-harness-mcp/issues/61)) ([ffe2f5c](https://github.com/bestagentkits/cloud-harness-mcp/commit/ffe2f5c1943caa2f0fce1594caac9239f233c105))

# [0.15.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.14.0...v0.15.0) (2026-08-19)


### Bug Fixes

* **broker:** allow unauthenticated public repository clone in Access mode without GitHub App grant ([f7019ab](https://github.com/bestagentkits/cloud-harness-mcp/commit/f7019abc533a3bf7f3617e6b4f529a830a12379f))


### Features

* **site:** align marketing site diagram geometry with cyber-engineering dark theme ([#58](https://github.com/bestagentkits/cloud-harness-mcp/issues/58)) ([8fc4c7a](https://github.com/bestagentkits/cloud-harness-mcp/commit/8fc4c7a3a2951f375691d18f21804ce63d920fc2))
* **site:** redesign marketing site with cyber-engineering dark HUD, animated diagrams, and 5 variants ([#57](https://github.com/bestagentkits/cloud-harness-mcp/issues/57)) ([5875875](https://github.com/bestagentkits/cloud-harness-mcp/commit/5875875868ad9fc59329072930129fa4fea6c3de))

# [0.14.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.13.0...v0.14.0) (2026-08-19)


### Features

* **github-app:** support multiple installations per principal ([#54](https://github.com/bestagentkits/cloud-harness-mcp/issues/54)) ([#55](https://github.com/bestagentkits/cloud-harness-mcp/issues/55)) ([aa7d1cb](https://github.com/bestagentkits/cloud-harness-mcp/commit/aa7d1cb8692baef1c0e3cefbe365f70a607d71a8))

# [0.13.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.12.0...v0.13.0) (2026-08-19)


### Features

* **docs:** public documentation site at docs.harness.agentkit.best with AI-crawler markdown twins ([#52](https://github.com/bestagentkits/cloud-harness-mcp/issues/52)) ([bf68455](https://github.com/bestagentkits/cloud-harness-mcp/commit/bf68455917769faf293eb9595e8c430b97544a15))

# [0.12.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.11.0...v0.12.0) (2026-08-19)


### Features

* **dashboard:** top header, working icon collapse, and Overview server status ([#50](https://github.com/bestagentkits/cloud-harness-mcp/issues/50)) ([51ca575](https://github.com/bestagentkits/cloud-harness-mcp/commit/51ca575c6ad1416e72c481518ed81876e2025567))

# [0.11.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.10.0...v0.11.0) (2026-08-19)


### Features

* **dashboard:** adopt Mission Control design system (light + dark) ([#49](https://github.com/bestagentkits/cloud-harness-mcp/issues/49)) ([b5c172f](https://github.com/bestagentkits/cloud-harness-mcp/commit/b5c172fbcd31e029331ca239d61d5ec975b9d544))

# [0.10.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.9.0...v0.10.0) (2026-08-19)


### Features

* **dashboard:** adaptive light/dark console, Overview home, and executor-image prune fix ([#48](https://github.com/bestagentkits/cloud-harness-mcp/issues/48)) ([10d110c](https://github.com/bestagentkits/cloud-harness-mcp/commit/10d110ccc35f275e8d674b0a30b3d8ce7f48c093))

# [0.9.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.8.0...v0.9.0) (2026-08-19)


### Features

* **dashboard:** polish control-plane dashboard UI/UX ([#47](https://github.com/bestagentkits/cloud-harness-mcp/issues/47)) ([8d9695e](https://github.com/bestagentkits/cloud-harness-mcp/commit/8d9695eebff2adf3df45be0120f0be4ff57ca760))

# [0.8.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.7.1...v0.8.0) (2026-08-19)


### Features

* **dashboard:** add Profile page with signed-in account details ([83ae75d](https://github.com/bestagentkits/cloud-harness-mcp/commit/83ae75d468b723de6e502c56a0f3ef67416171ce))

## [0.7.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.7.0...v0.7.1) (2026-08-18)


### Bug Fixes

* **deploy:** install API key nginx route ([fe85607](https://github.com/bestagentkits/cloud-harness-mcp/commit/fe85607b513f17a76a2f289500e44074149b9158))

# [0.7.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.6.4...v0.7.0) (2026-08-18)


### Features

* **auth:** add dashboard-managed MCP API keys ([c47429f](https://github.com/bestagentkits/cloud-harness-mcp/commit/c47429fac6124434c1f5dc26cc7578596ea0736d))

## [0.6.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.6.3...v0.6.4) (2026-08-18)


### Bug Fixes

* **api:** make dashboard assets readable ([b8c8f96](https://github.com/bestagentkits/cloud-harness-mcp/commit/b8c8f96dd77fca6ef2c6d70a0296c42f3e7880fe))

## [0.6.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.6.2...v0.6.3) (2026-08-18)


### Bug Fixes

* **deploy:** serialize production releases ([380317e](https://github.com/bestagentkits/cloud-harness-mcp/commit/380317e757c198bb66ced41e691349f5b2acb8fb))

## [0.6.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.6.1...v0.6.2) (2026-08-18)


### Bug Fixes

* **deploy:** enable Access JWKS and dashboard routing ([b24c007](https://github.com/bestagentkits/cloud-harness-mcp/commit/b24c0071f3d243295abcbc9e0af46a63e3bf1add))

## [0.6.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.6.0...v0.6.1) (2026-08-17)


### Bug Fixes

* **auth:** materialize owner bearer principal ([c923793](https://github.com/bestagentkits/cloud-harness-mcp/commit/c9237934ae4b87f7b4d65548406abae258109ed7))

# [0.6.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.5.1...v0.6.0) (2026-08-17)


### Bug Fixes

* **security:** harden artifact and rollback boundaries ([5b8d9f6](https://github.com/bestagentkits/cloud-harness-mcp/commit/5b8d9f6a72510e1fb0987d8bf5294b6cefbad507))


### Features

* **auth:** add Cloudflare Access dashboard ([3b1b455](https://github.com/bestagentkits/cloud-harness-mcp/commit/3b1b4554233f81c543a8d919247591709e6b40b3))

## [0.5.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.5.0...v0.5.1) (2026-08-17)


### Bug Fixes

* **site:** align diagram connectors and refine hero ([7eb805f](https://github.com/bestagentkits/cloud-harness-mcp/commit/7eb805f3acb66ee7a01034e40c3907756b2b6d8f)), closes [#30](https://github.com/bestagentkits/cloud-harness-mcp/issues/30)

# [0.5.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.4.0...v0.5.0) (2026-08-17)


### Features

* publish portable cloudharness skill plugin ([bc4f5e3](https://github.com/bestagentkits/cloud-harness-mcp/commit/bc4f5e39ab64480ee8e8b355734f180c985d1962))

# [0.4.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.3.0...v0.4.0) (2026-08-17)


### Bug Fixes

* **site:** clean up diagram layouts ([3d2260d](https://github.com/bestagentkits/cloud-harness-mcp/commit/3d2260dec2ca866d492e73537e12eecb783da94b))


### Features

* **site:** add animated MCP diagrams ([cfa99a3](https://github.com/bestagentkits/cloud-harness-mcp/commit/cfa99a397ddd8a317c36ba3aa3ce92a0d386bf82))
* **site:** add animated MCP workflow guide ([54ae018](https://github.com/bestagentkits/cloud-harness-mcp/commit/54ae0188a647684318b0f0bbce32ae434713581d))
* **site:** add MCP getting started guide ([6f9d6d5](https://github.com/bestagentkits/cloud-harness-mcp/commit/6f9d6d544b7f74aeaac2cf0a6d3e0818a59a5490))

## [0.3.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.2.0...v0.3.0) (2026-08-17)

### Features

* add cloudharness workflow skill ([a467633](https://github.com/bestagentkits/cloud-harness-mcp/commit/a46763318bb3efd99ec0e128f3a029e0709f3850))

# Changelog

All notable changes to this project are documented in this file by the release
workflow.
