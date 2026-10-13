#!/usr/bin/env bash
set -euo pipefail
umask 022

repository_url=$1
destination=$2
repository_ref=${3:-}
cache_path=${4:-}
history_spec=${5:-}
token=
IFS= read -r token || true

cleanup() {
  token=
  rm -f /tmp/cloud-harness-askpass
}
trap cleanup EXIT

if [[ -n $token ]]; then
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
fi

arguments=(
  -c http.followRedirects=false
  -c core.hooksPath=/dev/null
  -c filter.lfs.smudge=
)
# The history spec comes from schema-validated input: '' (one commit), full, depth:N, or since:DATE.
case $history_spec in
  '') history_arguments=(--depth 1) ;;
  full) history_arguments=() ;;
  depth:*)
    depth=${history_spec#depth:}
    if [[ ! $depth =~ ^[1-9][0-9]{0,5}$ ]]; then printf 'invalid clone depth\n' >&2; exit 2; fi
    history_arguments=(--depth "$depth") ;;
  since:*)
    since=${history_spec#since:}
    if [[ ! $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T][0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2}))?$ ]]; then printf 'invalid clone shallow-since date\n' >&2; exit 2; fi
    history_arguments=("--shallow-since=$since") ;;
  *) printf 'invalid clone history spec\n' >&2; exit 2 ;;
esac
# A requested history clone also carries file contents, because the executor cannot lazily fetch old blobs
# (it has no repository credentials and may have no network). The default single-commit clone stays blob-filtered.
filter_arguments=(--filter=blob:none)
if [[ -n $history_spec ]]; then filter_arguments=(); fi
if [[ -n $cache_path && -d $cache_path ]]; then
  arguments+=(clone --reference-if-able "$cache_path" --dissociate ${history_arguments[@]+"${history_arguments[@]}"} --no-tags --no-recurse-submodules ${filter_arguments[@]+"${filter_arguments[@]}"})
else
  arguments+=(clone ${history_arguments[@]+"${history_arguments[@]}"} --no-tags --no-recurse-submodules ${filter_arguments[@]+"${filter_arguments[@]}"})
fi
if [[ -n $repository_ref ]]; then arguments+=(--branch "$repository_ref"); fi
arguments+=(-- "$repository_url" "$destination")
git "${arguments[@]}"
git -C "$destination" remote set-url origin "$repository_url"
