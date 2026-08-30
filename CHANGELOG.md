## [0.35.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.35.0...v0.35.1) (2026-08-30)


### Bug Fixes

* **toolkits:** align preset schema, lock metadata, and superpowers adapter with open-source scope ([#149](https://github.com/bestagentkits/cloud-harness-mcp/issues/149)) ([5a0d656](https://github.com/bestagentkits/cloud-harness-mcp/commit/5a0d65630aaa147cbcc8c78ad3ee2639b5a629b4))

# [0.35.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.34.0...v0.35.0) (2026-08-30)


### Bug Fixes

* **runner:** full canonical workspace open fingerprint and strict toolkit cache root ([#141](https://github.com/bestagentkits/cloud-harness-mcp/issues/141)) ([f06adf1](https://github.com/bestagentkits/cloud-harness-mcp/commit/f06adf18c4d4e886ebb5a690c398a561f9c34e99))
* **runner:** harden toolkit acquisition failure boundaries, staging limits, and unready mirror handling ([#140](https://github.com/bestagentkits/cloud-harness-mcp/issues/140)) ([c978797](https://github.com/bestagentkits/cloud-harness-mcp/commit/c9787974d837aafc63e36c2d318de446ca2d87b1))
* **runner:** remove premature constructor mkdir in ToolkitCacheManager ([#143](https://github.com/bestagentkits/cloud-harness-mcp/issues/143)) ([9e7c3d9](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e7c3d9a0bc243b19a6aee4890ea1dc59d71d991))
* **runner:** remove unused crypto import from secret-metadata-store ([#139](https://github.com/bestagentkits/cloud-harness-mcp/issues/139)) ([2227a05](https://github.com/bestagentkits/cloud-harness-mcp/commit/2227a059a596f0ea3a8fa04197bc3ff84470ecb9))
* **runner:** strictly validate relative staging containment and count symlinks against maxFiles ([#142](https://github.com/bestagentkits/cloud-harness-mcp/issues/142)) ([fa5cf39](https://github.com/bestagentkits/cloud-harness-mcp/commit/fa5cf39401af11ae1a978883ba0fb36aa80e9c1a))
* **toolkits:** code review remediation, symlink containment, and lint cleanup ([#138](https://github.com/bestagentkits/cloud-harness-mcp/issues/138)) ([41aaeb0](https://github.com/bestagentkits/cloud-harness-mcp/commit/41aaeb04f98c52218d40d547a975d3dbf6fc3d92))
* **worker:** copy to immutable snapshot before digest computation to prevent TOCTOU race ([#144](https://github.com/bestagentkits/cloud-harness-mcp/issues/144)) ([276e3b6](https://github.com/bestagentkits/cloud-harness-mcp/commit/276e3b61b0d241718ffa58f8701aff9ea44606a7))
* **worker:** enforce recursive read-only permissions on snapshot tree before execution ([#145](https://github.com/bestagentkits/cloud-harness-mcp/issues/145)) ([0222047](https://github.com/bestagentkits/cloud-harness-mcp/commit/0222047e8e1c9e0cad632a26fd358f4349233aad))
* **worker:** preserve exact file modes and dereference verbatim snapshot in skills_run ([#146](https://github.com/bestagentkits/cloud-harness-mcp/issues/146)) ([4eb133b](https://github.com/bestagentkits/cloud-harness-mcp/commit/4eb133bcb0676e1688781c2c9a1202544f9d24e7))


### Features

* **toolkits:** support third-party agent toolkits with runner CAS and provisioning firewall ([#137](https://github.com/bestagentkits/cloud-harness-mcp/issues/137)) ([5610f29](https://github.com/bestagentkits/cloud-harness-mcp/commit/5610f294673936173d27c0e31a5ec586e1675f29))

# [0.34.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.33.3...v0.34.0) (2026-08-30)


### Bug Fixes

* **runner:** adapt agent tests and repository to network profile and schema v7 ([d9ac32b](https://github.com/bestagentkits/cloud-harness-mcp/commit/d9ac32bd46b6231743a7750ddbae25af67b53068))


### Features

* **agent:** add bounded Pi coding subagents ([7860dc1](https://github.com/bestagentkits/cloud-harness-mcp/commit/7860dc15137e7fadb9ac24358e9e321c1a07f727))

## [0.33.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.33.2...v0.33.3) (2026-08-30)


### Bug Fixes

* **security:** explicitly deny multicast (224/4), class E (240/4), and 0/8 in egress chain ([#134](https://github.com/bestagentkits/cloud-harness-mcp/issues/134)) ([e7f452e](https://github.com/bestagentkits/cloud-harness-mcp/commit/e7f452e3ab30ca9eaea19f8d49a3661d6b3317f8))

## [0.33.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.33.1...v0.33.2) (2026-08-30)


### Bug Fixes

* **security:** exact FORWARD/INPUT jump matching and network-guard deploy recording ([#133](https://github.com/bestagentkits/cloud-harness-mcp/issues/133)) ([2f4bc5a](https://github.com/bestagentkits/cloud-harness-mcp/commit/2f4bc5afdbd3797198ff89877d017d21bb28a7b4))

## [0.33.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.33.0...v0.33.1) (2026-08-30)


### Bug Fixes

* **security:** reject early RETURN and indirect jumps in INPUT target chain ([#132](https://github.com/bestagentkits/cloud-harness-mcp/issues/132)) ([c031764](https://github.com/bestagentkits/cloud-harness-mcp/commit/c031764560c0b497681510c14e84481b6aaa0ef6))

# [0.33.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.32.0...v0.33.0) (2026-08-30)


### Features

* **runner:** enforce controlled executor egress profiles ([#128](https://github.com/bestagentkits/cloud-harness-mcp/issues/128)) ([27ac3a7](https://github.com/bestagentkits/cloud-harness-mcp/commit/27ac3a7342e992af229206075908c60e2a0b840e)), closes [#12](https://github.com/bestagentkits/cloud-harness-mcp/issues/12)

# [0.32.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.31.1...v0.32.0) (2026-08-30)


### Features

* **context:** add provenance-aware workspace context, skills, memories, and hooks ([#15](https://github.com/bestagentkits/cloud-harness-mcp/issues/15)) ([a869ea6](https://github.com/bestagentkits/cloud-harness-mcp/commit/a869ea6cda24f25b1e37dcae75788a43c082c5d2))

## [0.31.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.31.0...v0.31.1) (2026-08-30)


### Bug Fixes

* **mcp:** flatten github_action input schema and enforce capability consistency ([#112](https://github.com/bestagentkits/cloud-harness-mcp/issues/112)) ([#123](https://github.com/bestagentkits/cloud-harness-mcp/issues/123)) ([5b79641](https://github.com/bestagentkits/cloud-harness-mcp/commit/5b796419670fcc78c2f34d3c63a240e6b79148f4))

# [0.31.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.30.0...v0.31.0) (2026-08-30)


### Features

* **runner:** add legacy finalize idempotency migration and cross-operation protection ([#14](https://github.com/bestagentkits/cloud-harness-mcp/issues/14)) ([#122](https://github.com/bestagentkits/cloud-harness-mcp/issues/122)) ([1220739](https://github.com/bestagentkits/cloud-harness-mcp/commit/1220739f6c846e1e370e20c31be35b838d92f74e))

# [0.30.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.29.1...v0.30.0) (2026-08-30)


### Bug Fixes

* **runner:** ensure hard teardown deadline rejection and late write capture ([#14](https://github.com/bestagentkits/cloud-harness-mcp/issues/14)) ([52b5385](https://github.com/bestagentkits/cloud-harness-mcp/commit/52b5385c56d61a80a93cc4c9fdce7d3093149ff6))


### Features

* **secrets:** add global secrets management, precedence merge, and dashboard UI ([#121](https://github.com/bestagentkits/cloud-harness-mcp/issues/121)) ([4193e50](https://github.com/bestagentkits/cloud-harness-mcp/commit/4193e506d0e130c28b99c41273b53b6419edebbf))

## [0.29.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.29.0...v0.29.1) (2026-08-30)


### Bug Fixes

* **runner:** ensure awaitable process exit barrier and MCP Tasks compatibility matrix ([#14](https://github.com/bestagentkits/cloud-harness-mcp/issues/14)) ([160410a](https://github.com/bestagentkits/cloud-harness-mcp/commit/160410a96d82d15b065ddef6e27eea94c71e0e9c))

# [0.29.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.28.1...v0.29.0) (2026-08-30)


### Features

* **runner:** make repository, task, and artifact state durable ([#14](https://github.com/bestagentkits/cloud-harness-mcp/issues/14)) ([f532a1a](https://github.com/bestagentkits/cloud-harness-mcp/commit/f532a1a6c1c7f86cadb829ddfea0154fa3628713))

## [0.28.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.28.0...v0.28.1) (2026-08-30)


### Bug Fixes

* **secrets:** enforce 4-byte minimum, optimize stream redactor, and harden snapshot integrity ([#118](https://github.com/bestagentkits/cloud-harness-mcp/issues/118)) ([176c213](https://github.com/bestagentkits/cloud-harness-mcp/commit/176c213c866daca1ffd3aaa3d61909f7076fb89e))

# [0.28.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.27.0...v0.28.0) (2026-08-30)


### Features

* **secrets:** add secret descriptions, mcp secrets_list discovery, and safe output redaction ([#117](https://github.com/bestagentkits/cloud-harness-mcp/issues/117)) ([366f929](https://github.com/bestagentkits/cloud-harness-mcp/commit/366f9293b88fbf5e16a304815c4cd8bdaf6b2e27))

# [0.27.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.26.0...v0.27.0) (2026-08-30)


### Features

* **runner:** add audit events and structured error taxonomy for brokered GitHub actions ([#115](https://github.com/bestagentkits/cloud-harness-mcp/issues/115)) ([eec0447](https://github.com/bestagentkits/cloud-harness-mcp/commit/eec044797938a59b1846430acbb9268ebfa761a7))

# [0.26.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.25.0...v0.26.0) (2026-08-29)


### Features

* **artifacts:** add bounded read, workspace restore, and public MCP tools ([#109](https://github.com/bestagentkits/cloud-harness-mcp/issues/109), [#110](https://github.com/bestagentkits/cloud-harness-mcp/issues/110), [#111](https://github.com/bestagentkits/cloud-harness-mcp/issues/111)) ([#113](https://github.com/bestagentkits/cloud-harness-mcp/issues/113)) ([45cc468](https://github.com/bestagentkits/cloud-harness-mcp/commit/45cc4687c6c2797d48eeacacc19037f95e27e2f4))

# [0.25.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.24.0...v0.25.0) (2026-08-29)


### Features

* **contracts,runner,api:** add repository capability and authorization preflight ([#107](https://github.com/bestagentkits/cloud-harness-mcp/issues/107)) ([997a6f2](https://github.com/bestagentkits/cloud-harness-mcp/commit/997a6f27916c39a5889fe015043ec4b90927d862))
* **mcp:** expose workspace recovery and lease renewal ([#103](https://github.com/bestagentkits/cloud-harness-mcp/issues/103)) ([#108](https://github.com/bestagentkits/cloud-harness-mcp/issues/108)) ([39d722b](https://github.com/bestagentkits/cloud-harness-mcp/commit/39d722bacfb102f2edbc1c0df8a8be86fbcd17a5))

# [0.24.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.23.1...v0.24.0) (2026-08-29)


### Features

* **runner:** add brokered GitHub issues and pull request operations ([#105](https://github.com/bestagentkits/cloud-harness-mcp/issues/105)) ([#106](https://github.com/bestagentkits/cloud-harness-mcp/issues/106)) ([06e972b](https://github.com/bestagentkits/cloud-harness-mcp/commit/06e972be00bb885891a8ae295613c39a53f22864))

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
