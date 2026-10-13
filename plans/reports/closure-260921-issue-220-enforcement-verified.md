## Enforcement verified in practice, not just configured

With the `quality` check now required on `main`, the merge is refused while that check is
pending. Attempting the merge on the corrective PR produced:

```
X Pull request bestagentkits/cloud-harness-mcp#239 is not mergeable: the base branch
policy prohibits the merge.
To have the pull request merged after all the requirements have been met, add the `--auto` flag.
To use administrator privileges to immediately merge the pull request, add the `--admin` flag.
```

and the PR reports `mergeStateStatus = BLOCKED` until the check concludes. The corrective PR
for this record is merged only after its `quality` run is green — the opposite of what
happened to phase 8, where `gh pr merge --auto` merged immediately because there was no
required check to wait for.

Note the `--admin` escape hatch that GitHub offers here: requiring the check constrains the
normal merge path, and an administrator can still override it. That is the correct trade-off
for a single-owner harness (it keeps an emergency path open), but it means the constraint is
"CI gates merges" rather than "CI makes merges impossible".
