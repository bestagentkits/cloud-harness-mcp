#!/bin/bash
set -euo pipefail

# Read GitHub token from stdin (zero leakage in process args or disk)
read -r GH_TOKEN
export GH_TOKEN

require_number() {
  if ! [[ "${1:-}" =~ ^[0-9]+$ ]]; then
    echo "$2 must be a positive integer" >&2
    exit 1
  fi
}

# Revisions and refs are placed in REST paths, so traversal, range syntax, and option-like values are refused.
require_revision() {
  if ! [[ "${1:-}" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ $1 == -* || $1 == /* || $1 == */ || $1 == *..* ]]; then
    echo "Revision must be a branch, tag, or commit SHA" >&2
    exit 1
  fi
}

require_ref() {
  require_revision "${1:-}"
  if ! [[ $1 =~ ^refs/(heads|tags)/. ]]; then
    echo "Ref must be a fully qualified refs/heads/... or refs/tags/... name" >&2
    exit 1
  fi
}

require_workflow() {
  if ! [[ "${1:-}" =~ ^([1-9][0-9]{0,18}|[A-Za-z0-9._-]{1,200}\.ya?ml)$ ]]; then
    echo "Workflow must be a numeric ID or a workflow file name such as ci.yml" >&2
    exit 1
  fi
}

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
    exec gh pr view "$pr_number" --json number,title,body,state,author,reviews,comments,url,isDraft,reviewDecision,reviewRequests,mergeable,mergeStateStatus,headRefOid,autoMergeRequest
    ;;
  pr_review_threads)
    pr_number="${1:-}"
    limit="${2:-50}"
    require_number "$pr_number" "Pull request number"
    require_number "$limit" "Thread limit"
    exec gh api graphql \
      -f owner="${GH_REPO%%/*}" -f repo="${GH_REPO#*/}" -F number="$pr_number" -F limit="$limit" \
      -f query='query($owner: String!, $repo: String!, $number: Int!, $limit: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: $limit) { totalCount nodes { id isResolved isOutdated path line startLine diffSide comments(first: 50) { totalCount nodes { databaseId author { login } body createdAt url } } } } } } }' \
      --jq '.data.repository.pullRequest.reviewThreads | { totalCount, threads: [.nodes[] | { id, isResolved, isOutdated, path, line, startLine, diffSide, commentsTotal: .comments.totalCount, comments: [.comments.nodes[] | { id: .databaseId, author: .author.login, body, createdAt, url }] }] }'
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
  pr_review)
    pr_number="${1:-}"
    event="${2:-}"
    body="${3:-}"
    require_number "$pr_number" "Pull request number"
    case "$event" in
      COMMENT|APPROVE|REQUEST_CHANGES) ;;
      *) echo "Review event must be COMMENT, APPROVE, or REQUEST_CHANGES" >&2; exit 1 ;;
    esac
    cmd=(gh api -X POST "repos/{owner}/{repo}/pulls/$pr_number/reviews" -f "event=$event")
    if [ -n "$body" ]; then cmd+=(-f "body=$body"); fi
    exec "${cmd[@]}" --jq '{ id, state, url: .html_url, author: .user.login, commitId: .commit_id }'
    ;;
  pr_review_comment)
    pr_number="${1:-}"
    body="${2:-}"
    path="${3:-}"
    line="${4:-}"
    start_line="${5:-}"
    side="${6:-RIGHT}"
    start_side="${7:-}"
    commit_id="${8:-}"
    require_number "$pr_number" "Pull request number"
    require_number "$line" "Line"
    if [ -z "$body" ] || [ -z "$path" ]; then
      echo "Comment body and file path required" >&2
      exit 1
    fi
    if [ -z "$commit_id" ]; then
      commit_id=$(gh api "repos/{owner}/{repo}/pulls/$pr_number" --jq .head.sha)
    fi
    cmd=(gh api -X POST "repos/{owner}/{repo}/pulls/$pr_number/comments" -f "body=$body" -f "commit_id=$commit_id" -f "path=$path" -F "line=$line" -f "side=$side")
    if [ -n "$start_line" ]; then
      require_number "$start_line" "Start line"
      cmd+=(-F "start_line=$start_line" -f "start_side=${start_side:-$side}")
    fi
    exec "${cmd[@]}" --jq '{ id, url: .html_url, path, line, side, commitId: .commit_id, author: .user.login }'
    ;;
  pr_review_reply)
    thread_id="${1:-}"
    body="${2:-}"
    if [ -z "$thread_id" ] || [ -z "$body" ]; then
      echo "Review thread ID and reply body required" >&2
      exit 1
    fi
    exec gh api graphql -f thread="$thread_id" -f body="$body" \
      -f query='mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id databaseId url } } }' \
      --jq '.data.addPullRequestReviewThreadReply.comment | { id, commentId: .databaseId, url }'
    ;;
  pr_review_thread_resolve|pr_review_thread_unresolve)
    thread_id="${1:-}"
    if [ -z "$thread_id" ]; then
      echo "Review thread ID required" >&2
      exit 1
    fi
    if [ "$action" = "pr_review_thread_resolve" ]; then mutation="resolveReviewThread"; else mutation="unresolveReviewThread"; fi
    exec gh api graphql -f thread="$thread_id" \
      -f query="mutation(\$thread: ID!) { ${mutation}(input: { threadId: \$thread }) { thread { id isResolved } } }" \
      --jq ".data.${mutation}.thread | { id, isResolved }"
    ;;
  pr_reviewers_request|pr_reviewers_remove)
    pr_number="${1:-}"
    reviewers="${2:-}"
    teams="${3:-}"
    require_number "$pr_number" "Pull request number"
    if [ -z "$reviewers" ] && [ -z "$teams" ]; then
      echo "At least one reviewer or team reviewer required" >&2
      exit 1
    fi
    if [ "$action" = "pr_reviewers_request" ]; then method="POST"; else method="DELETE"; fi
    # GitHub requires `reviewers` on DELETE even when only teams are removed, so the body always carries both arrays.
    jq -n --arg r "$reviewers" --arg t "$teams" \
      '{ reviewers: ($r | split(",") | map(select(. != ""))), team_reviewers: ($t | split(",") | map(select(. != ""))) }' \
      | exec gh api -X "$method" "repos/{owner}/{repo}/pulls/$pr_number/requested_reviewers" --input - --jq '{ number, url: .html_url, requestedReviewers: [.requested_reviewers[].login], requestedTeams: [.requested_teams[].slug] }'
    ;;
  pr_ready|pr_convert_to_draft)
    pr_number="${1:-}"
    require_number "$pr_number" "Pull request number"
    if [ "$action" = "pr_ready" ]; then
      if ! gh pr ready "$pr_number" >/dev/null; then echo "Failed to mark pull request $pr_number ready for review" >&2; exit 1; fi
    else
      if ! gh pr ready "$pr_number" --undo >/dev/null; then echo "Failed to convert pull request $pr_number to draft" >&2; exit 1; fi
    fi
    exec gh pr view "$pr_number" --json number,state,isDraft,url
    ;;
  pr_merge|pr_auto_merge_enable)
    pr_number="${1:-}"
    method="${2:-}"
    subject="${3:-}"
    body="${4:-}"
    match_head="${5:-}"
    require_number "$pr_number" "Pull request number"
    case "$method" in
      merge|squash|rebase) ;;
      *) echo "Merge method must be merge, squash, or rebase" >&2; exit 1 ;;
    esac
    cmd=(gh pr merge "$pr_number" "--$method")
    if [ -n "$subject" ]; then cmd+=(--subject "$subject"); fi
    if [ -n "$body" ]; then cmd+=(--body "$body"); fi
    if [ -n "$match_head" ]; then cmd+=(--match-head-commit "$match_head"); fi
    if [ "$action" = "pr_auto_merge_enable" ]; then
      # gh drops --auto and merges at once when the PR is already mergeable; refuse instead of merging unguarded.
      merge_state=$(gh pr view "$pr_number" --json mergeStateStatus --jq .mergeStateStatus)
      if [ "$merge_state" = "CLEAN" ]; then
        echo "Auto merge is not available: pull request $pr_number is in clean status; merge it directly with pr_merge" >&2
        exit 1
      fi
      cmd+=(--auto)
    fi
    if ! "${cmd[@]}" >/dev/null; then
      echo "Failed to ${action#pr_} pull request $pr_number" >&2
      exit 1
    fi
    exec gh pr view "$pr_number" --json number,state,mergedAt,mergeCommit,autoMergeRequest,isInMergeQueue,url
    ;;
  pr_auto_merge_disable)
    pr_number="${1:-}"
    require_number "$pr_number" "Pull request number"
    if ! gh pr merge "$pr_number" --disable-auto >/dev/null; then
      # Already disabled is the requested end state, so a retry after a lost response still succeeds.
      if [ "$(gh pr view "$pr_number" --json autoMergeRequest --jq '.autoMergeRequest == null' 2>/dev/null || true)" != "true" ]; then
        echo "Failed to disable auto-merge on pull request $pr_number" >&2
        exit 1
      fi
    fi
    exec gh pr view "$pr_number" --json number,state,autoMergeRequest,url
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
  commit_list)
    limit="${1:-30}"
    sha="${2:-}"
    path="${3:-}"
    since="${4:-}"
    until="${5:-}"
    cmd=(gh api -X GET "repos/{owner}/{repo}/commits" -f "per_page=$limit")
    if [ -n "$sha" ]; then cmd+=(-f "sha=$sha"); fi
    if [ -n "$path" ]; then cmd+=(-f "path=$path"); fi
    if [ -n "$since" ]; then cmd+=(-f "since=$since"); fi
    if [ -n "$until" ]; then cmd+=(-f "until=$until"); fi
    exec "${cmd[@]}" --jq '[.[] | { sha, message: .commit.message, author: .commit.author.name, authorLogin: .author.login, date: .commit.author.date, url: .html_url }]'
    ;;
  compare)
    base="${1:-}"
    head="${2:-}"
    limit="${3:-100}"
    if [ -z "$base" ] || [ -z "$head" ]; then
      echo "Base and head revisions required for compare" >&2
      exit 1
    fi
    exec gh api "repos/{owner}/{repo}/compare/${base}...${head}" --jq "{ status, aheadBy: .ahead_by, behindBy: .behind_by, totalCommits: .total_commits, url: .html_url, commits: [.commits[:${limit}][] | { sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date }], files: [(.files // [])[:${limit}][] | { filename, status, additions, deletions, changes }], filesTotal: ((.files // []) | length) }"
    ;;
  release_list)
    limit="${1:-20}"
    exec gh release list --limit "$limit" --json tagName,name,isDraft,isPrerelease,isLatest,publishedAt
    ;;
  tag_list)
    limit="${1:-30}"
    exec gh api -X GET "repos/{owner}/{repo}/tags" -f "per_page=$limit" --jq '[.[] | { name, sha: .commit.sha }]'
    ;;
  pr_reviews)
    pr_number="${1:-}"
    require_number "$pr_number" "Pull request number"
    # Reviews arrive oldest first, so every page is read before taking each reviewer's latest state.
    # A COMMENTED review never replaces an earlier verdict, matching how GitHub computes review state.
    gh api --paginate --slurp "repos/{owner}/{repo}/pulls/$pr_number/reviews?per_page=100" | jq '
      (add // []) | map({ id, author: .user.login, state, submittedAt: .submitted_at, commitId: .commit_id, url: .html_url }) as $reviews
      | ([$reviews[] | select(.author != null and .state != "PENDING")] | group_by(.author)
          | map({ key: .[0].author, value: ((map(select(.state != "COMMENTED")) | last | .state) // "COMMENTED") })
          | from_entries) as $latest
      | { totalCount: ($reviews | length), reviews: $reviews, latestByReviewer: $latest,
          changesRequestedBy: [$latest | to_entries[] | select(.value == "CHANGES_REQUESTED") | .key],
          approvedBy: [$latest | to_entries[] | select(.value == "APPROVED") | .key] }'
    ;;
  ref_get)
    ref="${1:-}"
    require_ref "$ref"
    error_file=$(mktemp)
    if output=$(gh api "repos/{owner}/{repo}/git/ref/${ref#refs/}" --jq '{ ref, oid: .object.sha, objectType: .object.type }' 2>"$error_file"); then
      rm -f "$error_file"
      printf '%s\n' "$output" | jq '. + { exists: true }'
      exit 0
    fi
    errors=$(cat "$error_file")
    rm -f "$error_file"
    # The singular ref endpoint matches exactly, so 404 means this ref does not exist.
    if [[ $errors == *"HTTP 404"* ]]; then
      jq -n --arg ref "$ref" '{ ref: $ref, exists: false }'
      exit 0
    fi
    printf '%s\n' "$errors" >&2
    exit 1
    ;;
  commit_status_get)
    sha="${1:-}"
    limit="${2:-100}"
    require_revision "$sha"
    require_number "$limit" "Status limit"
    exec gh api -X GET "repos/{owner}/{repo}/commits/${sha}/status" -f "per_page=$limit" \
      --jq '{ sha, state, totalCount: .total_count, statuses: [.statuses[] | { context, state, description, targetUrl: .target_url, creator: .creator.login, createdAt: .created_at, updatedAt: .updated_at }] }'
    ;;
  check_runs_list)
    sha="${1:-}"
    limit="${2:-100}"
    check_name="${3:-}"
    require_revision "$sha"
    require_number "$limit" "Check run limit"
    cmd=(gh api -X GET "repos/{owner}/{repo}/commits/${sha}/check-runs" -f "per_page=$limit" -f "filter=latest")
    if [ -n "$check_name" ]; then cmd+=(-f "check_name=$check_name"); fi
    exec "${cmd[@]}" --jq '{ totalCount: .total_count, checkRuns: [.check_runs[] | { id, name, status, conclusion, headSha: .head_sha, startedAt: .started_at, completedAt: .completed_at, detailsUrl: .details_url, url: .html_url, app: .app.slug }] }'
    ;;
  workflow_runs_list)
    limit="${1:-20}"
    workflow="${2:-}"
    head_sha="${3:-}"
    branch="${4:-}"
    event="${5:-}"
    status="${6:-}"
    require_number "$limit" "Run limit"
    if [ -n "$workflow" ]; then
      require_workflow "$workflow"
      path="repos/{owner}/{repo}/actions/workflows/${workflow}/runs"
    else
      path="repos/{owner}/{repo}/actions/runs"
    fi
    cmd=(gh api -X GET "$path" -f "per_page=$limit")
    if [ -n "$head_sha" ]; then cmd+=(-f "head_sha=$head_sha"); fi
    if [ -n "$branch" ]; then cmd+=(-f "branch=$branch"); fi
    if [ -n "$event" ]; then cmd+=(-f "event=$event"); fi
    if [ -n "$status" ]; then cmd+=(-f "status=$status"); fi
    exec "${cmd[@]}" --jq '{ totalCount: .total_count, runs: [.workflow_runs[] | { id, name, workflowId: .workflow_id, path, event, status, conclusion, headSha: .head_sha, headBranch: .head_branch, runNumber: .run_number, runAttempt: .run_attempt, createdAt: .created_at, updatedAt: .updated_at, url: .html_url }] }'
    ;;
  workflow_run_view)
    run_id="${1:-}"
    limit="${2:-100}"
    require_number "$run_id" "Workflow run ID"
    require_number "$limit" "Job limit"
    # Each response is reduced by gh first and the two are joined on stdin: raw run and job payloads can
    # exceed the per-argument size limit of a command line.
    {
      gh api "repos/{owner}/{repo}/actions/runs/$run_id" --jq '{ id, name, workflowId: .workflow_id, path, event,
        status, conclusion, headSha: .head_sha, headBranch: .head_branch, runNumber: .run_number, runAttempt: .run_attempt,
        createdAt: .created_at, updatedAt: .updated_at, url: .html_url }'
      gh api -X GET "repos/{owner}/{repo}/actions/runs/$run_id/jobs" -f "per_page=$limit" -f "filter=latest" --jq '{ jobsTotal: .total_count,
        jobs: [.jobs[] | { id, name, status, conclusion, startedAt: .started_at, completedAt: .completed_at, url: .html_url,
          failedSteps: [(.steps // [])[] | select(.conclusion == "failure") | .name] }] }'
    } | jq -s '.[0] + .[1]'
    ;;
  commit_status_create)
    sha="${1:-}"
    state="${2:-}"
    context="${3:-}"
    description="${4:-}"
    target_url="${5:-}"
    if ! [[ $sha =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
      echo "Commit status SHA must be a full lowercase commit ID" >&2
      exit 1
    fi
    case "$state" in
      error|failure|pending|success) ;;
      *) echo "Commit status state must be error, failure, pending, or success" >&2; exit 1 ;;
    esac
    if [ -z "$context" ]; then
      echo "Commit status context required" >&2
      exit 1
    fi
    cmd=(gh api -X POST "repos/{owner}/{repo}/statuses/$sha" -f "state=$state" -f "context=$context")
    if [ -n "$description" ]; then cmd+=(-f "description=$description"); fi
    if [ -n "$target_url" ]; then cmd+=(-f "target_url=$target_url"); fi
    "${cmd[@]}" | jq --arg sha "$sha" '{ id, sha: $sha, state, context, description, targetUrl: .target_url, creator: .creator.login, createdAt: .created_at }'
    ;;
  workflow_dispatch)
    workflow="${1:-}"
    ref="${2:-}"
    inputs="${3:-}"
    require_workflow "$workflow"
    require_revision "$ref"
    if [[ $ref =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
      echo "Workflow dispatch ref must be a branch or tag, not a commit SHA" >&2
      exit 1
    fi
    if [ -z "$inputs" ]; then inputs='{}'; fi
    # The dispatch API answers 204 without a run ID, so the ref's commit is resolved first and
    # returned for a workflow_runs_list lookup by headSha and event workflow_dispatch.
    # The commits endpoint takes heads/NAME or tags/NAME, so a fully qualified ref drops its refs/ prefix.
    if ! head_sha=$(gh api "repos/{owner}/{repo}/commits/${ref#refs/}" --jq .sha); then
      echo "Ref $ref could not be resolved to a commit" >&2
      exit 1
    fi
    dispatched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq -n --arg ref "$ref" --argjson inputs "$inputs" '{ ref: $ref, inputs: $inputs }' \
      | gh api -X POST "repos/{owner}/{repo}/actions/workflows/${workflow}/dispatches" --input - >/dev/null
    jq -n --arg workflow "$workflow" --arg ref "$ref" --arg headSha "$head_sha" --arg dispatchedAt "$dispatched_at" \
      '{ dispatched: true, workflow: $workflow, ref: $ref, headSha: $headSha, dispatchedAt: $dispatchedAt,
         runLookup: { action: "workflow_runs_list", workflow: $workflow, headSha: $headSha, event: "workflow_dispatch" } }'
    ;;
  workflow_run_rerun_failed)
    run_id="${1:-}"
    require_number "$run_id" "Workflow run ID"
    gh api -X POST "repos/{owner}/{repo}/actions/runs/$run_id/rerun-failed-jobs" >/dev/null
    # The rerun has started once the POST succeeds, so a failed follow-up read must not report failure:
    # a retry would POST again and GitHub refuses to re-run a run that is already in progress.
    if ! gh api "repos/{owner}/{repo}/actions/runs/$run_id" --jq '{ id, status, conclusion, runAttempt: .run_attempt, url: .html_url, rerunRequested: true }' 2>/dev/null; then
      jq -n --argjson id "$run_id" '{ id: $id, rerunRequested: true }'
    fi
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
