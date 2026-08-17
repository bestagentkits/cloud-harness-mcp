#!/usr/bin/env bash
set -euo pipefail
umask 077

mode=$1
repository_url=$2
repository_path=$3
transfer_path=$4
argument=${5:-}
expected_remote_oid=${6:-}
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

git_clean() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -c http.followRedirects=false "$@"
}

case $mode in
  fetch)
    configure_auth
    git_clean init --bare -- "$transfer_path"
    if [[ -n $argument ]]; then
      git_clean --git-dir="$transfer_path" fetch --no-tags --no-recurse-submodules -- \
        "$repository_url" "${argument}:refs/heads/cloud-harness-fetch"
    else
      git_clean --git-dir="$transfer_path" fetch --no-tags --no-recurse-submodules -- \
        "$repository_url" '+refs/heads/*:refs/heads/cloud-harness/*'
    fi
    ;;
  import)
    if [[ -n $argument ]]; then
      git_clean -C "$repository_path" fetch --no-tags --no-recurse-submodules -- \
        "$transfer_path" refs/heads/cloud-harness-fetch
      if [[ $argument == refs/heads/* ]]; then
        branch=${argument#refs/heads/}
        git_clean check-ref-format "refs/heads/${branch}"
        git_clean -C "$repository_path" update-ref "refs/remotes/origin/${branch}" FETCH_HEAD
      fi
    else
      git_clean -C "$repository_path" fetch --no-tags --no-recurse-submodules -- \
        "$transfer_path" '+refs/heads/cloud-harness/*:refs/remotes/origin/*'
    fi
    ;;
  stage-push)
    git_clean clone --bare -- "$repository_path" "$transfer_path"
    ;;
  push)
    configure_auth
    git_clean --git-dir="$transfer_path" remote remove origin 2>/dev/null || true
    git_clean --git-dir="$transfer_path" remote add origin "$repository_url"
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
      git_clean --git-dir="$transfer_path" push --porcelain \
        "--force-with-lease=${destination}:${expected_remote_oid}" origin "$argument"
    else
      git_clean --git-dir="$transfer_path" push --porcelain origin "$argument"
    fi
    ;;
  *)
    printf 'unsupported transfer mode\n' >&2
    exit 2
    ;;
esac
