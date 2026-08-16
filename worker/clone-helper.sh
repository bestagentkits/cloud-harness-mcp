#!/usr/bin/env bash
set -euo pipefail
umask 077

repository_url=$1
destination=$2
repository_ref=${3:-}
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
  clone --depth 1 --no-tags --no-recurse-submodules --filter=blob:none
)
if [[ -n $repository_ref ]]; then arguments+=(--branch "$repository_ref"); fi
arguments+=(-- "$repository_url" "$destination")
git "${arguments[@]}"
git -C "$destination" remote set-url origin "$repository_url"
