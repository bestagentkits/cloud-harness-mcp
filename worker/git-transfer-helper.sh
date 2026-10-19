#!/usr/bin/env bash
set -euo pipefail
umask 077

mode=$1
repository_url=$2
repository_path=$3
transfer_path=$4
argument=${5:-}
expected_remote_oid=${6:-}
history_spec=${7:-}
token=
IFS= read -r token || true

cleanup() {
  token=
  unset CLOUD_HARNESS_GIT_TOKEN GIT_ASKPASS
  rm -f /tmp/cloud-harness-askpass
}
trap cleanup EXIT

configure_auth() {
  if [[ -z $token ]]; then return; fi
  cat > /tmp/cloud-harness-askpass <<'EOF'
#!/usr/bin/env bash
case ${1:-} in
  *Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$CLOUD_HARNESS_GIT_TOKEN" ;;
esac
EOF
  chmod 0700 /tmp/cloud-harness-askpass
  export CLOUD_HARNESS_GIT_TOKEN=$token
  export GIT_ASKPASS=/tmp/cloud-harness-askpass
}

# Replace refs and grafts are off by environment and by configuration (a repository's own
# core.useReplaceRefs would otherwise re-enable them), so every read sees the objects a push sends.
git_clean() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.useReplaceRefs=false -c diff.relative=false \
    -c credential.helper= -c http.followRedirects=false "$@"
}

is_object_id() {
  [[ $1 =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]
}

# The history spec comes from schema-validated input: '' (no depth change), full, depth:N, or since:DATE.
# The remote fetch applies the depth to the transfer repository; the offline import then applies the same
# boundary to the checkout, with --update-shallow so shallow roots from the transfer are accepted.
# A complete checkout is never cut back: depth and date boundaries apply to the import only while the checkout
# is still shallow, so a history request can deepen but never truncate existing history.
remote_history=()
import_history=()
checkout_shallow=false
if [[ $mode == import && -n $history_spec && $(git_clean -C "$repository_path" rev-parse --is-shallow-repository) == true ]]; then
  checkout_shallow=true
fi
case $history_spec in
  '') ;;
  full)
    if [[ $checkout_shallow == true ]]; then import_history=(--update-shallow --unshallow); fi
    ;;
  depth:*)
    depth=${history_spec#depth:}
    if [[ ! $depth =~ ^[1-9][0-9]{0,5}$ ]]; then printf 'invalid fetch depth\n' >&2; exit 2; fi
    remote_history=(--depth "$depth")
    if [[ $checkout_shallow == true ]]; then import_history=(--update-shallow --depth "$depth"); fi
    ;;
  since:*)
    since=${history_spec#since:}
    if [[ ! $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T][0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2}))?$ ]]; then printf 'invalid fetch shallow-since date\n' >&2; exit 2; fi
    remote_history=("--shallow-since=$since")
    if [[ $checkout_shallow == true ]]; then import_history=(--update-shallow "--shallow-since=$since"); fi
    ;;
  *) printf 'invalid fetch history spec\n' >&2; exit 2 ;;
esac

