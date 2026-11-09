# Working and completing a task

Read only the sections needed for the task. AGENTS.md is the entry point for
every provider; this file owns the shared completion policy.

## Efficient execution

- Establish repo, branch, worktree, dirty files and acceptance criteria once.
  Reuse that evidence until something changes. A sibling repo or a branch with
  the same name is not the same checkout.
- Act on clear requests. Decide reversible implementation details yourself;
  ask only for missing information that materially changes the result, credentials
  the user must enter, destructive choices or authority not already granted.
  Optional questions must not stop independent useful work. Do not add a design
  approval ritual to a clear, authorized maintenance task.
- Start with `rg --files` and scoped `rg -n`. Read the relevant guide and nearby
  implementation, not every architecture file, locale, chat or entire large file.
  Bound command output; keep full logs in ignored task scratch and inspect the
  failure and summary. Do not repeat a full scan without new evidence.
- Use one agent by default. Delegate only independent, bounded work when it
  saves time or gives a useful independent review; at most two children at once,
  no nested delegation. Give a short brief, paths and acceptance checks, not the
  whole chat. Prefer event/completion notifications to repeated status polls.
- Keep the current authorized model/provider. Do not change subscriptions,
  spend money, start local models or fall back to billed APIs to save tokens.
- Test the changed behavior while iterating. Before merge run the applicable
  matrix in [checks.md](checks.md), reusing green CI on the same head SHA.
  Re-run after relevant changes or failures, not after every prose edit.
- Fix introduced and related defects. Investigate any check failure enough to
  identify its cause. Unrelated existing defects get a concise reproducible
  record and impact; do not silently expand one task into many branches or
  broad refactors. A relevant unresolved failure still blocks completion.
- Dependency/toolchain updates belong to the requested change or a separately
  authorized maintenance task. No automatic major upgrades, `npm update`,
  lockfile churn or repo-wide formatting during an unrelated fix.
- On a real task handoff, record goal, branch/SHA, changed paths, verified
  commands, remaining work and resource ownership in one short note. Read old
  chats only when a specific unresolved decision needs them. Never commit
  private transcripts, credentials or approval-review logs as project guidance.

## Automatic merge

The maintainer gives standing authorization for agents to commit, push, open
and **squash-merge their own PR for the authorized task without asking again**.
This supersedes earlier instructions requiring a new per-PR merge request.
A user request for review-only, a draft, a plan, a handoff, or to leave a PR
open takes precedence. A historical backlog PR needs its own review; it is not
automatically verified by this policy.

Before merging:

1. Read the final diff against the intended base. Confirm the scope, repo and
   branch; include only this task's selected files/hunks. Resolve actionable
   review findings. Use a bounded independent review for substantial changes,
   security/billing/crypto work or cross-repo contracts when tools permit.
2. Record the current PR head SHA. Required checks **and every relevant
   reported check** must finish successfully on that SHA. A skipped job is
   acceptable only when the repo's path planner proves it does not apply.
   Missing checks are not green checks. Establish the documented evidence
   yourself when CI intentionally does not cover that path.
3. Complete the functional and UI checks that apply, including native/device
   checks when a browser fixture cannot exercise the changed behavior.
   An unverified critical flow is a blocker, even with green unit tests.
4. Re-read mergeability, draft state, reviews, effective rulesets and status
   immediately before merging. A new commit invalidates old review/test
   evidence for the changed area. Conflicts, requested changes, failed or
   pending relevant checks block a merge. Do not bypass protection, reviews,
   hooks, security checks or a merge queue; never use `--admin` or force-push.
5. When everything is green, merge with the checked head SHA, for example
   `gh pr merge <PR> --squash --match-head-commit <SHA>`. Prefer GitHub auto-merge
   while waiting **only if effective required checks enforce every remaining
   gate**. `--auto` can merge immediately on an unprotected branch; otherwise
   wait for the checks and perform the verified merge yourself. Use event
   monitoring when available, with bounded waits and concise status changes.
6. Verify GitHub reports `MERGED` and a merge commit on the intended base.
   Enabled auto-merge, a queued PR or a successful push is not a completed
   merge. Fetch and fast-forward a primary checkout only if it is on that base,
   has no independent commits or tracked edits, and untracked files cannot
   collide with incoming paths; preserve other branches and edits.
   Delete only your own unneeded branch/worktree, after checking ownership.

If blocked, repair the cause within scope and keep working. If external access
or a user decision is truly required, report the PR link, concrete blocker,
verification state and next action. Do not end with a bare unmonitored PR.

Existing Dependabot workflows keep their narrower author/ecosystem/major
conditions. Do not widen their bot permissions or use them to merge feature PRs.
Merge authorization does not authorize a new release, version bump, tag,
installer publication, signing change, App Store submission, manual production
rollout or paid external action. Existing main-triggered CI remains as configured.

## Resource ownership on a 16 GB Mac

Prefer CLI/APIs. Before opening a GUI, browser, simulator, server or container,
record the baseline plus your own PID and start time, tab/window ID, simulator
UDID or container ID. Use explicit handles and finally/trap cleanup.

Close owned tabs/windows with the relevant API and release your browser session
explicitly; preserve logins/profiles. Quit an app normally only if you started
it, it is not shared and it has no unsaved/human work. A closed window is not
proof that its app exited. Verify PID/start time again before stopping a process.

Never stop user apps, shared browsers, Hermes/coding gateways, voice assistants,
remote access or persistent services. No pattern-based process killing or RAM
purge. Preserve uncertain resources and name them. At success, failure or abort,
verify all your temporary resources stopped; name an intentional running result
and its stop command, or any cleanup exception.

## Evidence in the final reply

State the result, relevant checks, merge state and material gaps briefly in
German unless asked otherwise. Distinguish implemented, tested, merged,
installed, submitted and live. Do not claim device/provider/platform acceptance
from mocks or claim token/billing savings from file size alone.
