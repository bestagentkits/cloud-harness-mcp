---
title: Skills & Skill Sets
description: Managing the skill library, provider imports, skill sets, and the toolkit registry.
---

# Skills & Skill Sets

A skill is a directory of instructions — and optionally scripts — that an agent can use inside a
workspace. The **Skills** page under Configuration is the single surface for everything that manages
them: the library, provider discovery, skill sets, and the toolkit registry.

## The library

The Library tab lists the skills this owner can use, with the provider and tier each came from and the
current state. Narrow the list with the search field; the filter runs locally, so typing does not send
the text anywhere.

Select rows to reveal the bulk bar. **Archive** and **Disable** apply per item, which means a row the
runner refuses — because it changed since the page loaded, or because a set still references it — stays
selected and reports its blocker while the rows that could be changed are changed. The table reloads
from the runner afterwards rather than patching the row locally, because the runner is authoritative
about what actually changed.

Opening a skill shows its revisions, each labelled with the origin that produced it. **Restore**
publishes the chosen revision as a *new* revision pointing at the same content: existing revision rows
are immutable, so history is append-only and a restore never rewrites what happened.

**Create a custom skill** writes the instructions into the runner's package cache first and records the
source second. That order matters: a source row written first would resolve and then fail at launch,
because the bytes it names would not exist.

### Editing existing instructions

The editor creates skills. Changing the instructions of a skill that already exists would need a new
revision, and the runner has no operation for that yet, so the page does not offer it rather than
appearing to edit content while only changing metadata.

## Discovery and imports

The Discover tab searches the local registry and prepares provider imports: the source, the source
kind, and an optional pinned commit. The source kind is what the runner accepts — an imported skill
always lands in the owner tier — and a ref must be a full 40 or 64 character hexadecimal commit id,
because a branch name would be refused after the wizard claimed to accept it.

Starting an import needs a runner operation that does not exist yet, so the wizard's submit is
deliberately not wired. Validation, review, and guidance are in place and tested; the guidance names
the `CACHE_MISS` remedy in its own sentence, because that failure has an exact fix.

## Skill sets

A set is a named selection of skills pinned to the exact revision each member had when the set was
built. Pinning matters: a set that stored names would silently change meaning when a skill was updated.

Sets are selected when launching a workspace. Because the same skill name can exist at several tiers,
launching can produce a conflict, and the dialog resolves it with a radio choice per conflict. Launch
stays disabled until every conflict has an override, which is the same rule the resolver applies — the
dialog cannot offer a launch the runner would then refuse.

## Registry

The Registry tab shows, for each toolkit and registry entry, its cache state, pinned commit, skill
count, and lock state. It reads the runner's catalogue. Enabling, disabling, and pinning entry state
needs a runner operation that does not exist yet, so those controls are not offered.

## How skills execute

Skill scripts run from a snapshot under `/tmp/cloud-harness-exec/<runId>`, after the full-tree bundle
digest and the script digest are verified against what the caller expected. The snapshot is made
read-only before execution, and it is what runs — not a second read of the original path — so a file
that changes between verification and execution cannot change what runs. A skill revision that carries
instructions but no scripts is refused with `NO_EXECUTABLE_ASSETS` rather than a generic miss, and the
result reports `executionMode` so a caller cannot read a stronger isolation guarantee into a run than
the run had.

Workspace and repository skills live on the mutable working tree, so they remain repository-controlled
executable content. The owner tier is where to install a skill that must not be re-pointable by a
repository.

## Related

- [Workspaces](/dashboard/workspaces) — selecting skill sets when a workspace launches.
- [Security Model](/security-model) — where skill bytes come from and how they are verified.
- [Artifacts](/dashboard/artifacts) — durable output, including what a skill run produced.
