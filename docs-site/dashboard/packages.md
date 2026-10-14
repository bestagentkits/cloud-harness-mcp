---
title: Packages
description: Managed toolbox packages, their health, applies, and rollback.
---

# Packages

`/dashboard/packages` shows the **managed toolbox packages** agents have installed for
you: CLI tools built into immutable, verified releases and mounted read-only into new
workspaces. Agents plan and apply them with the package tools; you approve plans on the
[Approvals](/dashboard/approvals) page and watch or roll back the result here.

::: info Off by default
Managed packages are off. Operators enable them with `PACKAGES_ENABLED=true`. While the
feature is off the page says so and offers no actions. The related settings are listed in
the [environment variables reference](/reference/environment-variables).
:::

## The summary row

Four tiles state what you have and what is waiting:

- **Installed**: bindings in use against the `PACKAGES_MAX_BINDINGS` quota. A binding is
  one package in one scope.
- **Disk used**: bytes held by verified releases against the per-owner quota.
- **Applies running**: builds in progress.
- **Plans waiting**: plans that still need your decision. The tile links to Approvals.

The note above the tiles states the approval mode, the enabled ecosystems, whether npm
lifecycle scripts may run, and the per-release size limit.

## Applies

An apply moves through **Queued**, **Building**, **Verifying**, and **Publishing**, and
the current step is highlighted. Finished applies stay listed as **Succeeded** or
**Failed**. A failure shows its error code and message. Builder output is never shown
here.

## Installed packages

Each installed package shows:

- its name, the active version, the ecosystem, and the scope. **Owner** scope reaches every
  workspace; **Workspace** scope reaches one.
- its health:
  - **Verified**: the release tree is on disk and matches its digest.
  - **Missing on disk**: the runner found the directory gone. New workspaces start without
    the tool until it is re-applied or rolled back.
  - **Stale image**: the release was built against an older executor image. Re-plan and
    apply to rebuild it.
- the active release, generation, disk usage and file count, dependency count, binaries,
  source, tree digest, runtime versions, the number of affected workspaces, and when it
  was installed.
- a risk note when the release was built with npm lifecycle scripts enabled.

The **history** table lists up to five previous releases, with the generation, whether
each came from an apply or a rollback, and whether an agent or the Dashboard made it.

## Rolling back

**Roll back to *version*** appears on a history row whose release is still verified and on
disk. The current release and releases that are no longer available offer no rollback.

Rolling back is destructive, so it asks for confirmation. The confirmation names:

- the version you leave and the version you return to;
- how many workspaces are affected;
- the expected generation.

Workspaces created or recreated afterwards get the older release. Running workspaces keep
their current tools until they are recreated.

The runner refuses the rollback when:

- the package changed after the page loaded (the generation moved);
- an apply for the package is in progress;
- the target release left the disk;
- its binaries would collide with another package.

Reload the page and decide again. Every rollback is audited with the Dashboard as the
actor. Rollback needs no approval, because the target release was already approved and
verified.
