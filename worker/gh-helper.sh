#!/bin/bash
set -euo pipefail

# Read GitHub token from stdin (zero leakage in process args or disk)
read -r GH_TOKEN
export GH_TOKEN

action="${1:-}"
if [ -z "$action" ]; then
  echo "GitHub action required" >&2
  exit 1
fi
shift

case "$action" in
  pr_list)
    limit="${1:-20}"
    state="${2:-open}"
    exec gh pr list --limit "$limit" --state "$state" --json number,title,state,author,headRefName,url
    ;;
  pr_view)
    pr_number="${1:-}"
    if [ -z "$pr_number" ]; then
      echo "Pull request number required" >&2
      exit 1
    fi
    exec gh pr view "$pr_number" --json number,title,body,state,author,reviews,comments,url
    ;;
  pr_create)
    title="${1:-}"
    body="${2:-}"
    head="${3:-}"
    base="${4:-main}"
    if [ -z "$title" ] || [ -z "$head" ]; then
      echo "Title and head branch required for pull request creation" >&2
      exit 1
    fi
    exec gh pr create --title "$title" --body "$body" --head "$head" --base "$base"
    ;;
  issue_list)
    limit="${1:-20}"
    state="${2:-open}"
    exec gh issue list --limit "$limit" --state "$state" --json number,title,state,author,labels,url
    ;;
  issue_view)
    issue_number="${1:-}"
    if [ -z "$issue_number" ]; then
      echo "Issue number required" >&2
      exit 1
    fi
    exec gh issue view "$issue_number" --json number,title,body,state,author,labels,comments,url
    ;;
  issue_create)
    title="${1:-}"
    body="${2:-}"
    if [ -z "$title" ]; then
      echo "Title required for issue creation" >&2
      exit 1
    fi
    exec gh issue create --title "$title" --body "$body"
    ;;
  *)
    echo "Unsupported or forbidden GitHub action: $action" >&2
    exit 1
    ;;
esac
