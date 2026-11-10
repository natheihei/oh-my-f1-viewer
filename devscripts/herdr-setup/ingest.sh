#!/usr/bin/env bash
# Watch this repo's GitHub issues labelled ready_for_agent and start one worker
# agent per issue, each in its own branch, git worktree and Herdr space.
# Run it inside Herdr; it keeps going until you stop it (Ctrl-C).
#
#   devscripts/herdr-setup/ingest.sh [options]
#
#   --label <name>     only take issues that also carry this label
#   --max <n>          keep at most n issues labelled agent_working open at once
#   --guidance <file>  append this file's text to every worker's first message
#   --create-labels    create the ready_for_agent / agent_working labels if missing
#
# Env: INGEST_POLL (seconds between polls, default 60),
#      INGEST_MODEL (default claude-opus-5-5), INGEST_EFFORT (default medium).
#
# For each issue it: re-checks it is open and still ready_for_agent; claims it
# (ready_for_agent -> agent_working, plus a comment); fetches origin/main and
# creates branch issue-<n>-<slug> from it in ~/.herdr/worktrees/<repo>/<branch>;
# opens a Herdr space there running claude with worker-prompt.md filled in.
# If anything after the claim fails, the labels are put back and the issue is
# not retried until the script restarts. Workers are never touched afterwards.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
poll=${INGEST_POLL:-60}
model=${INGEST_MODEL:-claude-opus-5-5}
effort=${INGEST_EFFORT:-medium}

filter_label=""
max=0
guidance_file=""
create_labels=0
while [ $# -gt 0 ]; do
  case $1 in
    --label) filter_label=${2:?--label needs a name}; shift ;;
    --max) max=${2:?--max needs a number}; shift ;;
    --guidance) guidance_file=${2:?--guidance needs a file}; shift ;;
    --create-labels) create_labels=1 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { echo "ingest: $*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

[ -n "${HC_TERMINAL_ID:-}" ] || fail "not inside Herdr (HC_TERMINAL_ID is unset)."
for cmd in gh git jq python3 herdr-app claude; do
  command -v "$cmd" >/dev/null || fail "$cmd is not installed."
done
[[ $max =~ ^[0-9]+$ ]] || fail "--max must be a number."
if [ -n "$guidance_file" ]; then
  [ -r "$guidance_file" ] || fail "can't read $guidance_file."
  guidance_file=$(realpath "$guidance_file")
fi

# Always operate from the main checkout, even if started from a worktree.
common_dir=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || fail "$here is not in a git repo."
main=$(dirname "$common_dir")
cd "$main" || fail "can't cd to $main."

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>&1) || fail "gh can't see this repo: $repo"
repo_name=$(basename "$main")

labels=$(gh label list --limit 500 --json name -q '.[].name') || fail "couldn't list labels."
for l in ready_for_agent agent_working; do
  grep -qx "$l" <<<"$labels" && continue
  [ "$create_labels" = 1 ] || fail "label $l is missing on $repo (rerun with --create-labels)."
  case $l in
    ready_for_agent) desc="Ready for an agent to pick up"; color=0e8a16 ;;
    agent_working) desc="An agent is working on this"; color=1d76db ;;
  esac
  gh label create "$l" --color "$color" --description "$desc" >/dev/null || fail "couldn't create label $l."
  log "created label $l"
done
if [ -n "$filter_label" ] && ! grep -qx "$filter_label" <<<"$labels"; then
  log "warning: label $filter_label doesn't exist on $repo yet"
fi

# --- start one worker ----------------------------------------------------------

