---
title: Agent Policies
description: Decide what coding agents may do, per instance and per project, and test it before saving.
---

# Agent Policies

An agent policy decides whether an agent action is allowed, needs your
approval, or is denied. You write one **global** policy and, when a project
needs tighter rules, a **project** policy that narrows it.

::: info Enforcement arrives with the coding broker
This release stores, checks and simulates policies. It does not yet stop or
hold a running agent's actions: that enforcement arrives with the coding
broker, which uses the same evaluator as the simulation. Until then a saved
policy changes what **Simulate an action** returns, not what agents do.
:::

- **Settings > Agent policies** (`/dashboard/settings/agent-policies`) edits the
  global policy and lists every project that has its own.
- **Project > Agent policies** (`/dashboard/projects/<id>/agent-policies`)
  edits one project's policy. Open a project and use **Agent policies** in the
  page header.

Both pages are always reachable. Editing, checking and simulating need the
runner to run with `AGENT_POLICIES_ENABLED=true`; while it is off, the page
shows how to turn it on and the runner refuses every policy operation. See
[environment variables](/reference/environment-variables).

## What a policy controls

Every agent action has a class: **Read**, **Edit files**, **Run tests**,
**Local git**, **Publish branch**, **Open pull request**, **Network** and
**Install packages**. For each class the global policy sets:

- **Allowed**: whether agents may perform the class at all.
- **Hard deny**: always denied. Nothing, including a project or an advisor, can
  lift it.
