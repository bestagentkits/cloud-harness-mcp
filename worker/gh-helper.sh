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
  issue_comment)
    issue_number="${1:-}"
    body="${2:-}"
    if [ -z "$issue_number" ] || [ -z "$body" ]; then
      echo "Issue number and comment body required" >&2
      exit 1
    fi
    exec gh issue comment "$issue_number" --body "$body"
    ;;
  issue_comment_update)
    comment_id="${1:-}"
    body="${2:-}"
    if [ -z "$comment_id" ] || [ -z "$body" ]; then
      echo "Comment ID and body required" >&2
      exit 1
    fi
    exec gh api -X PATCH "repos/{owner}/{repo}/issues/comments/$comment_id" -f body="$body"
    ;;
  label_create)
    name="${1:-}"
    color="${2:-0E8A16}"
    desc="${3:-}"
    if [ -z "$name" ]; then
      echo "Label name required" >&2
      exit 1
    fi
    exec gh label create "$name" --color "$color" --description "$desc" --force
    ;;
  issue_labels_add)
    issue_number="${1:-}"
    labels="${2:-}"
    create_missing="${3:-true}"
    if [ -z "$issue_number" ] || [ -z "$labels" ]; then
      echo "Issue number and labels required" >&2
      exit 1
    fi
    if [ "$create_missing" = "true" ]; then
      IFS=',' read -ra ADDR <<< "$labels"
      for label in "${ADDR[@]}"; do
        gh label create "$label" >/dev/null 2>&1 || true
      done
    fi
    exec gh issue edit "$issue_number" --add-label "$labels"
    ;;
  issue_labels_remove)
    issue_number="${1:-}"
    label="${2:-}"
    if [ -z "$issue_number" ] || [ -z "$label" ]; then
      echo "Issue number and label required" >&2
      exit 1
    fi
    exec gh issue edit "$issue_number" --remove-label "$label"
    ;;
  issue_update)
    issue_number="${1:-}"
    title="${2:-}"
    body="${3:-}"
    state="${4:-}"
    state_reason="${5:-}"
    if [ -z "$issue_number" ]; then
      echo "Issue number required" >&2
      exit 1
    fi
    cmd=(gh issue edit "$issue_number")
    if [ -n "$title" ]; then cmd+=(--title "$title"); fi
    if [ -n "$body" ]; then cmd+=(--body "$body"); fi
    if [ -n "$state" ]; then
      if [ "$state" = "closed" ]; then
        cmd+=(--state "closed")
        if [ -n "$state_reason" ]; then cmd+=(--reason "$state_reason"); fi
      elif [ "$state" = "open" ]; then
        cmd+=(--state "open")
      fi
    fi
    exec "${cmd[@]}"
    ;;
  issue_publish)
    issue_number="${1:-}"
    comment="${2:-}"
    add_labels="${3:-}"
    remove_labels="${4:-}"
    create_missing="${5:-true}"
    if [ -z "$issue_number" ]; then
      echo "Issue number required" >&2
      exit 1
    fi
    labels_created=""
    labels_added=""
    labels_removed=""
    comment_posted=false

    if [ "$create_missing" = "true" ] && [ -n "$add_labels" ]; then
      IFS=',' read -ra ADDR <<< "$add_labels"
      for label in "${ADDR[@]}"; do
        if gh label create "$label" >/dev/null 2>&1; then
          labels_created="${labels_created:+$labels_created,}$label"
        fi
      done
    fi
    if [ -n "$add_labels" ]; then
      if ! gh issue edit "$issue_number" --add-label "$add_labels" >/dev/null 2>&1; then
        echo "{\"error\":\"failed to add labels\",\"step\":\"add_labels\",\"labelsCreated\":\"$labels_created\",\"issueNumber\":$issue_number}" >&2
        exit 1
      fi
      labels_added="$add_labels"
    fi
    if [ -n "$remove_labels" ]; then
      IFS=',' read -ra RADDR <<< "$remove_labels"
      for rlabel in "${RADDR[@]}"; do
        if ! gh issue edit "$issue_number" --remove-label "$rlabel" >/dev/null 2>&1; then
          echo "{\"error\":\"failed to remove label $rlabel\",\"step\":\"remove_labels\",\"failedLabel\":\"$rlabel\",\"labelsCreated\":\"$labels_created\",\"labelsAdded\":\"$labels_added\",\"labelsRemoved\":\"$labels_removed\",\"issueNumber\":$issue_number}" >&2
          exit 1
        fi
        labels_removed="${labels_removed:+$labels_removed,}$rlabel"
      done
    fi
    if [ -n "$comment" ]; then
      if ! gh issue comment "$issue_number" --body "$comment" >/dev/null 2>&1; then
        echo "{\"error\":\"failed to post comment\",\"step\":\"comment\",\"labelsCreated\":\"$labels_created\",\"labelsAdded\":\"$labels_added\",\"labelsRemoved\":\"$labels_removed\",\"issueNumber\":$issue_number}" >&2
        exit 1
      fi
      comment_posted=true
    fi

    view_out=$(gh issue view "$issue_number" --json number,title,body,state,author,labels,comments,url 2>/dev/null || true)
    if [ -n "$view_out" ]; then
      echo "$view_out"
    else
      echo "{\"number\":$issue_number,\"published\":true,\"commentPosted\":$comment_posted,\"labelsCreated\":\"$labels_created\",\"labelsAdded\":\"$labels_added\",\"labelsRemoved\":\"$labels_removed\"}"
    fi
    ;;
  *)
    echo "Unsupported or forbidden GitHub action: $action" >&2
    exit 1
    ;;
esac
