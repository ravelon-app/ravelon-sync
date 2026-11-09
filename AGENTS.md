# Ravelon Sync agent guidance

This is the short entry point for Claude, Codex, Cursor and other agents.
Read only the linked sections relevant to the task. Current user instructions
take precedence; preserve other people's files, staging and worktrees.

## 1. Ownership

**MIT open-source self-hosted** Fastify API (`server/`) and React admin UI
(`web/`). This server stores opaque encrypted client data. It is free self-hosting
without licence checks. **The commercial Pro Cloud API and billing belong to
`ravelon-website/server/`**, not this repo. Desktop and iOS are separate clients.

Use [repositories.md](docs/agents/repositories.md) for branches and shared wire
changes. Default PR target is this repo's `main`. Equal branch names across
repos do not share history; confirm peers and deployment order explicitly.

## 2. Efficient execution

Check repo/branch/dirty files once. Use scoped `rg`, nearby code and relevant
sections of [repository-guide.md](docs/agents/repository-guide.md). Do not load
all docs/chats or repeat full scans. One agent by default, at most two bounded
independent children and no nested delegation. Act on clear authorized work.
No unrelated dependency upgrades, formatting or extra feature PRs. Follow
[workflow.md](docs/agents/workflow.md) for scope, handoffs and resource ownership.

## 3. Verification

Guidance: `python3 -B docs/agents/check.py` and
`python3 -B docs/agents/check_test.py`; no GUI/install needed.
Code: focused regression, then `npm test`, `npm run typecheck`, `npm run lint`
and `npm run build`. Use [checks.md](docs/agents/checks.md); check every applicable
Node/PostgreSQL CI job on the final head SHA. Reuse verified CI, not stale runs.

## 4. Security

The server never decrypts vault contents. Preserve constant-time comparisons,
auth/access controls, reauthentication/MFA, opaque errors and proxy trust.
Never log tokens, ciphertext, passwords or recovery codes. Never commit secrets,
`.env`, keys, data or build output. Append migrations; never edit shipped ones.
Read affected domain invariants in the [guide](docs/agents/repository-guide.md).
Never weaken checks, delete tests or add permissive fallbacks to get green.

## 5. Design and reference tools

Use existing components and `web/src/index.css` semantic tokens: current dark
palette, Inter UI and JetBrains Mono for technical text. Copy uses `useI18n`.
Follow [UI acceptance](docs/agents/ui-checklist.md); inspect the actual flow,
focus, responsive sizes, locales and applicable states before presenting it.
For significant workflows compare the relevant Warp, Termius, Codex, Claude
Code, T3 Code or Orca.dev flow and available source using
[reference-tools.md](docs/agents/reference-tools.md). Adapt to this product.

## 6. Completion

Work on a scoped branch and stage only this task's files/hunks. Never push
directly to `main`, force-push or bypass checks/hooks/reviews. **Standing
authorization: automatically squash-merge your own verified task PR without
asking again**, following [Automatic merge](docs/agents/workflow.md#automatic-merge).
All applicable checks/review/UI evidence must pass on the current head SHA;
draft/review-only requests or an instruction to leave it open take precedence.
Verify `MERGED`, not merely enabled auto-merge. Release/tag/publication/manual
rollout still requires explicit authority. Report actual tests and material gaps.

Track resources before opening them and clean up only your own tabs/sessions,
servers and containers; verify process start time and preserve shared services.