- **Mandatory approval**: always waits for your approval.
- **Default effect**: **Allow**, **Require approval**, or **Advisor or
  approval**. With no advisor configured, **Advisor or approval** waits for
  your approval (see [Execution-risk advisor](#execution-risk-advisor)).
- **Projects may choose**: lets a project policy pick this class's effect. On a
  class with no default effect it saves **Require approval** as the default,
  which projects may then change.

The policy also sets the scope agents work in (repositories, branch prefixes
for publishing, paths, commands, packages, registries and network hosts), per
run budgets, and how long an approval request stays open. Until you save a
global policy, a read-only default applies that allows only **Read**.

A command scope entry is a prefix match on the command's arguments, word by
word. `npm test` admits `npm test` and `npm test -- --watch`, but a bare
program name such as `git` admits every git subcommand, and `*` admits any
command.

Some actions are denied whatever the policy says: access to credentials or the
Docker socket, network escalation, privilege escalation, and paths outside the
workspace.

## Execution-risk advisor

The **Execution-risk advisor** section lets TypeSafe Jev clear routine
**Advisor or approval** actions so you are asked only about the risky ones. It
needs three things:

1. Your TypeSafe key, stored in [TypeSafe](/dashboard/typesafe).
2. The operator listing `execution-risk` in `DECISION_PLANE_PURPOSES` (see
   [environment variables](/reference/environment-variables)).
3. **Let the advisor clear Advisor or approval actions** ticked in the global
   policy.

Without all three, nothing is sent to TypeSafe. Every **Advisor or approval**
action then waits for you, or is denied if the policy enables the advisor and
its fallback is **Deny**.

Jev is asked only about an action that already passed every other check, and
it receives a summary of counts and categories, not your paths, commands,
branch or repository names. When a command declared as another class runs
`git push`, Jev is told it is a publish. It answers with a risk score and how
confident it is. The action runs without you only when the risk is below
**Escalate at risk** and the confidence is at least **Minimum confidence**.
Otherwise it waits for you, or is denied if the fallback is **Deny** and Jev
could not give a confident answer. A confident "this is risky" always waits
for you; it is never a deny.

An action that touches a CI or workflow file (`.github/`, `.gitlab-ci.yml`,
`.circleci/` at the repository root) or a dependency manifest or lockfile
(such as `package.json`, `package-lock.json`, `poetry.lock` or `go.mod`, at any
depth) is never left to Jev. Nothing is sent to TypeSafe, and the action always
waits for your approval, even when the fallback is **Deny**. The decision shows
**Jev not consulted (CI or dependency files always need approval)**. A CI
change runs later with the repository's CI secrets and a dependency change is a
supply-chain change, so neither rests on a model's answer.

::: info Asked at execution time, by the coding broker
Jev is consulted when an agent action runs, and the coding broker is what runs
agent actions. Until that broker ships, no action is executed under a policy,
so Jev is never called; the settings already shape what **Simulate an action**
shows.
:::

**When the advisor cannot answer** decides what happens on a timeout, rate
limit, invalid or unsure answer, missing key, or a disabled purpose:
**Require approval** (the default) or **Deny**. The advisor can never lift a
hard deny, a mandatory approval or an unanalyzable command, and it never turns
an action into a deny on its own.

A project policy can turn the advisor off, lower the risk threshold, raise the
minimum confidence, or choose **Deny** as its fallback. It cannot turn the
advisor on or loosen it. Turning the advisor on or loosening it globally is a
weakening you confirm when you save.

## Project policies only narrow

A project policy can remove classes, add hard denies or mandatory approvals,
shorten scope lists, and lower budgets. Fields left empty inherit the global
value. It cannot allow anything the global policy does not: saving such a
policy is refused with the fields that widen it. The **Inheritance** table
shows the global value, the project setting and the effective result side by
side.

If a project is deleted while it still has a policy, the policy is marked
**orphaned**. Every action for that project is denied until you remove the
policy, and the effective-policy preview shows no permissions.

The global page lists the 1,000 most recently changed project policies and says
so when there are more; open a project to see a policy that is not listed.

## Editing and saving

Edit the policy in the form, or switch to **JSON** to edit the document
directly. **Load JSON into form** checks your JSON and shows it in the form.

**Check changes** asks the runner to validate the draft. It shows invalid
fields, refused widenings, changes that weaken the effective policy, a field by
field diff against the saved version, and the effective policy after the
change.

**Save policy** checks the draft again. When the change lets agents do more
than before, you confirm the listed weakenings first. Your confirmation covers
exactly that list and that operation: if another save or removal changes it
before yours lands, the page shows the current list and asks you to confirm
again. A change that weakens the policy in more ways than one confirmation can
show is refused; save it in smaller steps. If someone saved the
policy while you were editing, the page keeps your draft, reloads the saved
version, and asks you to check again.

## Simulating an action

**Simulate an action** describes one action (class, repository, branch,
command, paths, package or host, and any platform effects) and shows the
decision the runner would make: **Allow**, **Requires approval** or **Deny**,
with the reason code, the matched rules, the policy revisions used and a
fingerprint of the action. The simulation uses the same evaluator, policy
snapshot and advisor setting that the coding broker will use, so its answer is
the decision execution starts from. The one difference is the advisor: when an
advisor is configured, an **Advisor or approval** action shows as **Requires
approval** with `ADVISOR_REQUIRED`, because the advisor answers only at
execution time. A simulation never sends anything to TypeSafe. At execution the
action becomes **Allow** only if the advisor answers that nothing needs to
change. When the policy enables the advisor but it is unavailable, the
simulation already shows the fallback and its reason, such as **Jev not
consulted (no TypeSafe key)**. Once the coding broker executes actions, its
decisions show whether Jev was consulted, with its decision id, risk and
confidence.

Commands have two platform outcomes. A command that runs a container runtime or
a privilege tool such as `sudo` is denied, and no policy or approval can allow
it. A command the runner cannot read exactly **Requires approval** with
`PLATFORM_COMMAND_UNANALYZABLE`. The runner reads commands as argv and never
parses shell syntax: shell strings are never analysed; they always require
approval. That covers `sh -c`, `bash -c`, `eval`, `source` and inline
interpreter code such as `python -c` or `node -e`, whatever the string
contains, so run commands as argv when you can. A shell string that starts a
command with `docker` or `sudo` is still denied. Other examples are a program
name containing shell syntax, a `git -c` setting that could change what git
runs, and setting an environment variable other than `CI`, `NODE_ENV`,
`FORCE_COLOR`, `NO_COLOR`, `TZ`, `LANG`, `LC_ALL`, `DEBUG` or the npm settings
`loglevel`, `color`, `progress`, `fund`, `audit`, `update_notifier` and `yes`,
because variables such as `PAGER`, `EDITOR` or `npm_config_call` make a program
run another one. That approval is always required: an advisor or a project
rule cannot clear it. Ordinary commands such as `grep -r docker .`,
`command -v docker` or `vitest --environment node` are not affected. The gate
is a policy layer, not a sandbox: it does not model what a program you admit in
the command scope runs through its own arguments, so admit only programs you
trust there. The workspace container's restrictions are what contain them. A command
that runs `git push` is also judged as **Publish branch**, and the stricter
decision applies.
Tick **Evaluate the unsaved editor draft** to try a change before saving it.
Simulations are read-only and are not recorded in the audit log.

## History and rollback

Every save creates a new revision; old revisions are never changed. **History**
lists them with their notes. **Compare with current** shows the differences, and
**Roll back** creates a new revision with the older document. A rollback that
weakens the effective policy asks for confirmation. **Remove project policy**
returns the project to the global policy; its history stays.