# start_worker <n>: prints one result line; returns non-zero on failure.
start_worker() {
  local n=$1 claimed=0 info title url slug branch worktree base_sha guidance task args res

  undo() {
    if [ "$claimed" = 1 ]; then
      gh issue edit "$n" --remove-label agent_working --add-label ready_for_agent >/dev/null 2>&1
      gh issue comment "$n" --body "Agent couldn't start on this issue, so it's back to ready_for_agent: $1" >/dev/null 2>&1
    fi
    log "#$n failed: $1"
    return 1
  }

  info=$(gh issue view "$n" --json title,url,state,labels 2>&1) || { undo "gh issue view failed: $info"; return 1; }
  [ "$(jq -r .state <<<"$info")" = OPEN ] || { undo "issue is not open"; return 1; }
  jq -e '.labels | map(.name) | index("ready_for_agent")' <<<"$info" >/dev/null \
    || { log "#$n skipped: no longer labelled ready_for_agent"; return 0; }
  title=$(jq -r .title <<<"$info")
  url=$(jq -r .url <<<"$info")

  # Claim first, so another ingestor (or a restart) can't pick it up too.
  gh issue edit "$n" --remove-label ready_for_agent --add-label agent_working >/dev/null 2>&1 \
    || { undo "couldn't change labels"; return 1; }
  claimed=1
  gh issue comment "$n" --body "An agent picked this up and will post a plan for approval before implementing." >/dev/null 2>&1

  # Always branch from the remote's latest main, never the local checkout.
  git fetch --quiet origin main || { undo "git fetch origin main failed"; return 1; }
  base_sha=$(git rev-parse --verify --quiet "origin/main^{commit}") || { undo "origin/main not found"; return 1; }

  slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40 | sed -E 's/-+$//')
  branch="issue-$n${slug:+-$slug}"
  worktree="$HOME/.herdr/worktrees/$repo_name/$branch"

  git show-ref --verify --quiet "refs/heads/$branch" && { undo "branch $branch already exists"; return 1; }
  [ -e "$worktree" ] && { undo "$worktree already exists"; return 1; }
  git worktree add --quiet -b "$branch" "$worktree" "$base_sha" >/dev/null 2>&1 \
    || { undo "git worktree add failed"; return 1; }
  git -C "$worktree" branch --quiet --set-upstream-to=origin/main >/dev/null 2>&1

  guidance=""
  [ -n "$guidance_file" ] && [ -s "$guidance_file" ] && guidance="Guidance from the user for this work:
$(cat "$guidance_file")"

  task=$(W_ISSUE=$n W_REPO=$repo W_TITLE=$title W_URL=$url W_WORKTREE=$worktree \
    W_BRANCH=$branch W_BASE=origin/main W_GUIDANCE=$guidance \
    python3 -I -c '
import os, sys
t = open(sys.argv[1]).read()
for k in ("ISSUE", "REPO", "TITLE", "URL", "WORKTREE", "BRANCH", "BASE", "GUIDANCE"):
    t = t.replace("{{" + k + "}}", os.environ["W_" + k])
print(t.rstrip())
' "$here/worker-prompt.md")
  if [ -z "$task" ]; then
    git worktree remove --force "$worktree" >/dev/null 2>&1
    git branch -D "$branch" >/dev/null 2>&1
    undo "couldn't fill in worker-prompt.md"; return 1
  fi

  args=$(jq -cn --arg folder "$worktree" --arg task "$task" \
    --arg model "$model" --arg effort "$effort" --arg name "issue-$n" \
    '{folder:$folder, task:$task, argv:["claude","--model",$model,"--effort",$effort,"-n",$name]}')
  res=$(herdr-app do space.new "$args" 2>&1)
  if ! jq -e '.space' <<<"$res" >/dev/null 2>&1; then
    git worktree remove --force "$worktree" >/dev/null 2>&1
    git branch -D "$branch" >/dev/null 2>&1
    undo "herdr-app space.new failed: $res"; return 1
  fi

  log "#$n started: $title  branch=$branch  space=$(jq -r .space <<<"$res")  terminal=$(jq -r .terminal <<<"$res")"
}

# --- watch -------------------------------------------------------------------

declare -A failed=()
log "watching $repo for ready_for_agent issues${filter_label:+ labelled $filter_label}${guidance_file:+, guidance from $guidance_file}$([ "$max" -gt 0 ] && echo ", at most $max at once") (every ${poll}s)"

while :; do
  query=(--label ready_for_agent)
  [ -n "$filter_label" ] && query+=(--label "$filter_label")
  if ready=$(gh issue list "${query[@]}" --state open --limit 100 --json number -q '.[].number' 2>&1); then
    for n in $(sort -n <<<"$ready"); do
      [ -n "${failed[$n]:-}" ] && continue
      if [ "$max" -gt 0 ]; then
        working=$(gh issue list --label agent_working --state open --limit 100 --json number -q 'length' 2>/dev/null || echo "$max")
        if [ "$working" -ge "$max" ]; then
          log "at the limit ($working of $max working); #$n waits"
          break
        fi
      fi
      start_worker "$n" || failed[$n]=1
    done
  else
    log "poll failed: $(head -1 <<<"$ready")"
  fi
  sleep "$poll"
done