case $mode in
  fetch)
    configure_auth
    git_clean init --bare -- "$transfer_path"
    if [[ -n $argument ]]; then
      git_clean --git-dir="$transfer_path" fetch --no-tags --no-recurse-submodules ${remote_history[@]+"${remote_history[@]}"} -- \
        "$repository_url" "${argument}:refs/heads/cloud-harness-fetch"
    else
      git_clean --git-dir="$transfer_path" fetch --no-tags --no-recurse-submodules ${remote_history[@]+"${remote_history[@]}"} -- \
        "$repository_url" '+refs/heads/*:refs/heads/cloud-harness/*'
    fi
    ;;
  import)
    if [[ -n $argument ]]; then
      git_clean -C "$repository_path" fetch --no-tags --no-recurse-submodules ${import_history[@]+"${import_history[@]}"} -- \
        "$transfer_path" refs/heads/cloud-harness-fetch
      if [[ $argument == refs/heads/* ]]; then
        branch=${argument#refs/heads/}
        git_clean check-ref-format "refs/heads/${branch}"
        git_clean -C "$repository_path" update-ref "refs/remotes/origin/${branch}" FETCH_HEAD
      fi
    else
      git_clean -C "$repository_path" fetch --no-tags --no-recurse-submodules ${import_history[@]+"${import_history[@]}"} -- \
        "$transfer_path" '+refs/heads/cloud-harness/*:refs/remotes/origin/*'
    fi
    ;;
  stage-push)
    # `isolated` copies every object through the pack protocol instead of hardlinking the checkout's object
    # files (or inheriting its alternates), so nothing the executor can still write after it resumes is
    # shared with the clone that is inspected and then pushed. The serving side runs in the checkout,
    # where Git drops the caller's environment and configuration overrides, so it is given them again:
    # a checkout's core.useReplaceRefs or grafts would otherwise reshape the history it sends.
    if [[ $argument == isolated ]]; then
      git_clean clone --bare --no-local \
        --upload-pack='env GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git -c core.useReplaceRefs=false -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack' \
        -- "$repository_path" "$transfer_path"
    else
      git_clean clone --bare -- "$repository_path" "$transfer_path"
    fi
    ;;
  inspect)
    # The authoritative read of the commit a push will send, run on the staged clone itself. Output:
    # the resolved commit id (empty when it is not a commit), the raw commit object in base64 (its parent
    # headers are what the push sends), `paths` or `no-base`, then the NUL-separated paths the commit
    # changes against the base.
    base=$expected_remote_oid
    if ! is_object_id "$argument" || ! is_object_id "$base"; then printf 'invalid inspection object ID\n' >&2; exit 2; fi
    sha=$(git_clean --git-dir="$transfer_path" rev-parse --verify --quiet "${argument}^{commit}" || true)
    printf '%s\n' "$sha"
    if [[ -z $sha ]]; then exit 0; fi
    git_clean --git-dir="$transfer_path" cat-file commit "$sha" | base64 -w0
    printf '\n'
    if ! git_clean --git-dir="$transfer_path" cat-file -e "${base}^{commit}" 2>/dev/null; then
      printf 'no-base\n'
      exit 0
    fi
    printf 'paths\n'
    git_clean --git-dir="$transfer_path" diff-tree -r --no-renames --no-commit-id --name-only -z "$base" "$sha" --
    ;;
  push)
    configure_auth
    git_clean --git-dir="$transfer_path" remote remove origin 2>/dev/null || true
    git_clean --git-dir="$transfer_path" remote add origin "$repository_url"
    # A lease is the atomic compare-and-swap of the push protocol: the server applies the update only
    # while the ref still holds the expected value. `absent` expects no ref (create only), an object ID
    # expects that value (update, or delete with an empty source), and nothing means a plain push.
    if [[ $argument == :* && -z $expected_remote_oid ]]; then
      printf 'deleting a remote branch requires an expected object ID lease\n' >&2
      exit 2
    fi
    if [[ -n $expected_remote_oid ]]; then
      if [[ $argument != *:* ]]; then
        printf 'force-with-lease requires an explicit destination ref\n' >&2
        exit 2
      fi
      destination=${argument#*:}
      if [[ $destination != refs/heads/* ]]; then
        printf 'force-with-lease destination must be a branch\n' >&2
        exit 2
      fi
      if [[ $expected_remote_oid == absent ]]; then
        if [[ $argument == :* ]]; then
          printf 'a create-only lease cannot delete a branch\n' >&2
          exit 2
        fi
        lease_value=
      elif [[ $expected_remote_oid =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
        lease_value=$expected_remote_oid
      else
        printf 'invalid expected remote object ID\n' >&2
        exit 2
      fi
      push_status=0
      push_output=$(git_clean --git-dir="$transfer_path" push --porcelain \
        "--force-with-lease=${destination}:${lease_value}" origin "$argument") || push_status=$?
      printf '%s\n' "$push_output"
      # git reports "already up to date" before it checks a lease, so a push of the commit the branch
      # already holds exits 0 whatever the lease said. It succeeds only when the lease expected exactly that
      # commit; a create-only lease, or one naming an older commit, lost to whoever pushed it first.
      if [[ $push_status -eq 0 ]] && grep -q $'^=\t' <<<"$push_output"; then
        source_oid=
        if [[ $expected_remote_oid != absent ]]; then
          source_oid=$(git_clean --git-dir="$transfer_path" rev-parse --verify --quiet "${argument%%:*}^{commit}" || true)
        fi
        if [[ -z $source_oid || $source_oid != "$lease_value" ]]; then
          printf 'lease rejected: %s already holds the pushed commit\n' "$destination" >&2
          exit 1
        fi
      fi
      exit "$push_status"
    else
      git_clean --git-dir="$transfer_path" push --porcelain origin "$argument"
    fi
    ;;
  *)
    printf 'unsupported transfer mode\n' >&2
    exit 2
    ;;
esac
