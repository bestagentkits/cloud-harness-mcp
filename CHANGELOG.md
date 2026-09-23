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
