# [0.66.0-beta.44](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.43...v0.66.0-beta.44) (2026-10-29)


### Bug Fixes

* **test:** make runner, api and model-gateway suites pass on Windows hosts ([#623](https://github.com/bestagentkits/cloud-harness-mcp/issues/623)) ([efd460e](https://github.com/bestagentkits/cloud-harness-mcp/commit/efd460e4e0334e70d873cc80c58ae99da32365c0)), closes [#622](https://github.com/bestagentkits/cloud-harness-mcp/issues/622)

# [0.66.0-beta.43](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.42...v0.66.0-beta.43) (2026-10-29)


### Bug Fixes

* **model-gateway,runner:** refuse only the special-purpose /24s in 192.0/16 and 198.51/16 ([8de2bc4](https://github.com/bestagentkits/cloud-harness-mcp/commit/8de2bc4a5e3259cc1cef509053c5eb46b1365288)), closes [#617](https://github.com/bestagentkits/cloud-harness-mcp/issues/617)
* **runner:** refuse repository hosts that resolve to IPv4-mapped private addresses ([7b74443](https://github.com/bestagentkits/cloud-harness-mcp/commit/7b74443ea665c60a55f245c249905b5495942238)), closes [#616](https://github.com/bestagentkits/cloud-harness-mcp/issues/616)


### Features

* **claude-directory:** add scoped self-hosted Cloud Harness plugin ([1428437](https://github.com/bestagentkits/cloud-harness-mcp/commit/142843738d32a37ef974d11bfba6c10840d7423b)), closes [#613](https://github.com/bestagentkits/cloud-harness-mcp/issues/613)

# [0.66.0-beta.42](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.41...v0.66.0-beta.42) (2026-10-26)


### Bug Fixes

* **policy:** escalate CI workflow and dependency manifest edits without consulting the advisor ([09d7338](https://github.com/bestagentkits/cloud-harness-mcp/commit/09d7338c4f3b571ec0d874627b39b26d5ee18c54)), closes [#606](https://github.com/bestagentkits/cloud-harness-mcp/issues/606)
* **runner:** cover install hooks and more ecosystems in the sensitive path rules ([dcb4673](https://github.com/bestagentkits/cloud-harness-mcp/commit/dcb4673f8497cb20742d9b897351f4f6b248cd55))
* **runner:** let sensitive-path escalations follow the policy fallback ([d31f852](https://github.com/bestagentkits/cloud-harness-mcp/commit/d31f85286e6e8df99172a906f583494124b94464))

# [0.66.0-beta.41](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.40...v0.66.0-beta.41) (2026-10-26)


### Bug Fixes

* **notifications:** link a run's source only for host-pinned providers ([1ca22b9](https://github.com/bestagentkits/cloud-harness-mcp/commit/1ca22b9396cdaba9bd3e24ab723a49fa0d040e45)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417)
* **traces:** keep a waiting workflow's trace until its spans are written ([3b646f6](https://github.com/bestagentkits/cloud-harness-mcp/commit/3b646f653ac1b7eea1fedd531360ad96c1722c89)), closes [#603](https://github.com/bestagentkits/cloud-harness-mcp/issues/603)
* **traces:** keep held traces readable and hold full traces through approvals ([5b35573](https://github.com/bestagentkits/cloud-harness-mcp/commit/5b355737236fe53f33d44099b5f0f8604e120f6b))


### Features

* **notifications:** link automation notifications to the source, trace and pull request ([cce45a4](https://github.com/bestagentkits/cloud-harness-mcp/commit/cce45a4532bda2ccddfe7325835721408862cdab)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417)

# [0.66.0-beta.40](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.39...v0.66.0-beta.40) (2026-10-26)


### Bug Fixes

* **approvals:** bind approvals to the reviewed change and end stale waits ([59540f6](https://github.com/bestagentkits/cloud-harness-mcp/commit/59540f689d1b69922422abb0dfc9c6d447d8c42b))
* **dashboard:** show a held verify command token by token ([0eb179f](https://github.com/bestagentkits/cloud-harness-mcp/commit/0eb179f5437e537a3fecbf83405e22db5454f6ea))
* **runner:** bind approvals to the complete change and check it before committing ([b8234ef](https://github.com/bestagentkits/cloud-harness-mcp/commit/b8234ef96ce904503242639e787d1dd71b204e03))
* **runner:** compare the approved change with the commit made ([979fe5d](https://github.com/bestagentkits/cloud-harness-mcp/commit/979fe5dfd246dca777a191fd647cf3bf39a7f7b0))


### Features

* **dashboard:** decide held agent actions on the Approvals page ([7282e95](https://github.com/bestagentkits/cloud-harness-mcp/commit/7282e958470312847acf6c063acf6cadff14f7cb))
* **runner:** pause coding workflows for owner approval of runner steps ([09d01c0](https://github.com/bestagentkits/cloud-harness-mcp/commit/09d01c073333ad898e0a1e4274d476516d53b2ed))
* **runner:** trace advisor consults and prove the governed coding cycle ([0cebb57](https://github.com/bestagentkits/cloud-harness-mcp/commit/0cebb57f1919110c9b8b842d8e2292ab26c0254e))

# [0.66.0-beta.39](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.38...v0.66.0-beta.39) (2026-10-26)


### Bug Fixes

* **automations:** accept Jira webhook retries inside Atlassian's retry window ([174d0a2](https://github.com/bestagentkits/cloud-harness-mcp/commit/174d0a21ff425c7d19fe9bbcc92119577bd6789b))
* **automations:** count the usage of runs that end without completing ([a7f1175](https://github.com/bestagentkits/cloud-harness-mcp/commit/a7f117564c16d8d4752ae3885d73c48aaadb2794))
* **automations:** dedupe custom deliveries on the signed timestamp and body ([008fa76](https://github.com/bestagentkits/cloud-harness-mcp/commit/008fa76476cad05c173880ddb1d1d0437028732b))
* **automations:** fence free-form provider text out of the trusted prompt ([35c5be2](https://github.com/bestagentkits/cloud-harness-mcp/commit/35c5be288b7342473291ec47d1cd9de8c1f14fb6))
* **automations:** ignore Jira updates that carry no changelog ([672fcd9](https://github.com/bestagentkits/cloud-harness-mcp/commit/672fcd931fa10148e1b499ff6d9f13d673738db3))
* **automations:** match actor allowlists only on stable provider ids ([08f2bb9](https://github.com/bestagentkits/cloud-harness-mcp/commit/08f2bb925ee4afd9585747cbc63a4bc9faa2b7c2))
* **automations:** never create a second check run when the first id is unreadable ([2ac0faf](https://github.com/bestagentkits/cloud-harness-mcp/commit/2ac0faf90cdb6839852cc89c0b1b359f9a64a4c9))
* **automations:** pin the Jira publisher to the validated address ([2f100ec](https://github.com/bestagentkits/cloud-harness-mcp/commit/2f100ec004d25d509d3c7977a5c76087f91c8273))
* **automations:** publish the final state whenever a started run ends ([81bd309](https://github.com/bestagentkits/cloud-harness-mcp/commit/81bd3094d75e1e5e0122c1bf24e80eb6376e04ba))
* **automations:** rebuild the connections table until it admits every provider ([2ab3575](https://github.com/bestagentkits/cloud-harness-mcp/commit/2ab3575a5f7d1361ff55bf41ff8624a92dbaecd8))
* **automations:** record and describe the trigger each rule matched ([aa849cd](https://github.com/bestagentkits/cloud-harness-mcp/commit/aa849cde76975db5b8b9a843e304bbadc49a490d))
* **automations:** refuse publishing rules on connections without outbound credentials ([9d25de0](https://github.com/bestagentkits/cloud-harness-mcp/commit/9d25de0772e17af30cbae38e7fc87067d9639c1c))
* **automations:** refuse tab characters in automation labels ([bbc8a62](https://github.com/bestagentkits/cloud-harness-mcp/commit/bbc8a62abc39aff1d5f3169f937223b7f281eddf))
* **automations:** release a failing workspace close and find untracked check runs ([#450](https://github.com/bestagentkits/cloud-harness-mcp/issues/450)) ([7b14315](https://github.com/bestagentkits/cloud-harness-mcp/commit/7b143153dfb2c2a9f9f72ad03827f7c19994fa33)), closes [#445](https://github.com/bestagentkits/cloud-harness-mcp/issues/445) [#523](https://github.com/bestagentkits/cloud-harness-mcp/issues/523)
* **automations:** remove a deleted connection's deliveries and runs ([b7cc6f7](https://github.com/bestagentkits/cloud-harness-mcp/commit/b7cc6f79efeca0fe6230f29875a267a00d68bd43))
* **contracts:** add the missing space in an automation tool description ([277b624](https://github.com/bestagentkits/cloud-harness-mcp/commit/277b624718316159a2922f1e426f5172fee85376))
* **dashboard:** give working Linear and Jira webhook setup hints ([d6f9747](https://github.com/bestagentkits/cloud-harness-mcp/commit/d6f9747993aa6db11b3fcf7d5907ac7a8b5ce39a))
* **runner:** keep agent cleanup retries backed off after the retry limit ([#595](https://github.com/bestagentkits/cloud-harness-mcp/issues/595)) ([a733fa7](https://github.com/bestagentkits/cloud-harness-mcp/commit/a733fa751640275fb18ddba70136b5c57753e093)), closes [#590](https://github.com/bestagentkits/cloud-harness-mcp/issues/590)


### Features

* **automations:** add delivery replay, connection health and metrics operations ([8e072e0](https://github.com/bestagentkits/cloud-harness-mcp/commit/8e072e0650172d224e06a4bb5535df4d79c8bb67))
* **automations:** add signed custom webhook connections ([af6d9be](https://github.com/bestagentkits/cloud-harness-mcp/commit/af6d9be6ae919023879b31e91a7aad50a6e8b33e))
* **automations:** add the Jira webhook provider ([4b64f46](https://github.com/bestagentkits/cloud-harness-mcp/commit/4b64f46b575db5fbe50a82d6f07eb26a42ceb33a))
* **automations:** add the Linear webhook provider ([7e169a3](https://github.com/bestagentkits/cloud-harness-mcp/commit/7e169a33876cf374cbb95d0721cfe3d198cfdb40))
* **automations:** edit one progress comment and report GitHub check runs ([f1c677b](https://github.com/bestagentkits/cloud-harness-mcp/commit/f1c677b4d17d43f017e8a77bbb2e6d0e93cccc7a))
* **automations:** fire every label and state rule from one update ([adf0714](https://github.com/bestagentkits/cloud-harness-mcp/commit/adf07147d2a3051a6a15a9992ad60494c34a22b6))
* **automations:** make the webhook pipeline provider-neutral ([2775461](https://github.com/bestagentkits/cloud-harness-mcp/commit/2775461bb1f8108820954e7e15353c9ad49d7016))
* **dashboard:** manage automations for every provider with replay, health and metrics ([b0e2c09](https://github.com/bestagentkits/cloud-harness-mcp/commit/b0e2c0981716282bfa5ad88ed1dfb0b347be6c09))
* **dashboard:** update or clear automation outbound credentials ([29cf224](https://github.com/bestagentkits/cloud-harness-mcp/commit/29cf224bdbfa212a21e3c30ec9ff9d86dcb1faa6))
* **mcp:** manage automation rules and runs from MCP ([4e89244](https://github.com/bestagentkits/cloud-harness-mcp/commit/4e892443b25c5cbd4c8d6105530d873b9dbe0ab7))

# [0.66.0-beta.38](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.37...v0.66.0-beta.38) (2026-10-26)


### Bug Fixes

* **model-gateway:** end an over-cap stream with an in-band bound error ([#542](https://github.com/bestagentkits/cloud-harness-mcp/issues/542)) ([b568a9c](https://github.com/bestagentkits/cloud-harness-mcp/commit/b568a9c898c25e74ee53c06a3c4ecaed953437c4)), closes [#439](https://github.com/bestagentkits/cloud-harness-mcp/issues/439) [#447](https://github.com/bestagentkits/cloud-harness-mcp/issues/447) [#447](https://github.com/bestagentkits/cloud-harness-mcp/issues/447)
* **model-gateway:** settle every early stream exit before cutting it off ([#564](https://github.com/bestagentkits/cloud-harness-mcp/issues/564)) ([43c35c2](https://github.com/bestagentkits/cloud-harness-mcp/commit/43c35c2c6c0fb6355d9a4a40cdcd141a4525cc45)), closes [#439](https://github.com/bestagentkits/cloud-harness-mcp/issues/439) [#447](https://github.com/bestagentkits/cloud-harness-mcp/issues/447) [#447](https://github.com/bestagentkits/cloud-harness-mcp/issues/447) [#543](https://github.com/bestagentkits/cloud-harness-mcp/issues/543)

# [0.66.0-beta.37](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.36...v0.66.0-beta.37) (2026-10-26)


### Bug Fixes

* **agent-runtime:** end provider-throttled runs as FAILED, not LIMIT_EXCEEDED ([#446](https://github.com/bestagentkits/cloud-harness-mcp/issues/446)) ([c6736ba](https://github.com/bestagentkits/cloud-harness-mcp/commit/c6736ba6a383eb11734905b62d73494eda5eabf2)), closes [#439](https://github.com/bestagentkits/cloud-harness-mcp/issues/439)

# [0.66.0-beta.36](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.35...v0.66.0-beta.36) (2026-10-21)


### Bug Fixes

* **dashboard:** never save a partial files_read window as the whole file ([64f8f04](https://github.com/bestagentkits/cloud-harness-mcp/commit/64f8f04612a802c6f01de1d6861d0838b4b8656a)), closes [#525](https://github.com/bestagentkits/cloud-harness-mcp/issues/525)

# [0.66.0-beta.35](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.34...v0.66.0-beta.35) (2026-10-21)


### Bug Fixes

* **hooks:** let a hook's manifest timeoutMs apply when hooks_run names none ([961d34f](https://github.com/bestagentkits/cloud-harness-mcp/commit/961d34febf1a737cd8b0150319f8c1e5231ea534)), closes [#521](https://github.com/bestagentkits/cloud-harness-mcp/issues/521)

# [0.66.0-beta.34](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.33...v0.66.0-beta.34) (2026-10-21)


### Bug Fixes

* **dashboard:** run one named hook against the rendered manifest digest ([0eb9ac1](https://github.com/bestagentkits/cloud-harness-mcp/commit/0eb9ac18e16390aa2b0a6504e29ba4c2aba61bc5)), closes [#513](https://github.com/bestagentkits/cloud-harness-mcp/issues/513)
* **runner,dashboard:** tell agents a skill-run grant binds the whole request ([157df60](https://github.com/bestagentkits/cloud-harness-mcp/commit/157df608c6ec67b1b19b8e7e5dc49c3fcdc0b202)), closes [#517](https://github.com/bestagentkits/cloud-harness-mcp/issues/517) [#518](https://github.com/bestagentkits/cloud-harness-mcp/issues/518)
* **runner:** bind skill-run arguments, source and timeout to the privilege grant ([c200c1a](https://github.com/bestagentkits/cloud-harness-mcp/commit/c200c1a06caba749e82f7861f351dd839764a944)), closes [#517](https://github.com/bestagentkits/cloud-harness-mcp/issues/517)
* **runner:** report each hook's activation state in hooks_list ([dc86ec8](https://github.com/bestagentkits/cloud-harness-mcp/commit/dc86ec8991a204c99d5ceeb9aafb00705205b537)), closes [#518](https://github.com/bestagentkits/cloud-harness-mcp/issues/518)

# [0.66.0-beta.33](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.32...v0.66.0-beta.33) (2026-10-21)


### Bug Fixes

* **dashboard:** check every input pattern and keep a skill run result honest ([6566ad0](https://github.com/bestagentkits/cloud-harness-mcp/commit/6566ad044211dcbf07c56ecf9e15a909481d803a)), closes [#514](https://github.com/bestagentkits/cloud-harness-mcp/issues/514) [#515](https://github.com/bestagentkits/cloud-harness-mcp/issues/515)
* **dashboard:** escape the hyphen in input patterns so browsers enforce them ([a59f4f3](https://github.com/bestagentkits/cloud-harness-mcp/commit/a59f4f3ca5867341b4036f8bb3a5fa35b3377893)), closes [#514](https://github.com/bestagentkits/cloud-harness-mcp/issues/514)
* **dashboard:** name a missing script or stale approval and reject a declined skill-run grant ([ad5c45f](https://github.com/bestagentkits/cloud-harness-mcp/commit/ad5c45fcab5e903ed82bfd4cbd51be78414f87bd)), closes [#511](https://github.com/bestagentkits/cloud-harness-mcp/issues/511)


### Features

* **dashboard:** approve and run a workspace skill script from the cockpit ([95e7850](https://github.com/bestagentkits/cloud-harness-mcp/commit/95e785067dcdce091b8bd588bfd570cfb5389359)), closes [#511](https://github.com/bestagentkits/cloud-harness-mcp/issues/511)
* **dashboard:** show a skill run's exit code and bounded output, failed or not ([34ed597](https://github.com/bestagentkits/cloud-harness-mcp/commit/34ed597ba448e50be060b66cb37502e9dc830d56)), closes [#515](https://github.com/bestagentkits/cloud-harness-mcp/issues/515)

# [0.66.0-beta.32](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.31...v0.66.0-beta.32) (2026-10-21)


### Bug Fixes

* **dashboard:** ask which repository a multi-repository workspace finalizes ([1ea1ed1](https://github.com/bestagentkits/cloud-harness-mcp/commit/1ea1ed116923ce818e0c5a24e3bdf0e7429b5265))
* **docs:** quote the checkout path in the repository add description ([099f8e0](https://github.com/bestagentkits/cloud-harness-mcp/commit/099f8e0bccb869a5dee3376182b859c83c9de44e))
* **workspaces:** freeze the workspace tree around repository add and remove ([dbc6309](https://github.com/bestagentkits/cloud-harness-mcp/commit/dbc63093b1030b3854a03715769a923104f280e9))
* **workspaces:** never follow a swapped repos link when rolling back an added checkout ([0d92c50](https://github.com/bestagentkits/cloud-harness-mcp/commit/0d92c5063afb4ac4fcf164d8d58e03d9c8e32479))
* **workspaces:** recover an executor left paused by a repository change ([068045c](https://github.com/bestagentkits/cloud-harness-mcp/commit/068045c74382a6435fc32b366e111533a870007a))
* **workspaces:** refuse a pause while an executor recovery is in flight ([70a2e57](https://github.com/bestagentkits/cloud-harness-mcp/commit/70a2e57ba89b50fad4e6d395a7ec4402862d6593))
* **workspaces:** refuse executor recovery while a repository change holds the pause ([63c3837](https://github.com/bestagentkits/cloud-harness-mcp/commit/63c3837f508eebac172ee60108e4f20a3f8bc302))


### Features

* **dashboard:** scope files, git and terminal to a selected repository ([42c4185](https://github.com/bestagentkits/cloud-harness-mcp/commit/42c4185ab6611092e7fecdf21b534c581a8396d2))
* **workspaces:** add and remove repositories after open, search all checkouts ([db9455a](https://github.com/bestagentkits/cloud-harness-mcp/commit/db9455a641d296663089f53b550015f5b9378f0c))

# [0.66.0-beta.31](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.30...v0.66.0-beta.31) (2026-10-21)


### Bug Fixes

* **dashboard:** render mark-all state and re-read the inbox after it ([ea41e94](https://github.com/bestagentkits/cloud-harness-mcp/commit/ea41e9403ad1cef2272e33dbb3060633aabfe2c7))
* **dashboard:** scope mark-all to the loaded inbox and relabel GitHub status ([0f6f472](https://github.com/bestagentkits/cloud-harness-mcp/commit/0f6f47220e8d4cb394cc32703c7ae66ca084dae5))
* **notifications:** cap lost leases and bound mark-all by insertion order ([64f9929](https://github.com/bestagentkits/cloud-harness-mcp/commit/64f992979d6b3c8c3382ee891fab222d544f5e7b))
* **notifications:** stop the webhook when MCP Events is turned off ([155ba53](https://github.com/bestagentkits/cloud-harness-mcp/commit/155ba537ae54476a3a1256b36c74f62f05abe161))
* **runner:** mount the push inspection on its staged clone alone ([ff85f17](https://github.com/bestagentkits/cloud-harness-mcp/commit/ff85f177e24ea990d05bb7cb22bf092ad6917098))


### Features

* **contracts:** add notification inbox contracts and the notification.created event ([08a8dbf](https://github.com/bestagentkits/cloud-harness-mcp/commit/08a8dbf93295753a42c7f0b7cdae9385106a0d24)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417)
* **dashboard:** add the notification inbox page and its BFF routes ([b540697](https://github.com/bestagentkits/cloud-harness-mcp/commit/b54069741bf32887e591d6f1bca5c8e1f31907ff)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417)
* **runner:** record inbox notifications on terminal transitions and dispatch them ([20ddfcb](https://github.com/bestagentkits/cloud-harness-mcp/commit/20ddfcbf70d13c3b6e78e1974e30853007f2432a)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417)

# [0.66.0-beta.30](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.29...v0.66.0-beta.30) (2026-10-20)


### Bug Fixes

* **agent-policies:** bind weakening confirmations and check versions first ([69742dd](https://github.com/bestagentkits/cloud-harness-mcp/commit/69742dd15809b42cf867f39bf02bc8f904090db8))
* **agent-policies:** bind weakening confirmations to the operation and history ([3404f00](https://github.com/bestagentkits/cloud-harness-mcp/commit/3404f00796938d0047c1d7c4ebc9b6e95b9f8916))
* **agent-policies:** close gate bypasses and hold advisor-pending actions ([63a0224](https://github.com/bestagentkits/cloud-harness-mcp/commit/63a0224091e36fe344624b035af5a283e0ac7ada))
* **agent-policies:** fail closed on commands the gate cannot read ([f828c5c](https://github.com/bestagentkits/cloud-harness-mcp/commit/f828c5c7303014241fd66497c11c586eb0e69360))
* **agent-policies:** require approval for unanalyzable commands instead of denying ([ca3cae6](https://github.com/bestagentkits/cloud-harness-mcp/commit/ca3cae6d320cf223b1469104838015e95a930e8a))
* **agent-runtime:** classify gateway budget refusals separately from rate limits ([a72b4e7](https://github.com/bestagentkits/cloud-harness-mcp/commit/a72b4e724192340a5718f13bc9c5c5f8becee4f3)), closes [#438](https://github.com/bestagentkits/cloud-harness-mcp/issues/438)
* **coding:** count only transfer staging failures and match the commit exactly ([9959f68](https://github.com/bestagentkits/cloud-harness-mcp/commit/9959f68a6eb7995cd706875b904669d31efcd4e4))
* **coding:** decide the published commit on the isolated transfer clone ([b712cd8](https://github.com/bestagentkits/cloud-harness-mcp/commit/b712cd8b3fc18b36b05757a7eb2d23a22c0bffda))
* **coding:** harden transfer helper reads and bound unverified pushes ([520efc0](https://github.com/bestagentkits/cloud-harness-mcp/commit/520efc082616631721c94b0d08b9fef90c2eacdf))
* **coding:** verify the checkout and the pushed commit with runner-owned Git reads ([cef72b0](https://github.com/bestagentkits/cloud-harness-mcp/commit/cef72b0286bcbc7c6e62c2919dcbc2486f63b34f))
* **dashboard-bff:** fence skill import cancel on the job's real generation ([#502](https://github.com/bestagentkits/cloud-harness-mcp/issues/502)) ([6d0d1cd](https://github.com/bestagentkits/cloud-harness-mcp/commit/6d0d1cdeb33ab3cecd9b57f70968f6fd081dc368)), closes [#497](https://github.com/bestagentkits/cloud-harness-mcp/issues/497) [#500](https://github.com/bestagentkits/cloud-harness-mcp/issues/500) [#501](https://github.com/bestagentkits/cloud-harness-mcp/issues/501)
* **dashboard:** keep GitHub App setup callback query on legacy redirect ([#499](https://github.com/bestagentkits/cloud-harness-mcp/issues/499)) ([975a269](https://github.com/bestagentkits/cloud-harness-mcp/commit/975a26907ac3c7c609b2dcbebb22a06700a8f153)), closes [#498](https://github.com/bestagentkits/cloud-harness-mcp/issues/498)
* **dashboard:** keep policy-gated profile operations when editing a profile ([0d32587](https://github.com/bestagentkits/cloud-harness-mcp/commit/0d325879945ff46466ff9a2ba9eb84efec4b6739))
* **dashboard:** keep trace list cursors and filters stable ([d903ade](https://github.com/bestagentkits/cloud-harness-mcp/commit/d903ade39c397eb0b9a9c496dc341ed63e5ee7a8)), closes [#394](https://github.com/bestagentkits/cloud-harness-mcp/issues/394)
* **dashboard:** reconfirm changed policy weakenings and show orphaned previews ([9300cf0](https://github.com/bestagentkits/cloud-harness-mcp/commit/9300cf04679656e7d71a595936375c60e4b2fbf0))
* **deploy:** move dependency firewall jumps to rule 1 atomically ([#479](https://github.com/bestagentkits/cloud-harness-mcp/issues/479)) ([e203173](https://github.com/bestagentkits/cloud-harness-mcp/commit/e2031737eed87db38ac654a329043e49aa715646)), closes [#477](https://github.com/bestagentkits/cloud-harness-mcp/issues/477) [#477](https://github.com/bestagentkits/cloud-harness-mcp/issues/477)
* **model-gateway:** answer an invalid output token field with 400 invalid_model_request ([cd015d3](https://github.com/bestagentkits/cloud-harness-mcp/commit/cd015d366e17c21ea2d8ab2557ce98ab46e8f163)), closes [#440](https://github.com/bestagentkits/cloud-harness-mcp/issues/440)
* **policy:** analyse argv only and hold every shell string for approval ([f6128fb](https://github.com/bestagentkits/cloud-harness-mcp/commit/f6128fb8e507d34e1c7e2ab661cf93e1418defb7))
* **policy:** read only a small shell grammar and require approval for the rest ([dc92575](https://github.com/bestagentkits/cloud-harness-mcp/commit/dc92575720c7b45f9470e2445a6db5e552417d43))
* **policy:** tighten the data-only list and document the gate as a policy layer ([cd834fd](https://github.com/bestagentkits/cloud-harness-mcp/commit/cd834fdcc15575d966962e639e2286d445f301ba))
* **release:** restore missing prerelease channel notes before releasing ([#504](https://github.com/bestagentkits/cloud-harness-mcp/issues/504)) ([cc0fb7c](https://github.com/bestagentkits/cloud-harness-mcp/commit/cc0fb7c241d7f39829dff431d0b3a2daa1ff36bb)), closes [#503](https://github.com/bestagentkits/cloud-harness-mcp/issues/503)
* **release:** run the channel note repair from the release config ([#505](https://github.com/bestagentkits/cloud-harness-mcp/issues/505)) ([2a4b340](https://github.com/bestagentkits/cloud-harness-mcp/commit/2a4b340faccbc559a4e8dc0c2f1a424d2955422f)), closes [#503](https://github.com/bestagentkits/cloud-harness-mcp/issues/503)
* **runner:** confine a failed executor restart at startup to its workspace ([8d1b878](https://github.com/bestagentkits/cloud-harness-mcp/commit/8d1b8788c7825ea4239d310a8c3a0b98baec0ccb)), closes [#428](https://github.com/bestagentkits/cloud-harness-mcp/issues/428)
* **runner:** describe the judged action to Jev and hold its confidence floor in the gate ([7f3bbf9](https://github.com/bestagentkits/cloud-harness-mcp/commit/7f3bbf97dd78b6e4cfd3b9398b51d1bc39b34956)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417) [#333](https://github.com/bestagentkits/cloud-harness-mcp/issues/333)
* **runner:** log startup reconcile failures and close workspaces without a checkout ([288efdc](https://github.com/bestagentkits/cloud-harness-mcp/commit/288efdc8a6e94597f75bcdfcafb7810766eed4b4))
* **runner:** mount each git transfer helper on its own transfer repository ([#468](https://github.com/bestagentkits/cloud-harness-mcp/issues/468)) ([525aa55](https://github.com/bestagentkits/cloud-harness-mcp/commit/525aa55cebbbb950fbc975e4a8c2b913b4aad13a)), closes [#466](https://github.com/bestagentkits/cloud-harness-mcp/issues/466) [#466](https://github.com/bestagentkits/cloud-harness-mcp/issues/466)
* **runner:** mount only the staged clone, read-only, for a push inspection ([#471](https://github.com/bestagentkits/cloud-harness-mcp/issues/471)) ([39dbe07](https://github.com/bestagentkits/cloud-harness-mcp/commit/39dbe07c23f455184aa86085749151024439b158)), closes [#470](https://github.com/bestagentkits/cloud-harness-mcp/issues/470)
* **runner:** read firewall chain order from the filter table only ([#475](https://github.com/bestagentkits/cloud-harness-mcp/issues/475)) ([6b5fb0c](https://github.com/bestagentkits/cloud-harness-mcp/commit/6b5fb0cecb54c9b2721ba053a0d0227e997a3aef)), closes [#478](https://github.com/bestagentkits/cloud-harness-mcp/issues/478)
* **runner:** repair managed firewall jumps displaced by Tailscale ([#476](https://github.com/bestagentkits/cloud-harness-mcp/issues/476)) ([655ccae](https://github.com/bestagentkits/cloud-harness-mcp/commit/655ccae7bad402b9c2abd00e9f396e8f91f2914a)), closes [#474](https://github.com/bestagentkits/cloud-harness-mcp/issues/474)
* **runner:** skip a leftover container Docker cannot remove at startup ([3bff72a](https://github.com/bestagentkits/cloud-harness-mcp/commit/3bff72a563a07ee2acb97228bd94b3418934d78b)), closes [#443](https://github.com/bestagentkits/cloud-harness-mcp/issues/443)
* **traces:** bound redaction cost and complete budget spans ([4407620](https://github.com/bestagentkits/cloud-harness-mcp/commit/44076206265602debf4cdf71e5a8becfd87a0d01)), closes [#394](https://github.com/bestagentkits/cloud-harness-mcp/issues/394)
* **traces:** evict quota excess in batches and stop the purge on shutdown ([3668e01](https://github.com/bestagentkits/cloud-harness-mcp/commit/3668e012de47800f10ad5c2bb831ed87dfa461f8)), closes [#394](https://github.com/bestagentkits/cloud-harness-mcp/issues/394)
* **workspaces:** keep multi-repository writes scoped to their repository ([f0fc6b8](https://github.com/bestagentkits/cloud-harness-mcp/commit/f0fc6b836d0d67f4aa3d448fb9f045328623e0ee))


### Features

* **agent-policies:** add execution policy contracts, store and gate evaluator ([f7ecfeb](https://github.com/bestagentkits/cloud-harness-mcp/commit/f7ecfeb0a680364c4a9347e6a2367411ffa8227a))
* **agent-policies:** add owner dashboard routes for agent policies ([ab96c2f](https://github.com/bestagentkits/cloud-harness-mcp/commit/ab96c2f590677700d45db3e9784fa959c6722d86))
* **agent-runtime:** report bounded turn outcome and error class ([6e46a54](https://github.com/bestagentkits/cloud-harness-mcp/commit/6e46a543ae7431d607e66eef63b4f5029836ab28))
* **automations:** run opt-in coding workflows from issue to pull request ([28aca4c](https://github.com/bestagentkits/cloud-harness-mcp/commit/28aca4c81c256dffbb13afbdadc1d1138967683f))
* **coding:** gate brokered actions through the policy service decide ([47d09b3](https://github.com/bestagentkits/cloud-harness-mcp/commit/47d09b398cbcaf8a49f2623b55213333d55e17ad))
* **contracts:** add coding action contracts and brokered proxy operations ([6e25192](https://github.com/bestagentkits/cloud-harness-mcp/commit/6e2519272953e09ff484f480e3585546b53284ab))
* **dashboard:** add a Traces page and agent trace waterfall ([b9f58aa](https://github.com/bestagentkits/cloud-harness-mcp/commit/b9f58aada363f8600fdb976514a54e58c816b263))
* **dashboard:** add agent policy editor, preview and simulation pages ([3b699fd](https://github.com/bestagentkits/cloud-harness-mcp/commit/3b699fd452fa33ca96e321a2bff3f19a6c5696a0))
* **dashboard:** edit and explain the execution-risk advisor in agent policies ([49407ef](https://github.com/bestagentkits/cloud-harness-mcp/commit/49407efa5e8d19d2eb7c5e35efded394647826aa)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417) [#333](https://github.com/bestagentkits/cloud-harness-mcp/issues/333)
* **dashboard:** show coding run receipts and edit coding rules ([b4c7aa4](https://github.com/bestagentkits/cloud-harness-mcp/commit/b4c7aa452110c20c4ef09a610de2e66b9aa755a7))
* **runner:** add the Jev execution-risk advisor to the agent policy gate ([fa86c3d](https://github.com/bestagentkits/cloud-harness-mcp/commit/fa86c3df3e3a7dd5034357d6922998ec5b2fb8db)), closes [#417](https://github.com/bestagentkits/cloud-harness-mcp/issues/417) [#333](https://github.com/bestagentkits/cloud-harness-mcp/issues/333)
* **runner:** broker coding actions through the execution policy gate ([c93f731](https://github.com/bestagentkits/cloud-harness-mcp/commit/c93f731a6fe5336e8ec9f661392f8d6739d1f7ea))
* **traces:** record durable agent traces with owner-scoped read tools ([4b63b37](https://github.com/bestagentkits/cloud-harness-mcp/commit/4b63b37db12bb27b4868292ef2de54c1ded19c17))
* **workspaces:** open one workspace with several repository checkouts ([367a46f](https://github.com/bestagentkits/cloud-harness-mcp/commit/367a46f0f2a9f6a8979b765ea8925ac727a5d3ef))


### Performance Improvements

* **runner:** resolve active policy projects with an ids-only query ([5f907a7](https://github.com/bestagentkits/cloud-harness-mcp/commit/5f907a7f65f69df28976bc2f10f0d280d2d4650b))

# [0.66.0-beta.29](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.28...v0.66.0-beta.29) (2026-10-17)


### Bug Fixes

* **automations:** harden webhook ingress fairness, admission and recovery ([8390e67](https://github.com/bestagentkits/cloud-harness-mcp/commit/8390e67cfeda44e260f602dc20dfce71f42342f3))


### Features

* **automations:** GitHub label webhooks start budgeted read-only agent workflows ([25e92e1](https://github.com/bestagentkits/cloud-harness-mcp/commit/25e92e15c504e002c943c221400b1234a626fc2f))
* **contracts:** add webhook automation internal channel, limits and MCP event names ([10c0985](https://github.com/bestagentkits/cloud-harness-mcp/commit/10c09853b5d9d2a03a2eed64793eb7d0bb03784b))
* **dashboard:** Automations page for runs, rules, connections and deliveries ([69fd6e0](https://github.com/bestagentkits/cloud-harness-mcp/commit/69fd6e018d9829e8870cfc7aa5546e8261fc703e))

# [0.66.0-beta.28](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.27...v0.66.0-beta.28) (2026-10-17)


### Features

* **models:** add OpenCode Go as a registry provider with its session header ([#392](https://github.com/bestagentkits/cloud-harness-mcp/issues/392)) ([b346d19](https://github.com/bestagentkits/cloud-harness-mcp/commit/b346d195f1ddb4c9a395c215d92649ed24661e73))

# [0.66.0-beta.27](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.26...v0.66.0-beta.27) (2026-10-17)


### Features

* expose model setup and spend tools over MCP ([#391](https://github.com/bestagentkits/cloud-harness-mcp/issues/391)) ([dac2ebe](https://github.com/bestagentkits/cloud-harness-mcp/commit/dac2ebe8cb8c499ea0c0d924dd74f6f00060b40a))

# [0.66.0-beta.26](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.25...v0.66.0-beta.26) (2026-10-17)


### Bug Fixes

* **model-gateway:** replace snapshot state so removed credentials and revisions are evicted ([#390](https://github.com/bestagentkits/cloud-harness-mcp/issues/390)) ([3373e46](https://github.com/bestagentkits/cloud-harness-mcp/commit/3373e4678660a610d9f0527a2341bed78321eaf0))

# [0.66.0-beta.25](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.24...v0.66.0-beta.25) (2026-10-17)


### Bug Fixes

* **model-gateway:** answer malformed control records without echoing input ([#389](https://github.com/bestagentkits/cloud-harness-mcp/issues/389)) ([98ffe89](https://github.com/bestagentkits/cloud-harness-mcp/commit/98ffe89236e8f967518bfa6b68866f63beed0dd7))

# [0.66.0-beta.24](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.23...v0.66.0-beta.24) (2026-10-17)


### Features

* **runner:** dry-run model profile changes, guard escalations, and audit every profile save ([#388](https://github.com/bestagentkits/cloud-harness-mcp/issues/388)) ([5f1d309](https://github.com/bestagentkits/cloud-harness-mcp/commit/5f1d309a20d097cab9bfc701073d1717c288042f))

# [0.66.0-beta.23](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.22...v0.66.0-beta.23) (2026-10-17)


### Features

* **dashboard:** show price provenance, model spend, and spend limits ([#386](https://github.com/bestagentkits/cloud-harness-mcp/issues/386)) ([adb77f5](https://github.com/bestagentkits/cloud-harness-mcp/commit/adb77f5a066e1bfa69747006103e80b0e09d2b02))

# [0.66.0-beta.22](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.21...v0.66.0-beta.22) (2026-10-17)


### Bug Fixes

* **runner:** report model gateway sync from the snapshot digest ([#385](https://github.com/bestagentkits/cloud-harness-mcp/issues/385)) ([1573809](https://github.com/bestagentkits/cloud-harness-mcp/commit/15738098a04d76e288657d5ebcfee5eaa964cd0e))

# [0.66.0-beta.21](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.20...v0.66.0-beta.21) (2026-10-17)


### Features

* **runner:** enforce aggregate model spend policies with a durable ledger and a policy API ([#383](https://github.com/bestagentkits/cloud-harness-mcp/issues/383)) ([89e47a6](https://github.com/bestagentkits/cloud-harness-mcp/commit/89e47a6d4d573315f5b5d46e800a5aaafcfff324))

# [0.66.0-beta.20](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.19...v0.66.0-beta.20) (2026-10-17)


### Features

* **models:** import catalog price tiers, resolve price provenance, and review repricing ([#379](https://github.com/bestagentkits/cloud-harness-mcp/issues/379)) ([74cd394](https://github.com/bestagentkits/cloud-harness-mcp/commit/74cd394f266d128b58849725f91acd53f9c2e8c6))

# [0.66.0-beta.19](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.18...v0.66.0-beta.19) (2026-10-17)


### Features

* **models:** pin cache prices, tiers, and price provenance on profile revisions ([#377](https://github.com/bestagentkits/cloud-harness-mcp/issues/377)) ([f4c3643](https://github.com/bestagentkits/cloud-harness-mcp/commit/f4c3643c431858b8a16049f5efce26e1ac98975d))

# [0.66.0-beta.18](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.17...v0.66.0-beta.18) (2026-10-17)


### Features

* **model-gateway:** charge cached, reasoning, and tiered usage conservatively and bound provider-side features ([#374](https://github.com/bestagentkits/cloud-harness-mcp/issues/374)) ([6bba491](https://github.com/bestagentkits/cloud-harness-mcp/commit/6bba4913c409e61fc99741ceb04e45404d68e6fb))

# [0.66.0-beta.17](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.16...v0.66.0-beta.17) (2026-10-17)


### Features

* **models:** provider-first profile wizard that keeps its connection check ([#372](https://github.com/bestagentkits/cloud-harness-mcp/issues/372)) ([c26adef](https://github.com/bestagentkits/cloud-harness-mcp/commit/c26adef53c0e33eaf3ab45882415deb935c932b8))

# [0.66.0-beta.16](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.15...v0.66.0-beta.16) (2026-10-17)


### Features

* **models:** server-side model catalog and runner-side connection verification ([#369](https://github.com/bestagentkits/cloud-harness-mcp/issues/369)) ([5d37e33](https://github.com/bestagentkits/cloud-harness-mcp/commit/5d37e3333d03d8385cfc70af98cf747d58389867)), closes [#355](https://github.com/bestagentkits/cloud-harness-mcp/issues/355)

# [0.66.0-beta.15](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.14...v0.66.0-beta.15) (2026-10-17)


### Bug Fixes

* **model-gateway:** OpenAI output cap field and IPv6 translation address hardening ([#368](https://github.com/bestagentkits/cloud-harness-mcp/issues/368)) ([8a2e791](https://github.com/bestagentkits/cloud-harness-mcp/commit/8a2e7917de35a507b1e91eabc0486a182c5aaeb2))

# [0.66.0-beta.14](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.13...v0.66.0-beta.14) (2026-10-17)


### Bug Fixes

* **models:** refuse custom upstream URLs with userinfo, query, fragment, or unfixed paths ([#365](https://github.com/bestagentkits/cloud-harness-mcp/issues/365)) ([9e7528f](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e7528f278c3c4d2664addfb13fcc8c8823ecd8b)), closes [#362](https://github.com/bestagentkits/cloud-harness-mcp/issues/362)
* **models:** typed provider registry, Gemini OpenAI-compatible endpoint, API-mode compatibility ([#361](https://github.com/bestagentkits/cloud-harness-mcp/issues/361)) ([dbf4d6f](https://github.com/bestagentkits/cloud-harness-mcp/commit/dbf4d6fe66e9659fae32785b208693406aff3fd4)), closes [#354](https://github.com/bestagentkits/cloud-harness-mcp/issues/354)

# [0.66.0-beta.13](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.12...v0.66.0-beta.13) (2026-10-17)


### Bug Fixes

* **dashboard:** HTML-escape dashboard markup instead of the global escape() ([#363](https://github.com/bestagentkits/cloud-harness-mcp/issues/363)) ([c517eb2](https://github.com/bestagentkits/cloud-harness-mcp/commit/c517eb2e1bbccc4aa2cce66fbd46f0ff9299eb4b)), closes [#360](https://github.com/bestagentkits/cloud-harness-mcp/issues/360)
* **deploy:** give the canary network-none fallback its own idempotency key ([#364](https://github.com/bestagentkits/cloud-harness-mcp/issues/364)) ([9a286cc](https://github.com/bestagentkits/cloud-harness-mcp/commit/9a286ccf0249b01d8c78bcca453498c793e80dc0)), closes [#352](https://github.com/bestagentkits/cloud-harness-mcp/issues/352)

# [0.66.0-beta.12](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.11...v0.66.0-beta.12) (2026-10-16)


### Bug Fixes

* **runner:** report lease renewals capped by the hard deadline ([#351](https://github.com/bestagentkits/cloud-harness-mcp/issues/351)) ([ad810ae](https://github.com/bestagentkits/cloud-harness-mcp/commit/ad810aefe993135a5c46e545f9b9453c7586cdb7)), closes [#350](https://github.com/bestagentkits/cloud-harness-mcp/issues/350)

# [0.66.0-beta.11](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.10...v0.66.0-beta.11) (2026-10-16)


### Bug Fixes

* **github:** let issue actions reach pull request numbers ([#348](https://github.com/bestagentkits/cloud-harness-mcp/issues/348)) ([31c8824](https://github.com/bestagentkits/cloud-harness-mcp/commit/31c8824e166eb54e832038b3e6432335bf9b4eac)), closes [#343](https://github.com/bestagentkits/cloud-harness-mcp/issues/343) [#346](https://github.com/bestagentkits/cloud-harness-mcp/issues/346)
* **github:** report pr_merge success when the post-merge lookup fails ([#345](https://github.com/bestagentkits/cloud-harness-mcp/issues/345)) ([669a31f](https://github.com/bestagentkits/cloud-harness-mcp/commit/669a31fff5717a41b9dd19f72e8f3cd874ea0e70)), closes [#342](https://github.com/bestagentkits/cloud-harness-mcp/issues/342) [#344](https://github.com/bestagentkits/cloud-harness-mcp/issues/344)
* **runner:** stop a terminal closed before its shell starts from leaking ([#349](https://github.com/bestagentkits/cloud-harness-mcp/issues/349)) ([55f4983](https://github.com/bestagentkits/cloud-harness-mcp/commit/55f4983d65d9c37ad2e61d6265fec5857a199a0c)), closes [#347](https://github.com/bestagentkits/cloud-harness-mcp/issues/347)

# [0.66.0-beta.10](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.9...v0.66.0-beta.10) (2026-10-15)


### Bug Fixes

* **compose:** stop agent image keepalive from restart-looping ([#341](https://github.com/bestagentkits/cloud-harness-mcp/issues/341)) ([ea417e1](https://github.com/bestagentkits/cloud-harness-mcp/commit/ea417e196decb3fc62ecde1b5ca327ed76da11fe)), closes [#284](https://github.com/bestagentkits/cloud-harness-mcp/issues/284)

# [0.66.0-beta.9](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.8...v0.66.0-beta.9) (2026-10-15)


### Bug Fixes

* **runner:** let auto-close see through linked worktrees and expired agents ([#340](https://github.com/bestagentkits/cloud-harness-mcp/issues/340)) ([c2c3e40](https://github.com/bestagentkits/cloud-harness-mcp/commit/c2c3e400e3bae0cab7c65dbd3aaea86ab642e527))

# [0.66.0-beta.8](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.7...v0.66.0-beta.8) (2026-10-15)


### Features

* **dashboard:** configurable workspace limits, idle TTL and safe auto-close ([#338](https://github.com/bestagentkits/cloud-harness-mcp/issues/338)) ([0badce2](https://github.com/bestagentkits/cloud-harness-mcp/commit/0badce24b36e3b356069226f8589d55f8e8a583f))

# [0.66.0-beta.7](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.6...v0.66.0-beta.7) (2026-10-15)


### Features

* **decision-plane:** advisory semantic routing and failure diagnosis ([#334](https://github.com/bestagentkits/cloud-harness-mcp/issues/334)) ([d4e5226](https://github.com/bestagentkits/cloud-harness-mcp/commit/d4e5226a9cf113457222d7dc9315c7600641ee91)), closes [#217](https://github.com/bestagentkits/cloud-harness-mcp/issues/217) [#331](https://github.com/bestagentkits/cloud-harness-mcp/issues/331) [#332](https://github.com/bestagentkits/cloud-harness-mcp/issues/332) [#336](https://github.com/bestagentkits/cloud-harness-mcp/issues/336)

# [0.66.0-beta.6](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.5...v0.66.0-beta.6) (2026-10-15)


### Features

* **mcp:** MCP Events subscriptions with signed webhook delivery ([#335](https://github.com/bestagentkits/cloud-harness-mcp/issues/335)) ([8f868f7](https://github.com/bestagentkits/cloud-harness-mcp/commit/8f868f7174a094d93c2f968867fe760d53617bcb))

# [0.66.0-beta.5](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.4...v0.66.0-beta.5) (2026-10-15)


### Bug Fixes

* **mcp-gateway:** polish downstream OAuth status handling ([#329](https://github.com/bestagentkits/cloud-harness-mcp/issues/329)) ([f38d48a](https://github.com/bestagentkits/cloud-harness-mcp/commit/f38d48a6d898fb887895506f055fedef92aefcee)), closes [#299](https://github.com/bestagentkits/cloud-harness-mcp/issues/299)

# [0.66.0-beta.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.3...v0.66.0-beta.4) (2026-10-14)


### Features

* **github:** merge-train statuses, Actions runs, review state, and atomic branch leases ([#324](https://github.com/bestagentkits/cloud-harness-mcp/issues/324)) ([8ac2cd6](https://github.com/bestagentkits/cloud-harness-mcp/commit/8ac2cd683353683f499995d685bede8d94e0d15f)), closes [#322](https://github.com/bestagentkits/cloud-harness-mcp/issues/322) [#323](https://github.com/bestagentkits/cloud-harness-mcp/issues/323) [#325](https://github.com/bestagentkits/cloud-harness-mcp/issues/325)

# [0.66.0-beta.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.2...v0.66.0-beta.3) (2026-10-14)


### Features

* **packages:** durable managed toolbox packages with async plans, uninstall, and Dashboard management ([#321](https://github.com/bestagentkits/cloud-harness-mcp/issues/321)) ([de5028b](https://github.com/bestagentkits/cloud-harness-mcp/commit/de5028b8ce64515bcd64d440b33d24f6363f41df)), closes [#319](https://github.com/bestagentkits/cloud-harness-mcp/issues/319) [#320](https://github.com/bestagentkits/cloud-harness-mcp/issues/320)

# [0.66.0-beta.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.66.0-beta.1...v0.66.0-beta.2) (2026-10-13)


### Bug Fixes

* **runner:** bound bash toolbox runs and remove their containers reliably ([edb0d58](https://github.com/bestagentkits/cloud-harness-mcp/commit/edb0d58f8bbbb312d8d4743d741753611165de9c))
* **runner:** report unreadable toolbox state as unavailable and bound cancel waits ([17175e1](https://github.com/bestagentkits/cloud-harness-mcp/commit/17175e18807fc86b5f2e7cf0be1e8f29e35e4189))


### Features

* **runner:** add bash tool with workspace and managed toolbox targets ([46958a4](https://github.com/bestagentkits/cloud-harness-mcp/commit/46958a45c2b4b801ed1d7f5313268b66cb895956))
* **runner:** bash MCP tool with workspace and managed toolbox targets ([#316](https://github.com/bestagentkits/cloud-harness-mcp/issues/316)) ([e940590](https://github.com/bestagentkits/cloud-harness-mcp/commit/e9405900a817fb736000244dc4dda9d7289c2f5c))

# [0.66.0-beta.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.65.0...v0.66.0-beta.1) (2026-10-13)


### Bug Fixes

* **agent:** preserve proxy tool payloads ([da82da9](https://github.com/bestagentkits/cloud-harness-mcp/commit/da82da9576c5eb25f9cba6a9d7e2db354d545ab1))
* **ci:** expose test fixtures to containers ([657e582](https://github.com/bestagentkits/cloud-harness-mcp/commit/657e582e27f10e23802c0d2deb6d9aaa56cab778))
* **ci:** select the checked-in test environment ([24d3d93](https://github.com/bestagentkits/cloud-harness-mcp/commit/24d3d9373c68e55cb3f12affafdacf7bfa718881))
* **dashboard:** show privilege grants by their real status and count only pending ones ([68cf4d7](https://github.com/bestagentkits/cloud-harness-mcp/commit/68cf4d7790ee721c23c8e08a06800608ca47f3cc)), closes [#313](https://github.com/bestagentkits/cloud-harness-mcp/issues/313)
* **dashboard:** title the operator Terminals page as Terminals ([39d00a0](https://github.com/bestagentkits/cloud-harness-mcp/commit/39d00a0dacd4f50b60b9e2921ccd4d03d21a8c4e)), closes [#312](https://github.com/bestagentkits/cloud-harness-mcp/issues/312)
* **runner:** keep workspace activity from shortening a renewed lease ([028d53f](https://github.com/bestagentkits/cloud-harness-mcp/commit/028d53fa8f1a6b0b8a89050db2f15faf47bdab96)), closes [#314](https://github.com/bestagentkits/cloud-harness-mcp/issues/314)
* **terminal:** end a parked terminal read when the dashboard request is cancelled ([b1091fc](https://github.com/bestagentkits/cloud-harness-mcp/commit/b1091fcb8b64986df9f48aae87cc30b53c422ec7)), closes [#312](https://github.com/bestagentkits/cloud-harness-mcp/issues/312)
* **terminal:** keep the workspace alive while a terminal runs and harden session cleanup ([51dcb2c](https://github.com/bestagentkits/cloud-harness-mcp/commit/51dcb2c8d02dd7d593499034c6eadc342dbc5434)), closes [#312](https://github.com/bestagentkits/cloud-harness-mcp/issues/312)


### Features

* **agent:** add Pi coding subagents ([c0b0237](https://github.com/bestagentkits/cloud-harness-mcp/commit/c0b0237b3ebcbada3b95e50f15005f22fe962168))
* **dashboard:** checkpoint terminal BFF and UI work in progress ([e94fe3b](https://github.com/bestagentkits/cloud-harness-mcp/commit/e94fe3b6cf9092e7942015ceaf2099d8606d9d89)), closes [#312](https://github.com/bestagentkits/cloud-harness-mcp/issues/312)
* **dashboard:** real PTY terminal in the workspace executor ([#315](https://github.com/bestagentkits/cloud-harness-mcp/issues/315)) ([04c2921](https://github.com/bestagentkits/cloud-harness-mcp/commit/04c29212697b22acf19e4e57bc747969200d12fd))
* **terminal:** checkpoint runner PTY and dashboard terminal work in progress ([f6ed409](https://github.com/bestagentkits/cloud-harness-mcp/commit/f6ed4090d4ba5c80ae55594936a37f3d8ab0ebb8)), closes [#312](https://github.com/bestagentkits/cloud-harness-mcp/issues/312)

# [0.65.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.64.1...v0.65.0) (2026-10-13)


### Features

* **auth:** manage inbound MCP OAuth session lifetimes from Dashboard Settings ([#303](https://github.com/bestagentkits/cloud-harness-mcp/issues/303)) ([f749863](https://github.com/bestagentkits/cloud-harness-mcp/commit/f74986360702f1a3e084d3e4c27cf55889f697c0)), closes [#282](https://github.com/bestagentkits/cloud-harness-mcp/issues/282) [#304](https://github.com/bestagentkits/cloud-harness-mcp/issues/304)
* **local:** serve multiple persistent local workspaces behind one MCP server ([#307](https://github.com/bestagentkits/cloud-harness-mcp/issues/307)) ([f64a917](https://github.com/bestagentkits/cloud-harness-mcp/commit/f64a917ad12231dc6497d902632575d1fdf2df16)), closes [#283](https://github.com/bestagentkits/cloud-harness-mcp/issues/283)

## [0.64.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.64.0...v0.64.1) (2026-10-13)


### Bug Fixes

* bound repository guidance by the gateway's per-byte input accounting ([#306](https://github.com/bestagentkits/cloud-harness-mcp/issues/306)) ([6acff32](https://github.com/bestagentkits/cloud-harness-mcp/commit/6acff327dc9466a568e45350a8e02177d5dfb3f5))

# [0.64.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.63.3...v0.64.0) (2026-10-13)


### Bug Fixes

* **release:** deploy the tagged release commit so production reports the newest version ([#300](https://github.com/bestagentkits/cloud-harness-mcp/issues/300)) ([ff657c2](https://github.com/bestagentkits/cloud-harness-mcp/commit/ff657c255ec5d19d6417a9354ec356e7f0b98738)), closes [#186](https://github.com/bestagentkits/cloud-harness-mcp/issues/186) [#211](https://github.com/bestagentkits/cloud-harness-mcp/issues/211) [#295](https://github.com/bestagentkits/cloud-harness-mcp/issues/295)
* **release:** skip instead of failing when the branch moved past the CI-tested commit ([#305](https://github.com/bestagentkits/cloud-harness-mcp/issues/305)) ([86e4604](https://github.com/bestagentkits/cloud-harness-mcp/commit/86e4604d2075fbe00ef9ec1ca0dbcbacdf6bdf55)), closes [#302](https://github.com/bestagentkits/cloud-harness-mcp/issues/302)
* **runner:** report an ineligible workspace as CONFLICT when opening agent admission ([#297](https://github.com/bestagentkits/cloud-harness-mcp/issues/297)) ([d941520](https://github.com/bestagentkits/cloud-harness-mcp/commit/d941520f9795b938092dfb82d155b4e73fdee99e)), closes [#263](https://github.com/bestagentkits/cloud-harness-mcp/issues/263)


### Features

* **api-key:** serve the MCP gateway on the managed API-key lane ([#298](https://github.com/bestagentkits/cloud-harness-mcp/issues/298)) ([74639aa](https://github.com/bestagentkits/cloud-harness-mcp/commit/74639aa2ae65f7c9b4c1ec15153334a1ead5e5b1)), closes [#209](https://github.com/bestagentkits/cloud-harness-mcp/issues/209)
* bootstrap repository guidance into managed agent context ([#301](https://github.com/bestagentkits/cloud-harness-mcp/issues/301)) ([2803576](https://github.com/bestagentkits/cloud-harness-mcp/commit/28035766debf4741e270d90efb260957e41a26c7))
* **github:** native PR reviews, review threads, reviewers and merge lifecycle ([#290](https://github.com/bestagentkits/cloud-harness-mcp/issues/290)) ([7aede27](https://github.com/bestagentkits/cloud-harness-mcp/commit/7aede27c5f8b04fa7369998163442e76543eb5b6)), closes [#255](https://github.com/bestagentkits/cloud-harness-mcp/issues/255)
* OAuth-authenticated downstream MCP servers in the Dashboard ([#291](https://github.com/bestagentkits/cloud-harness-mcp/issues/291)) ([364ed96](https://github.com/bestagentkits/cloud-harness-mcp/commit/364ed9698816379baffee5d81bd577cefeb7dfcd))

## [0.63.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.63.2...v0.63.3) (2026-10-13)


### Bug Fixes

* **deploy:** recover a deploy killed after stopping the release, and never downgrade the deploy tooling ([#294](https://github.com/bestagentkits/cloud-harness-mcp/issues/294)) ([9d2764e](https://github.com/bestagentkits/cloud-harness-mcp/commit/9d2764e177ee8007c26e315f4ffbb4d0cf6b7826))

## [0.63.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.63.1...v0.63.2) (2026-10-12)


### Bug Fixes

* **deploy:** run deploys as a detached systemd unit so a dropped SSH session cannot strand a stopped release ([#293](https://github.com/bestagentkits/cloud-harness-mcp/issues/293)) ([9be6315](https://github.com/bestagentkits/cloud-harness-mcp/commit/9be63152544f0793dda8928f7d8e87c4fe880636))

## [0.63.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.63.0...v0.63.1) (2026-10-12)


### Bug Fixes

* **deploy:** build release images before stopping the serving release ([#292](https://github.com/bestagentkits/cloud-harness-mcp/issues/292)) ([639a924](https://github.com/bestagentkits/cloud-harness-mcp/commit/639a9248b14ef7059ce1c9ad2ef38ed308f0a00c))

# [0.63.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.8...v0.63.0) (2026-10-12)


### Bug Fixes

* **deploy:** roll back an interrupted deploy on HUP, INT, TERM and PIPE ([#289](https://github.com/bestagentkits/cloud-harness-mcp/issues/289)) ([4c87277](https://github.com/bestagentkits/cloud-harness-mcp/commit/4c87277712c55dbeec9c1d2c5e48e7c5050bd05a)), closes [#262](https://github.com/bestagentkits/cloud-harness-mcp/issues/262)


### Features

* **mcp:** serve skills over the SEP-2640 Skills extension, including workspace-bound skills ([#288](https://github.com/bestagentkits/cloud-harness-mcp/issues/288)) ([c972f39](https://github.com/bestagentkits/cloud-harness-mcp/commit/c972f393e7f1fc47bc3531a34641ac1d6f56a732))

## [0.62.8](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.7...v0.62.8) (2026-09-29)


### Bug Fixes

* **dashboard:** let skill zip archives upload end to end ([#281](https://github.com/bestagentkits/cloud-harness-mcp/issues/281)) ([ba5e8f8](https://github.com/bestagentkits/cloud-harness-mcp/commit/ba5e8f8b6307050628e06ad0d51fe57420bb7da7))

## [0.62.7](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.6...v0.62.7) (2026-09-28)


### Bug Fixes

* allow skill archive uploads through nginx ([#280](https://github.com/bestagentkits/cloud-harness-mcp/issues/280)) ([a16cd7d](https://github.com/bestagentkits/cloud-harness-mcp/commit/a16cd7dbd0cfc2f8256ac5a78c805a8d75b3f477))

## [0.62.6](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.5...v0.62.6) (2026-09-28)


### Bug Fixes

* **dashboard:** handle failed workspace cockpit state ([#277](https://github.com/bestagentkits/cloud-harness-mcp/issues/277)) ([9317b2d](https://github.com/bestagentkits/cloud-harness-mcp/commit/9317b2d79a6a156227edff0224bba25e7887730c))

## [0.62.5](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.4...v0.62.5) (2026-09-28)


### Bug Fixes

* **dashboard:** prevent navigation rate-limit exhaustion ([a2b1253](https://github.com/bestagentkits/cloud-harness-mcp/commit/a2b12534dbeaf5fdd348c3110f542d81ea08bf65))

## [0.62.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.3...v0.62.4) (2026-09-27)


### Bug Fixes

* **dashboard:** give MCP Servers its own rail page as the MCP Hub ([#275](https://github.com/bestagentkits/cloud-harness-mcp/issues/275)) ([393101a](https://github.com/bestagentkits/cloud-harness-mcp/commit/393101a8dfc7c264538e839d160efddbad70e812))

## [0.62.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.2...v0.62.3) (2026-09-27)


### Bug Fixes

* **dashboard:** let the top bar and rail follow the light theme ([#274](https://github.com/bestagentkits/cloud-harness-mcp/issues/274)) ([ae9840c](https://github.com/bestagentkits/cloud-harness-mcp/commit/ae9840c5299edf9c13e064aa0a825b54cc448543))

## [0.62.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.1...v0.62.2) (2026-09-26)


### Bug Fixes

* **dashboard:** surface MCP Servers at every width; make public sites discoverable ([#273](https://github.com/bestagentkits/cloud-harness-mcp/issues/273)) ([e2d20ab](https://github.com/bestagentkits/cloud-harness-mcp/commit/e2d20ab656e5f032c0050d85ff0195e8d70b8823))

## [0.62.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.62.0...v0.62.1) (2026-09-26)


### Bug Fixes

* **dashboard:** close the Knowledge heading and centre empty-state notes ([#272](https://github.com/bestagentkits/cloud-harness-mcp/issues/272)) ([f78ba3e](https://github.com/bestagentkits/cloud-harness-mcp/commit/f78ba3ec9b577147bf7266fb3ae0bee34e3137f6))

# [0.62.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.61.1...v0.62.0) (2026-09-26)


### Features

* **dashboard:** ops ledger redesign and agents/audit fixes ([#271](https://github.com/bestagentkits/cloud-harness-mcp/issues/271)) ([42520eb](https://github.com/bestagentkits/cloud-harness-mcp/commit/42520ebc0190f2c131ef54daadaa088d889a2f2a))

## [0.61.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.61.0...v0.61.1) (2026-09-24)


### Bug Fixes

* **dashboard:** give GitHub operations their own failure messages ([#261](https://github.com/bestagentkits/cloud-harness-mcp/issues/261)) ([2736e9e](https://github.com/bestagentkits/cloud-harness-mcp/commit/2736e9e78f453691fb89977af0aec457e1838f62))
* **executor:** bundle pinned AgentKit beta CLI ([#265](https://github.com/bestagentkits/cloud-harness-mcp/issues/265)) ([4613733](https://github.com/bestagentkits/cloud-harness-mcp/commit/4613733379813c5a7b612aca166deceea739748a))

# [0.61.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.60.1...v0.61.0) (2026-09-24)


### Features

* **dashboard:** redesign operator console art direction and layout ([#270](https://github.com/bestagentkits/cloud-harness-mcp/issues/270)) ([e927b0b](https://github.com/bestagentkits/cloud-harness-mcp/commit/e927b0bfe8dccffecc667ee2f460a58bd7aeb1be))

## [0.60.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.60.0...v0.60.1) (2026-09-23)


### Bug Fixes

* **deploy:** retry canary discovery on transient connect errors ([#269](https://github.com/bestagentkits/cloud-harness-mcp/issues/269)) ([4562236](https://github.com/bestagentkits/cloud-harness-mcp/commit/4562236c7bbab5dcf4de2743d09df03ebdb36604))

# [0.60.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.59.0...v0.60.0) (2026-09-23)


### Features

* **github:** add read-only history access and configurable clone depth ([#267](https://github.com/bestagentkits/cloud-harness-mcp/issues/267)) ([43d3993](https://github.com/bestagentkits/cloud-harness-mcp/commit/43d39935d3e578480416612572316c324bf8ede7)), closes [#264](https://github.com/bestagentkits/cloud-harness-mcp/issues/264)

# [0.59.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.58.0...v0.59.0) (2026-09-23)


### Features

* **skills:** upload many skills from one archive ([#268](https://github.com/bestagentkits/cloud-harness-mcp/issues/268)) ([7ce872f](https://github.com/bestagentkits/cloud-harness-mcp/commit/7ce872fa8287f7909b01f8bce8ec87d2b0f778e0))

# [0.58.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.57.1...v0.58.0) (2026-09-23)


### Features

* **skills:** version control via metadata.version ([#266](https://github.com/bestagentkits/cloud-harness-mcp/issues/266)) ([9e3094b](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e3094b64ff8b753e9cbcb01a9d1570020c35c98))

## [0.57.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.57.0...v0.57.1) (2026-09-22)


### Bug Fixes

* **runner:** stop aborting startup on an ineligible workspace ([#260](https://github.com/bestagentkits/cloud-harness-mcp/issues/260)) ([09ada6c](https://github.com/bestagentkits/cloud-harness-mcp/commit/09ada6cd1c1c226acb522aaa5976688269e19adb))

# [0.57.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.56.0...v0.57.0) (2026-09-22)


### Features

* **dashboard:** open the skill editor as a dialog instead of a permanent form ([#259](https://github.com/bestagentkits/cloud-harness-mcp/issues/259)) ([f051645](https://github.com/bestagentkits/cloud-harness-mcp/commit/f0516451497d509eb65d56ad4c75973a8daa1e64))

# [0.56.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.55.4...v0.56.0) (2026-09-22)


### Features

* **dashboard:** rebuild the Skills page layout and stop duplicating library rows ([#258](https://github.com/bestagentkits/cloud-harness-mcp/issues/258)) ([4d18809](https://github.com/bestagentkits/cloud-harness-mcp/commit/4d188093cbfd07b75c5fc82bd5522eda8a2afbf7))

## [0.55.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.55.3...v0.55.4) (2026-09-21)


### Bug Fixes

* **dashboard:** render the Files and Runtime tabs inside the cockpit ([#254](https://github.com/bestagentkits/cloud-harness-mcp/issues/254)) ([701a227](https://github.com/bestagentkits/cloud-harness-mcp/commit/701a22786bd99ba182f4cc8a38f23de34aaed5d0))

## [0.55.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.55.2...v0.55.3) (2026-09-21)


### Bug Fixes

* **dashboard:** add the missing agent filters, real cockpit tabs and filtered tile links ([#252](https://github.com/bestagentkits/cloud-harness-mcp/issues/252)) ([d866241](https://github.com/bestagentkits/cloud-harness-mcp/commit/d8662414168d2603eb7bac2c27587746163de508))

## [0.55.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.55.1...v0.55.2) (2026-09-21)


### Bug Fixes

* **config:** consolidate the built-in skills tier onto BUILTIN_SKILLS_ROOT ([#251](https://github.com/bestagentkits/cloud-harness-mcp/issues/251)) ([122092c](https://github.com/bestagentkits/cloud-harness-mcp/commit/122092c1e4c56a294210f51d392ed516f08c0c87))

## [0.55.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.55.0...v0.55.1) (2026-09-21)


### Bug Fixes

* **provenance:** attribute the built-in tier from the catalog the runner mounts ([#243](https://github.com/bestagentkits/cloud-harness-mcp/issues/243)) ([a94708d](https://github.com/bestagentkits/cloud-harness-mcp/commit/a94708d263a9284f4925599b161300079b829dae))

# [0.55.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.54.0...v0.55.0) (2026-09-21)


### Features

* **dashboard:** add the execution health and cost series charts ([#240](https://github.com/bestagentkits/cloud-harness-mcp/issues/240)) ([20ff3ad](https://github.com/bestagentkits/cloud-harness-mcp/commit/20ff3ad2d45d0bb3f13ecad14ddd2924323584dd))
* **toolkits:** mount licensed AgentKit kits as owner skills ([#215](https://github.com/bestagentkits/cloud-harness-mcp/issues/215)) ([14710a6](https://github.com/bestagentkits/cloud-harness-mcp/commit/14710a664a5d986c635cd60a55c27283089029f2))

# [0.54.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.53.0...v0.54.0) (2026-09-21)


### Bug Fixes

* **dashboard:** open resource dialogs from the shell action slot ([#228](https://github.com/bestagentkits/cloud-harness-mcp/issues/228)) ([dbfeeb1](https://github.com/bestagentkits/cloud-harness-mcp/commit/dbfeeb165a6c893fec23d9b5d5d651145e1432be))
* **provenance:** read owner skills from the workspace projection ([#15](https://github.com/bestagentkits/cloud-harness-mcp/issues/15)) ([#226](https://github.com/bestagentkits/cloud-harness-mcp/issues/226)) ([147ce3a](https://github.com/bestagentkits/cloud-harness-mcp/commit/147ce3a88eea2398d949375bf37d006f7c0c1285))


### Features

* **dashboard:** add a contextual Git tab with Finalize as the happy path ([#232](https://github.com/bestagentkits/cloud-harness-mcp/issues/232)) ([1e28330](https://github.com/bestagentkits/cloud-harness-mcp/commit/1e28330992da3a44c306b2e8cf0f07702fdc7b25)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** add decision-useful analytics charts on internal SVG ([#236](https://github.com/bestagentkits/cloud-harness-mcp/issues/236)) ([a932fc5](https://github.com/bestagentkits/cloud-harness-mcp/commit/a932fc54a1baa0b7847ea7ee3e5aa0075b2073c3)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** add the activity center and the approvals inbox ([#234](https://github.com/bestagentkits/cloud-harness-mcp/issues/234)) ([190a2dd](https://github.com/bestagentkits/cloud-harness-mcp/commit/190a2ddc87ad4d123747d9d3dc7a5e050ee463f5)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** add the agent control center with bounded agent adapters ([#230](https://github.com/bestagentkits/cloud-harness-mcp/issues/230)) ([fbaec24](https://github.com/bestagentkits/cloud-harness-mcp/commit/fbaec241852fbd03acf3e062f1dd4c098962c6fa)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** add workspace automation and deployment surfaces ([#233](https://github.com/bestagentkits/cloud-harness-mcp/issues/233)) ([d53b1b8](https://github.com/bestagentkits/cloud-harness-mcp/commit/d53b1b813ee8f9fb94d6a119791c1d136d050f2a))
* **dashboard:** make the overview decision-oriented with server projections ([#235](https://github.com/bestagentkits/cloud-harness-mcp/issues/235)) ([f546415](https://github.com/bestagentkits/cloud-harness-mcp/commit/f5464156f82d468c3faaf439b393072aecc0ec12)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** make workspace detail a cockpit with bounded lifecycle adapters ([#229](https://github.com/bestagentkits/cloud-harness-mcp/issues/229)) ([e74bb65](https://github.com/bestagentkits/cloud-harness-mcp/commit/e74bb6516a68d3725109368c9b3f7f79f43e4cc4))
* **dashboard:** make workspace runtime actionable with tasks, a DAG and bounded sessions ([#231](https://github.com/bestagentkits/cloud-harness-mcp/issues/231)) ([2c2453e](https://github.com/bestagentkits/cloud-harness-mcp/commit/2c2453e1dadba2e22cd33ea339f25ffeb999b54c)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** mark state changes with bounded, collapsible motion ([#237](https://github.com/bestagentkits/cloud-harness-mcp/issues/237)) ([25c5164](https://github.com/bestagentkits/cloud-harness-mcp/commit/25c5164b2aed16c05c49c9c440f609835fd0f3b3)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)
* **dashboard:** share one resource-page layout and move creation into dialogs ([#227](https://github.com/bestagentkits/cloud-harness-mcp/issues/227)) ([320fcb0](https://github.com/bestagentkits/cloud-harness-mcp/commit/320fcb040888b65f2fcfdf5002842a3503bee1d7)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)

# [0.53.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.52.0...v0.53.0) (2026-09-21)


### Features

* **dashboard:** make the page registry the single source for navigation and routing ([f6ecaf7](https://github.com/bestagentkits/cloud-harness-mcp/commit/f6ecaf786f4d9ca1cc6e67199cb827603cad3458)), closes [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220)

# [0.52.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.51.1...v0.52.0) (2026-09-20)


### Features

* **dashboard:** read the registry fields from the records that hold them ([4697da8](https://github.com/bestagentkits/cloud-harness-mcp/commit/4697da86251794cea83a3a9ea79a17a439130750))

## [0.51.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.51.0...v0.51.1) (2026-09-20)


### Bug Fixes

* **dashboard:** make the skills page reachable, and make the plan say what is true ([dd93aee](https://github.com/bestagentkits/cloud-harness-mcp/commit/dd93aee090bfe83288bf859bf268c067fc47c086))
* **runner:** stop interpolating a status allowlist into a statement ([4451602](https://github.com/bestagentkits/cloud-harness-mcp/commit/4451602cb4333c24ddee8e692a54d85230f6aa18))

# [0.51.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.50.0...v0.51.0) (2026-09-20)


### Bug Fixes

* **dashboard:** project skill usage from the shape the reader returns ([0dec32b](https://github.com/bestagentkits/cloud-harness-mcp/commit/0dec32b992e1c6f7be92f649d59a64ce99014823))
* **runner:** run skill scripts as UID 10001 instead of inheriting root ([91b0169](https://github.com/bestagentkits/cloud-harness-mcp/commit/91b0169c8cc0a063b04fd5628f4236d1a26d7a3d))


### Features

* **dashboard:** add a revision when skill instructions are edited ([9e7700e](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e7700ede8948d189b65afa7ff3450851c64201d))
* **dashboard:** drive skill imports from a durable job row ([257e11b](https://github.com/bestagentkits/cloud-harness-mcp/commit/257e11b549a71f4375e4f30e47d4e17210894067))
* **dashboard:** offer catalogue presets as installable suggestions ([fd0e198](https://github.com/bestagentkits/cloud-harness-mcp/commit/fd0e198abcfcedc9731b8faba40d2422d0d90cd7))
* **dashboard:** show where a skill is used and whether it is locked ([bba9b59](https://github.com/bestagentkits/cloud-harness-mcp/commit/bba9b59cbaff3af74cdbb1133257ca39a38b5923))
* **runner:** add the single-skill acquisition seam and build usage rows from text ([a56c241](https://github.com/bestagentkits/cloud-harness-mcp/commit/a56c241a7a7fae9c7df76b23e72ccb5a42c96af5))
* **runner:** fan out skill search to skills.sh and SkillX ([fafcc59](https://github.com/bestagentkits/cloud-harness-mcp/commit/fafcc59f6f5f39812ab180561539fdf2b6c363d6))
* **runner:** run skill scripts in a helper container behind an owner grant ([5cb2a05](https://github.com/bestagentkits/cloud-harness-mcp/commit/5cb2a05726fb35464897786a2973b629218ca49e))

# [0.50.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.49.0...v0.50.0) (2026-09-20)


### Bug Fixes

* **api:** project the fork operation ([68615e8](https://github.com/bestagentkits/cloud-harness-mcp/commit/68615e87fd88a36abfe4d824840906105118a182))
* **contracts:** make the issuer scheme refine total ([f6e2fa7](https://github.com/bestagentkits/cloud-harness-mcp/commit/f6e2fa7893f93aa710085784d8e96a15e86509c9))
* **dashboard:** render the skills library as cards on a phone ([89da338](https://github.com/bestagentkits/cloud-harness-mcp/commit/89da33854e8ca6d1285b11da3cc9873bce832c39))
* **runner:** answer a missing skill record with 404 instead of empty success ([b6ca14f](https://github.com/bestagentkits/cloud-harness-mcp/commit/b6ca14f7c763e0fdcb3ecc5594cc3fcb677992ad))
* **runner:** fail loudly for internal operations without a runner handler ([8840dda](https://github.com/bestagentkits/cloud-harness-mcp/commit/8840dda6ab69cfeb6dbddd17dd24b162fe7bd787))
* **runner:** speak the shape the typesafe endpoint actually accepts ([669565c](https://github.com/bestagentkits/cloud-harness-mcp/commit/669565c289ccf2442b54532bbfb8e3658cede805))


### Features

* **api:** map all twenty-one skills operations for the dashboard ([49a3834](https://github.com/bestagentkits/cloud-harness-mcp/commit/49a383472f765e7e755920d8166d641db1efbcd2))
* **api:** project the typesafe and credential operations ([9e9bc54](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e9bc5423088f3badc58f0a5474c7f2a6691841b))
* **api:** register read routes for skills, skill sets, and imports ([4f56a82](https://github.com/bestagentkits/cloud-harness-mcp/commit/4f56a82e3f796f47e650b684c443786dea2db91c))
* apply skill state changes in bulk with per-item results ([ae648c6](https://github.com/bestagentkits/cloud-harness-mcp/commit/ae648c65e9c879c8103b1cde3ca9861d2de5f5bb))
* **compose:** allow the SkillX API host for registry imports ([31df7c9](https://github.com/bestagentkits/cloud-harness-mcp/commit/31df7c9d8a13905c5ab5fae5c44459a9d0968c3b))
* **contracts:** add NO_EXECUTABLE_ASSETS for instruction-only revisions ([d73d524](https://github.com/bestagentkits/cloud-harness-mcp/commit/d73d5242e88a70b4f0ae89b28ad3f65d662abeb0))
* **contracts:** add registry toolkit arm and skill set launch parameters ([b430e92](https://github.com/bestagentkits/cloud-harness-mcp/commit/b430e923b2a6cc56842b32c44d06429c1d3f2404))
* **contracts:** add STALE_GENERATION as a contract error code ([fb631f9](https://github.com/bestagentkits/cloud-harness-mcp/commit/fb631f9a4942f5febbd8e28b73e0b6d658a83dcf))
* **contracts:** declare the skill registry internal operations ([3efcf41](https://github.com/bestagentkits/cloud-harness-mcp/commit/3efcf4120482892d6fd156603a01a5a5c3621526))
* **contracts:** publish skill_suggest as an MCP tool ([77ba868](https://github.com/bestagentkits/cloud-harness-mcp/commit/77ba8680a9e48196f652dd04381d2b77bea53f45))
* **contracts:** register the typesafe and integration credential operations ([b72cd79](https://github.com/bestagentkits/cloud-harness-mcp/commit/b72cd7943c6635d3dabb73ccd5f6e80851edccb5))
* **contracts:** type the typesafe payloads at the boundary ([2f781d4](https://github.com/bestagentkits/cloud-harness-mcp/commit/2f781d471babf61a332324b4cd950404fa11d58e))
* create a custom skill by publishing its content first ([f44d546](https://github.com/bestagentkits/cloud-harness-mcp/commit/f44d546ed5db64f784412b02fcd17a43ada04902))
* **dashboard:** add the skills library controller with per-item bulk results ([00a677c](https://github.com/bestagentkits/cloud-harness-mcp/commit/00a677cc7de21181c0b96424a8519c5c8d1d3b1d))
* **dashboard:** batch bulk skill changes by generation ([963447b](https://github.com/bestagentkits/cloud-harness-mcp/commit/963447b7bf98f08f1f1627ca8c51250bc74ad9b3))
* **dashboard:** build a skill set pinned to current revisions ([f497fcc](https://github.com/bestagentkits/cloud-harness-mcp/commit/f497fcc060fd003c35f08b2951734fcf43d58c0b))
* **dashboard:** create a custom skill from the editor ([7f10fb9](https://github.com/bestagentkits/cloud-harness-mcp/commit/7f10fb983d9b4d3570e26e7c18388b7845e05dad))
* **dashboard:** gate launch on resolved skill-set conflicts ([82014fb](https://github.com/bestagentkits/cloud-harness-mcp/commit/82014fbabcb03a68dde8f617f76c0065a81aec46))
* **dashboard:** keep the editor draft through validation and conflicts ([6faeb88](https://github.com/bestagentkits/cloud-harness-mcp/commit/6faeb88a85ad29f5bbd86c244c8065ade9121b6e))
* **dashboard:** mount the typesafe panel and document what it sends ([e593f43](https://github.com/bestagentkits/cloud-harness-mcp/commit/e593f43969b97245507419bc61cc46147a48949e))
* **dashboard:** render skills library rows, registry rows, and conflict choices ([4a4fdd5](https://github.com/bestagentkits/cloud-harness-mcp/commit/4a4fdd574f89b53579a75b16b2dc1145ea9e44ba))
* **dashboard:** render the skills page skeleton and reach it from the shell ([8e5e106](https://github.com/bestagentkits/cloud-harness-mcp/commit/8e5e10693ea16f9735ea0a4dc6205033c5c4d7e3))
* **dashboard:** run the library tab end to end ([407310b](https://github.com/bestagentkits/cloud-harness-mcp/commit/407310b32dd158a0b0c4450511d7da0071f32519))
* **dashboard:** select skill sets at launch and drop the dead toolkit grid ([dc1a4c6](https://github.com/bestagentkits/cloud-harness-mcp/commit/dc1a4c669a0350c9ce8277601b51bac469e293de))
* **dashboard:** serve the skills shell route and its navigation entry ([0dee36b](https://github.com/bestagentkits/cloud-harness-mcp/commit/0dee36be6d342046d5da871e65607c66e347a5e6))
* **dashboard:** show revisions and restore from the drawer ([09f6709](https://github.com/bestagentkits/cloud-harness-mcp/commit/09f6709da8dd55e435b4185cc13320f8ae05cb44))
* **dashboard:** submit the skill editor and reload from the server ([4544f89](https://github.com/bestagentkits/cloud-harness-mcp/commit/4544f890b1cf09b878660e73a8699d63a005735f))
* **dashboard:** validate import requests and explain every job outcome ([a4d9268](https://github.com/bestagentkits/cloud-harness-mcp/commit/a4d92686c0ba130c7fb1062150faf7665aec17ad))
* **dashboard:** validate instructions, render diffs with a text alternative, poll imports ([c5c2873](https://github.com/bestagentkits/cloud-harness-mcp/commit/c5c28736584ef4dc3a732112812281446552ec2a))
* **dashboard:** wire the open workspace dialog to skill sets ([93ebd21](https://github.com/bestagentkits/cloud-harness-mcp/commit/93ebd212ef70b5cdf8d9f87308df5c2dbcbdd98b))
* **dashboard:** wire the skill set builder ([145590a](https://github.com/bestagentkits/cloud-harness-mcp/commit/145590a3cd9d9031af118b58a697f1f3c1e22ecb))
* **dashboard:** wire the skills tabs to their own data ([fb8599b](https://github.com/bestagentkits/cloud-harness-mcp/commit/fb8599ba01671724b44ac7753e8390946da217f3))
* **docker:** install the dispatcher as npx and cover the CLI lane in containers ([5af7484](https://github.com/bestagentkits/cloud-harness-mcp/commit/5af7484dfebb16faa455be80214279f7290a30ae))
* list the registry catalogue ([7b1ce22](https://github.com/bestagentkits/cloud-harness-mcp/commit/7b1ce2274b57c7245535ba52f264c82881cb30fa))
* **plugin:** inject a bounded skill hint on prompt submit ([0e2a97f](https://github.com/bestagentkits/cloud-harness-mcp/commit/0e2a97fd040e47dc728c5f5e57ee1c9be74a6baf))
* preview a skill set through the resolver ([9e1f88a](https://github.com/bestagentkits/cloud-harness-mcp/commit/9e1f88ac18c624190d6f8aeff995b1950ab883d2))
* restore a skill revision by republishing its bytes ([be86181](https://github.com/bestagentkits/cloud-harness-mcp/commit/be86181a3ee16a765847bc0c79a197c331fafcc4))
* **runner:** add a bounded line diff for two skill revisions ([77b5bdb](https://github.com/bestagentkits/cloud-harness-mcp/commit/77b5bdb01a66d1395df581a9bd5362f82b673797))
* **runner:** add deterministic 4-tier skill resolution ([4fcb82a](https://github.com/bestagentkits/cloud-harness-mcp/commit/4fcb82ac833b319748f2695192f65f0df97d6c85))
* **runner:** add skill registry schema at state schema version 11 ([e9a0dd3](https://github.com/bestagentkits/cloud-harness-mcp/commit/e9a0dd3d21b64c5122584aa7a9b36a42abbe04d1))
* **runner:** add skills.sh and SkillX registry adapters ([79b2f18](https://github.com/bestagentkits/cloud-harness-mcp/commit/79b2f18c9ddefee5977e9c6162751abecc6ad235))
* **runner:** add the integration credential tables ([94fd810](https://github.com/bestagentkits/cloud-harness-mcp/commit/94fd8107bbc1092e1c840ce5b6de922aed29a9a6))
* **runner:** add the skill registry repository to StateStore ([424569b](https://github.com/bestagentkits/cloud-harness-mcp/commit/424569bbffe4a121381564ec645ab5bbe94d9bdb))
* **runner:** add the typesafe suggestion engine ([dd71621](https://github.com/bestagentkits/cloud-harness-mcp/commit/dd7162158bb3ffcae24eecd22bcdd7b92156b7f4))
* **runner:** audit every suggestion with scalars only ([efea457](https://github.com/bestagentkits/cloud-harness-mcp/commit/efea4572e9b0bb446635a7ff68928c9e42e7808d))
* **runner:** diff and fork skill revisions ([fd34446](https://github.com/bestagentkits/cloud-harness-mcp/commit/fd3444668e86e0abd83d0000fd32e714ba18b756))
* **runner:** hold every typesafe question, threshold, and bound in one module ([ca61cd5](https://github.com/bestagentkits/cloud-harness-mcp/commit/ca61cd5a61693678dec62b3a50b6ffacc3cbf377))
* **runner:** pass workspace skill overrides into owner toolkit projection ([2766ff0](https://github.com/bestagentkits/cloud-harness-mcp/commit/2766ff07af35d9c98c8e9d3a56b9241f88d5bff5))
* **runner:** publish a locally produced bundle into the toolkit cache ([1f08810](https://github.com/bestagentkits/cloud-harness-mcp/commit/1f08810c6155f90ee1563225b76ae041f49051d8))
* **runner:** quarantine toolkit bundles that fail digest verification ([6e47d30](https://github.com/bestagentkits/cloud-harness-mcp/commit/6e47d303d944a05e77121c7a60f528b5b8f61200))
* **runner:** rank a workspace roster through the suggestion engine ([39abfa8](https://github.com/bestagentkits/cloud-harness-mcp/commit/39abfa815ec823092f3a62d1665eebdc74156d2b))
* **runner:** read the skill roster from the workspace that owns it ([d6423a9](https://github.com/bestagentkits/cloud-harness-mcp/commit/d6423a92821cf4b016c6f418c53d98c03585ae97))
* **runner:** resolve registry toolkits through the toolkit pipeline ([3e4df30](https://github.com/bestagentkits/cloud-harness-mcp/commit/3e4df30930e06a039e83eb19e1a9464f9b4d17f4))
* **runner:** serve the integration credential and typesafe operations ([6943031](https://github.com/bestagentkits/cloud-harness-mcp/commit/6943031c19873af14b8969d1bfa9e8cbd06654c0))
* **runner:** serve the read-only skill and skill set operations ([b8d3274](https://github.com/bestagentkits/cloud-harness-mcp/commit/b8d32742be16b303669c47888863453dc152622b))
* **runner:** store integration credentials behind the keyring envelope ([5d7aabc](https://github.com/bestagentkits/cloud-harness-mcp/commit/5d7aabc29a0157e37712914ac3b0e4be08c26a93))
* **scripts:** verify typesafe live and record what the endpoint actually accepts ([ba71872](https://github.com/bestagentkits/cloud-harness-mcp/commit/ba718727b2e86112f81daae7cf2dde2554df3eb1))
* serve a single skill revision ([d7c578b](https://github.com/bestagentkits/cloud-harness-mcp/commit/d7c578baf2c5f158d4221411f5c73819c73cf7ce))
* serve skill search over the local registry ([fb0068b](https://github.com/bestagentkits/cloud-harness-mcp/commit/fb0068b53e94ca465e4c823ccc3ea92b4d243262))
* wire the skill and skill set mutations through runner and API ([cee9f7b](https://github.com/bestagentkits/cloud-harness-mcp/commit/cee9f7ba262845bf057991598b93e059f32ce57b))
* **worker:** add the offline skills, skillx, and npx compatibility launchers ([9154c93](https://github.com/bestagentkits/cloud-harness-mcp/commit/9154c93950f5c2a50f823e33547f23c2d35b1b48))
* **worker:** expose a bounded skill roster for the suggester ([c19f055](https://github.com/bestagentkits/cloud-harness-mcp/commit/c19f055fd3f1ab91eb2fd22c8b0c74b92c459dc0))
* **worker:** name the execution mode and the instruction-only revision case ([9a1a066](https://github.com/bestagentkits/cloud-harness-mcp/commit/9a1a066ea5f1efcd32d3b15ea03d7095152f7621))

# [0.49.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.48.0...v0.49.0) (2026-09-20)


### Features

* **workspace:** support concurrent workspaces per owner ([#216](https://github.com/bestagentkits/cloud-harness-mcp/issues/216)) ([86702e4](https://github.com/bestagentkits/cloud-harness-mcp/commit/86702e4be94ccf5e61e10ab299f7cf7111eb9e41))

# [0.48.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.47.3...v0.48.0) (2026-09-16)


### Features

* **deploy:** log the effective network posture in the canary ([#203](https://github.com/bestagentkits/cloud-harness-mcp/issues/203)) ([435a5ce](https://github.com/bestagentkits/cloud-harness-mcp/commit/435a5ce71106b76f51bf13458f525d3e2ad11e5c))

## [0.47.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.47.2...v0.47.3) (2026-09-16)


### Bug Fixes

* **model-gateway:** accept hostname upstreams when applying profile snapshots ([#212](https://github.com/bestagentkits/cloud-harness-mcp/issues/212)) ([1080bfe](https://github.com/bestagentkits/cloud-harness-mcp/commit/1080bfec69182600a8369e327982d2fe4de15104))

## [0.47.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.47.1...v0.47.2) (2026-09-16)


### Bug Fixes

* **model-gateway:** identify the client and send a provider session header ([#213](https://github.com/bestagentkits/cloud-harness-mcp/issues/213)) ([b9bca39](https://github.com/bestagentkits/cloud-harness-mcp/commit/b9bca3953bf2fa278e1f71cfbedbd35fa97e9f96))

## [0.47.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.47.0...v0.47.1) (2026-09-16)


### Bug Fixes

* **runner:** carry contents: read on brokered GitHub tokens ([#214](https://github.com/bestagentkits/cloud-harness-mcp/issues/214)) ([b1de215](https://github.com/bestagentkits/cloud-harness-mcp/commit/b1de215f9420c68904f076b04dd8f24a385bcf25))

# [0.47.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.46.1...v0.47.0) (2026-09-15)


### Bug Fixes

* expose Zod validation messages for dashboard secret errors ([#201](https://github.com/bestagentkits/cloud-harness-mcp/issues/201)) ([d70c2bc](https://github.com/bestagentkits/cloud-harness-mcp/commit/d70c2bc510ec7a139fb9ee1460898edfa3b49ca6))


### Features

* **deploy:** exercise the egress default in the canary with a safe fallback ([#200](https://github.com/bestagentkits/cloud-harness-mcp/issues/200)) ([c3ca60b](https://github.com/bestagentkits/cloud-harness-mcp/commit/c3ca60bbab5db76b5dccbf078a3d2fd5d9cc9571)), closes [#199](https://github.com/bestagentkits/cloud-harness-mcp/issues/199)

## [0.46.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.46.0...v0.46.1) (2026-09-14)


### Bug Fixes

* **runner:** make the settings audit trail and credential source honest ([74ba948](https://github.com/bestagentkits/cloud-harness-mcp/commit/74ba948dfa4955d41d449f2b509ca5ee48f43796))

# [0.46.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.45.0...v0.46.0) (2026-09-14)


### Bug Fixes

* **api:** stop advertising the retired networkMode field ([0fdef1f](https://github.com/bestagentkits/cloud-harness-mcp/commit/0fdef1fb27ce6c89f812588fdd3e8e9dd30e97a6))
* **github:** keep GitHub's own rejection detail on a denied token mint ([b59a0a8](https://github.com/bestagentkits/cloud-harness-mcp/commit/b59a0a8ded4080ad19532a79261cb2cb84a182ae))
* **github:** name the remedy when the helper reports a permission failure ([da9fe3e](https://github.com/bestagentkits/cloud-harness-mcp/commit/da9fe3e7a51b110c2018403a04e83d40ef25cbcc))
* **github:** use a credential that can satisfy each brokered action ([30bbce4](https://github.com/bestagentkits/cloud-harness-mcp/commit/30bbce49a34dbb72b15a4ad91d862cb5b29ffc02))


### Features

* **workspace:** default to egress-capable workspaces with dashboard settings ([603322d](https://github.com/bestagentkits/cloud-harness-mcp/commit/603322d9ce72d14c6284b0b58a37bc52aa9f7469))

# [0.45.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.44.0...v0.45.0) (2026-09-14)


### Bug Fixes

* **dashboard:** drop dead tokens, harden the primary variant, pin review findings ([fd4bf4d](https://github.com/bestagentkits/cloud-harness-mcp/commit/fd4bf4d7ebc0cb0ec250f35b982a83dc6b03e790))


### Features

* **dashboard:** adopt the marketing HUD design system and repair UI/UX defects ([b8ff0ca](https://github.com/bestagentkits/cloud-harness-mcp/commit/b8ff0ca8678b1de9e90b52aeceac253d694b01c2)), closes [#193](https://github.com/bestagentkits/cloud-harness-mcp/issues/193)
* **github:** fall back to operator GH_TOKEN/GITHUB_TOKEN credentials ([1e070b7](https://github.com/bestagentkits/cloud-harness-mcp/commit/1e070b7010109a6ec64d38b58ff18d533cede1a0))

# [0.44.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.43.0...v0.44.0) (2026-09-14)


### Features

* **site:** add light theme and icon theme toggle (system/light/dark) ([07a5fc7](https://github.com/bestagentkits/cloud-harness-mcp/commit/07a5fc7042c7223967aae8ad11157670fcac567d)), closes [hi#contrast](https://github.com/hi/issues/contrast)

# [0.43.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.42.0...v0.43.0) (2026-09-14)


### Bug Fixes

* **mcp:** hold the connection slot for the whole downstream call ([3a1c936](https://github.com/bestagentkits/cloud-harness-mcp/commit/3a1c9362d46ba9b1d7182a92e16995f88f39f9e0))
* **mcp:** resolve PR review findings for the gateway ([8b00cd1](https://github.com/bestagentkits/cloud-harness-mcp/commit/8b00cd1f3f3f6f067346507cde2205a0bf66db78))


### Features

* **mcp:** add MCP gateway with progressive tool disclosure ([f90143f](https://github.com/bestagentkits/cloud-harness-mcp/commit/f90143f9af3ec2447c2e9f37cea77d0b2bf093ab)), closes [#188](https://github.com/bestagentkits/cloud-harness-mcp/issues/188)

# [0.42.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.41.0...v0.42.0) (2026-09-14)


### Features

* **site:** add favicon and social/SEO meta tags; center telemetry bar and add mobile/tablet loop marquee ([d985e98](https://github.com/bestagentkits/cloud-harness-mcp/commit/d985e9810c709de920863502328687db334166e3))

# [0.41.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.40.0...v0.41.0) (2026-09-14)


### Features

* **dashboard:** editable profile name, icon sign-out, footer, fixed nav rail ([e651e90](https://github.com/bestagentkits/cloud-harness-mcp/commit/e651e9074d60044354c9946951a74c79d71965ba))

# [0.40.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.39.4...v0.40.0) (2026-09-13)


### Bug Fixes

* **dashboard:** make the palette refresh lifecycle correct and testable ([ca42809](https://github.com/bestagentkits/cloud-harness-mcp/commit/ca428098ac89aff17fb05a1023d0fdc7049059c0)), closes [#178](https://github.com/bestagentkits/cloud-harness-mcp/issues/178)


### Features

* **dashboard:** add sidebar version, theme icon, and CMD+K palette ([bf1b6a8](https://github.com/bestagentkits/cloud-harness-mcp/commit/bf1b6a82faa4549e58c5dd17771c54545fdd6999))

## [0.39.4](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.39.3...v0.39.4) (2026-09-13)


### Bug Fixes

* **deploy:** send networkProfile in the canary and production verification ([e1011c1](https://github.com/bestagentkits/cloud-harness-mcp/commit/e1011c15db4c7272192639b75d9e34cf940a2e32)), closes [#181](https://github.com/bestagentkits/cloud-harness-mcp/issues/181)

## [0.39.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.39.2...v0.39.3) (2026-09-13)


### Bug Fixes

* **auth:** gate the missing-key cache on a completed key document ([d951767](https://github.com/bestagentkits/cloud-harness-mcp/commit/d951767b2416e754726781d76bf6d6f3adee9503))

## [0.39.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.39.1...v0.39.2) (2026-09-13)


### Bug Fixes

* **auth:** retry the Access key document after an outage ([a89f74d](https://github.com/bestagentkits/cloud-harness-mcp/commit/a89f74df73fddb9f57ae79cf58836a6d3716634a)), closes [#176](https://github.com/bestagentkits/cloud-harness-mcp/issues/176)

## [0.39.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.39.0...v0.39.1) (2026-09-13)


### Bug Fixes

* **dashboard:** diagnose Cloudflare Access assertion rejections ([31dc776](https://github.com/bestagentkits/cloud-harness-mcp/commit/31dc776e0b76f6c764f547ee2fc5c71d335e09ff)), closes [#176](https://github.com/bestagentkits/cloud-harness-mcp/issues/176)
* **review:** bound the rejection log path and pin the log contract ([291b4e8](https://github.com/bestagentkits/cloud-harness-mcp/commit/291b4e8d56e8d328592407346d2f9ec1358b8ed4))

# [0.39.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.38.1...v0.39.0) (2026-09-06)


### Bug Fixes

* **mcp:** enrich github_action tool description to expose discoverable issueCreate capability ([#174](https://github.com/bestagentkits/cloud-harness-mcp/issues/174)) ([#175](https://github.com/bestagentkits/cloud-harness-mcp/issues/175)) ([9058b9f](https://github.com/bestagentkits/cloud-harness-mcp/commit/9058b9fd6e11482a549304d4a726da0b8741b0f5))


### Features

* **knowledge:** memories, journals, hybrid search, knowledge graph, dashboard editor & MCP tools ([#173](https://github.com/bestagentkits/cloud-harness-mcp/issues/173)) ([b104cb1](https://github.com/bestagentkits/cloud-harness-mcp/commit/b104cb13ed03959a2b428fb4a33c2f9e771228a5))

## [0.38.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.38.0...v0.38.1) (2026-08-31)


### Bug Fixes

* **docs-site:** render MarkdownActions in doc-before slot to prevent right sidebar TOC overlap ([#170](https://github.com/bestagentkits/cloud-harness-mcp/issues/170)) ([63d18ca](https://github.com/bestagentkits/cloud-harness-mcp/commit/63d18ca889b39ea138f5f510993efa1a16e0554f))

# [0.38.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.37.2...v0.38.0) (2026-08-31)


### Bug Fixes

* **runner:** export referenced revisions on gateway restart and block deletion while active leases exist ([1b80bbc](https://github.com/bestagentkits/cloud-harness-mcp/commit/1b80bbc19a6802f0823429fc71acf04bf07a2b12))
* **runner:** implement automatic gateway rehydration and ensureGatewaySynced on spawn ([3f85c35](https://github.com/bestagentkits/cloud-harness-mcp/commit/3f85c3529f53b530ed836b626e632f9e0d0567a7))
* **runner:** store credential_id in immutable revisions and strictly resolve in gateway ([9938e6b](https://github.com/bestagentkits/cloud-harness-mcp/commit/9938e6bcfe93034b3d28ce93e4a6a946518298be))
* **security:** enforce strict rejectUnauthorized true and inject test CA via config dependency ([25740d7](https://github.com/bestagentkits/cloud-harness-mcp/commit/25740d7745a6b551dd91c65d04f68a274c379902))


### Features

* **dashboard:** add subagent model profiles, credentials, and dynamic gateway readiness ([9059ad5](https://github.com/bestagentkits/cloud-harness-mcp/commit/9059ad552114940e45a400b9e7b355f0a9b2ca61))
* **gateway:** support responses mode and verify real TLS proxy routing ([d0a7271](https://github.com/bestagentkits/cloud-harness-mcp/commit/d0a72710bc3a8e723ad7acab3fbfe651ac4ee245))
* **runner:** wire dynamic profile resolution, gateway sync, and end-to-end spawn ([24f9fb5](https://github.com/bestagentkits/cloud-harness-mcp/commit/24f9fb5b37f2bd820e708aff34f001363b4038c0))

## [0.37.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.37.1...v0.37.2) (2026-08-31)


### Bug Fixes

* **deploy:** install service-compose and reload systemd unit after checkout and rollback ([#167](https://github.com/bestagentkits/cloud-harness-mcp/issues/167)) ([c04c3cf](https://github.com/bestagentkits/cloud-harness-mcp/commit/c04c3cf5a53ac940a352778cce752158aa40b212))

## [0.37.1](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.37.0...v0.37.1) (2026-08-31)


### Bug Fixes

* **docs-site:** handle clipboard and markdown fetch failures gracefully in MarkdownActions ([#166](https://github.com/bestagentkits/cloud-harness-mcp/issues/166)) ([f865b73](https://github.com/bestagentkits/cloud-harness-mcp/commit/f865b7365cf3a2ff634e47600c683ed4434461c2))

# [0.37.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.36.0...v0.37.0) (2026-08-31)


### Features

* **docs-site:** replace static twin hints with interactive Copy as Markdown component and action dropdown ([#164](https://github.com/bestagentkits/cloud-harness-mcp/issues/164)) ([124e50f](https://github.com/bestagentkits/cloud-harness-mcp/commit/124e50f4d1e60c60b0c715cd7309d7339fc67031))

# [0.36.0](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.35.3...v0.36.0) (2026-08-31)


### Features

* **deploy:** 1-click OSS installer, Caddy/Tunnel ingress pipeline, and multi-tenant isolation ADR ([#135](https://github.com/bestagentkits/cloud-harness-mcp/issues/135)) ([51030c8](https://github.com/bestagentkits/cloud-harness-mcp/commit/51030c84cd646ca25b919d38c252eac26fd5aff0))

## [0.35.3](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.35.2...v0.35.3) (2026-08-31)


### Bug Fixes

* **provenance:** enforce trusted scan partitions and eliminate worker-asserted source promotion ([#15](https://github.com/bestagentkits/cloud-harness-mcp/issues/15)) ([a9fd7c9](https://github.com/bestagentkits/cloud-harness-mcp/commit/a9fd7c94a6c1e2bd5c314b3dbd5ded257e2fd5d1))

## [0.35.2](https://github.com/bestagentkits/cloud-harness-mcp/compare/v0.35.1...v0.35.2) (2026-08-31)


### Bug Fixes

* **provenance:** enforce trusted scan partitions and harden memory/hook isolation ([#15](https://github.com/bestagentkits/cloud-harness-mcp/issues/15)) ([bc0bc19](https://github.com/bestagentkits/cloud-harness-mcp/commit/bc0bc1906e7222c159f0f3700ce6aea16a8d5e99))


### Reverts

* emergency revert bc0bc19 to restore main schema and toolkit state ([a6af9cc](https://github.com/bestagentkits/cloud-harness-mcp/commit/a6af9cc1172c177e54b2caa8170f99172db436b0))

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
