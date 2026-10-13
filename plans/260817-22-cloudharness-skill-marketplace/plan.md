# Cloud Harness skill and marketplace correction

Status: complete

## Outcome

Ship a self-contained `cloudharness` skill with useful end-user references,
portable installation, and validated Claude/OpenAI plugin packaging without
misrepresenting the private bearer-authenticated MCP service as a public
multi-user integration.

## Constraints and non-goals

- Preserve the private, single-owner execution threat model.
- Do not embed tokens, integration IDs, or machine-specific paths.
- Do not add OAuth, tenancy, or public service operations in this correction.
- Installed skill files must not depend on repository docs or source files.

## Phases

1. [Complete](phase-01-skill-and-contract.md): replace the source-coupled
   skill, improve MCP metadata, and add contract tests.
2. [Complete](phase-02-packaging-and-guidance.md): package Claude/OpenAI plugin
   artifacts, add README installation guidance, and publish static policy pages.
3. [Complete](phase-03-validation.md): validate skills, manifests, pages, tests,
   and the repository gate; complete independent review.

## Acceptance criteria

- Every public operation is documented exactly once with inputs, defaults,
  limits, side effects, and recovery notes.
- All skill-relative links resolve within the installed skill bundle; no skill
  file references `docs/`, `packages/`, `apps/`, `worker/`, or other repo paths.
- `npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness` is in
  the README.
- Claude and OpenAI manifests pass their available validators and package the
  same skill content.
- README distinguishes skill installation, bearer MCP connection, and the
  OAuth requirement for a public hosted marketplace MCP listing.
- Focused tests and `npm run verify` pass.
