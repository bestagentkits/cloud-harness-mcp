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
    draft="${5:-false}"
    labels="${6:-}"
    if [ -z "$title" ] || [ -z "$head" ]; then
      echo "Title and head branch required for pull request creation" >&2
      exit 1
    fi
    cmd=(gh pr create --title "$title" --body "$body" --head "$head" --base "$base")
    if [ "$draft" = "true" ]; then
      cmd+=(--draft)
    fi
    if [ -n "$labels" ]; then
      cmd+=(--label "$labels")
    fi
    exec "${cmd[@]}"
    ;;
  pr_update)
    pr_number="${1:-}"
    title="${2:-}"
    body="${3:-}"
    base="${4:-}"
    state="${5:-}"
    if [ -z "$pr_number" ]; then
      echo "Pull request number required" >&2
      exit 1
    fi
    edit_needed=false
    cmd=(gh pr edit "$pr_number")
    if [ -n "$title" ]; then cmd+=(--title "$title"); edit_needed=true; fi
    if [ -n "$body" ]; then cmd+=(--body "$body"); edit_needed=true; fi
    if [ -n "$base" ]; then cmd+=(--base "$base"); edit_needed=true; fi
    if [ "$edit_needed" = "true" ]; then
      if ! "${cmd[@]}" >/dev/null; then
        echo "Failed to edit pull request $pr_number" >&2
        exit 1
      fi
    fi
    if [ -n "$state" ]; then
      if [ "$state" = "closed" ]; then
        if ! gh pr close "$pr_number" >/dev/null; then
          echo "Failed to close pull request $pr_number" >&2
          exit 1
        fi
      elif [ "$state" = "open" ]; then
        if ! gh pr reopen "$pr_number" >/dev/null; then
          echo "Failed to reopen pull request $pr_number" >&2
          exit 1
        fi
      fi
    fi
    exec gh pr view "$pr_number" --json number,title,body,state,author,reviews,comments,url
    ;;
  pr_comment)
    pr_number="${1:-}"
    body="${2:-}"
    if [ -z "$pr_number" ] || [ -z "$body" ]; then
      echo "Pull request number and comment body required" >&2
      exit 1
    fi
    exec gh pr comment "$pr_number" --body "$body"
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
    labels="${3:-}"
    assignees="${4:-}"
    if [ -z "$title" ]; then
      echo "Title required for issue creation" >&2
      exit 1
    fi
    cmd=(gh issue create --title "$title" --body "$body")
    if [ -n "$labels" ]; then
      cmd+=(--label "$labels")
    fi
    if [ -n "$assignees" ]; then
      cmd+=(--assignee "$assignees")
    fi
    exec "${cmd[@]}"
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
    edit_needed=false
    cmd=(gh issue edit "$issue_number")
    if [ -n "$title" ]; then cmd+=(--title "$title"); edit_needed=true; fi
    if [ -n "$body" ]; then cmd+=(--body "$body"); edit_needed=true; fi
    if [ "$edit_needed" = "true" ]; then
      if ! "${cmd[@]}" >/dev/null; then
        echo "Failed to edit issue $issue_number" >&2
        exit 1
      fi
    fi
    if [ -n "$state" ]; then
      if [ "$state" = "closed" ]; then
        close_cmd=(gh issue close "$issue_number")
        if [ -n "$state_reason" ]; then
          if [ "$state_reason" = "not_planned" ] || [ "$state_reason" = "not planned" ]; then
            close_cmd+=(--reason "not planned")
          elif [ "$state_reason" = "completed" ]; then
            close_cmd+=(--reason "completed")
          fi
        fi
        if ! "${close_cmd[@]}" >/dev/null; then
          echo "Failed to close issue $issue_number" >&2
          exit 1
        fi
      elif [ "$state" = "open" ]; then
        if ! gh issue reopen "$issue_number" >/dev/null; then
          echo "Failed to reopen issue $issue_number" >&2
          exit 1
        fi
      fi
    fi
    exec gh issue view "$issue_number" --json number,title,body,state,author,labels,comments,url
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
        jq -n \
          --arg error "failed to add labels" \
          --arg step "add_labels" \
          --arg labelsCreated "$labels_created" \
          --argjson issueNumber "$issue_number" \
          '{ error: $error, step: $step, labelsCreated: $labelsCreated, issueNumber: $issueNumber }' >&2
        exit 1
      fi
      labels_added="$add_labels"
    fi
    if [ -n "$remove_labels" ]; then
      if ! current_labels=$(gh issue view "$issue_number" --json labels --jq '.labels[].name' 2>&1); then
        jq -n \
          --arg error "failed to query issue labels: $current_labels" \
          --arg step "query_labels" \
          --arg labelsCreated "$labels_created" \
          --arg labelsAdded "$labels_added" \
          --argjson issueNumber "$issue_number" \
          '{ error: $error, step: $step, labelsCreated: $labelsCreated, labelsAdded: $labelsAdded, issueNumber: $issueNumber }' >&2
        exit 1
      fi
      IFS=',' read -ra RADDR <<< "$remove_labels"
      for rlabel in "${RADDR[@]}"; do
        if echo "$current_labels" | grep -Fxq "$rlabel"; then
          if ! gh issue edit "$issue_number" --remove-label "$rlabel" >/dev/null 2>&1; then
            jq -n \
              --arg error "failed to remove label $rlabel" \
              --arg step "remove_labels" \
              --arg failedLabel "$rlabel" \
              --arg labelsCreated "$labels_created" \
              --arg labelsAdded "$labels_added" \
              --arg labelsRemoved "$labels_removed" \
              --argjson issueNumber "$issue_number" \
              '{ error: $error, step: $step, failedLabel: $failedLabel, labelsCreated: $labelsCreated, labelsAdded: $labelsAdded, labelsRemoved: $labelsRemoved, issueNumber: $issueNumber }' >&2
            exit 1
          fi
        fi
        labels_removed="${labels_removed:+$labels_removed,}$rlabel"
      done
    fi
    comment_url=""
    if [ -n "$comment" ]; then
      if ! comment_url=$(gh issue comment "$issue_number" --body "$comment" 2>&1); then
        jq -n \
          --arg error "failed to post comment: $comment_url" \
          --arg step "comment" \
          --arg labelsCreated "$labels_created" \
          --arg labelsAdded "$labels_added" \
          --arg labelsRemoved "$labels_removed" \
          --argjson issueNumber "$issue_number" \
          '{ error: $error, step: $step, labelsCreated: $labelsCreated, labelsAdded: $labelsAdded, labelsRemoved: $labelsRemoved, issueNumber: $issueNumber }' >&2
        exit 1
      fi
      comment_posted=true
    fi

    issue_url="https://github.com/${GH_REPO}/issues/${issue_number}"
    view_out=$(gh issue view "$issue_number" --json number,title,body,state,author,labels,comments,url 2>/dev/null || true)
    if [ -n "$view_out" ]; then
      echo "$view_out" | jq --arg commentUrl "$comment_url" --arg url "$issue_url" '. + (if $commentUrl != "" then { commentUrl: $commentUrl } else {} end) + (if .url == null or .url == "" then { url: $url } else {} end)'
    else
      jq -n \
        --argjson number "$issue_number" \
        --argjson commentPosted "$comment_posted" \
        --arg commentUrl "$comment_url" \
        --arg url "$issue_url" \
        --arg labelsCreated "$labels_created" \
        --arg labelsAdded "$labels_added" \
        --arg labelsRemoved "$labels_removed" \
        '{ number: $number, url: $url, published: true, commentPosted: $commentPosted, commentUrl: $commentUrl, labelsCreated: $labelsCreated, labelsAdded: $labelsAdded, labelsRemoved: $labelsRemoved }'
    fi
    ;;
  *)
    echo "Unsupported or forbidden GitHub action: $action" >&2
    exit 1
    ;;
esac
