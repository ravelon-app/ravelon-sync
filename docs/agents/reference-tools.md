# Compare the relevant tools

For substantial UI, navigation, terminal, agent, Git or remote-workflow changes,
use **Warp, Termius, Codex, Claude Code, T3 Code and Orca.dev** as concrete
references when they match the task. When the user says "like X", inspect that
specific flow and turn it into acceptance criteria instead of guessing from
the brand. Do not investigate all six for a typo or an isolated bug.

| Tool | Useful reference | Starting source |
| --- | --- | --- |
| Warp | Terminal/agent interaction, command blocks, workspace density | [Product/docs](https://docs.warp.dev/), [official repository](https://github.com/warpdotdev/warp) |
| Termius | Hosts/groups, credentials, SSH/SFTP, connection and mobile flows | [Official site](https://termius.com/), [official documentation](https://termius.com/documentation) |
| Codex | Agent threads, plans/questions, worktrees, review, provider events | [Official docs](https://developers.openai.com/codex/), [official CLI repository](https://github.com/openai/codex) |
| Claude Code | Permissions, planning, checkpoints, context, agent workflow | [Official docs](https://code.claude.com/docs/en/overview), [official public repository](https://github.com/anthropics/claude-code) |
| T3 Code | Agent workbench, host-owned execution, typed contracts, Git/mobile parity | [Official site](https://t3.codes/), [source](https://github.com/pingdotgg/t3code), [agent guidance](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md) |
| Orca.dev | Multiple agent worktrees, project/chat layout, browser, diff and remote control | [Official site](https://www.onorca.dev/), [source linked by that site](https://github.com/stablyai/orca) |

These are navigation pointers, not claims that every product component is open
source. Verify the repository's actual contents, version and licence when used.
Do not confuse Orca.dev with unrelated projects called Orca. For closed or
unavailable parts use official docs, screenshots or authorized local inspection;
say which implementation details remain unknown. Do not invent internals.

## Small comparison loop

1. Read existing Ravelon decisions/tests first. Select one or two references
   relevant to the flow, including the tool explicitly named by the user.
2. Inspect official behavior/docs. When source is available, read the relevant
   entry point, state owner, adapter/contract and tests, not just the README or
   screenshots. Pin the inspected commit/version and exact files in your notes.
3. State the useful behavior and underlying structure in a few lines: entry and
   exit paths, loading/error/reconnect states, session ownership, permissions,
   responsiveness and cross-device/provider consequences. Distinguish source
   evidence, observed behavior and inference.
4. Adapt the smallest useful pattern to Ravelon's Rust/Swift/React architecture,
   theme, security and subscription boundaries. Preserve existing functions,
   permissions and data. Do not clone a design system or add machinery just
   because another product has it. Check licence/attribution before reusing code;
   never copy proprietary assets or private data.
5. Verify the result in Ravelon and keep only the durable decision and source
   pointers in the relevant architecture/QA doc. Reuse valid prior research;
   refresh only when the product, source or affected behavior changed.

## Why the guidance is structured this way

Official guidance checked on 2026-11-09 supports short entry instructions,
scoped detail, explicit verification and mechanical enforcement:

- [OpenAI AGENTS.md](https://developers.openai.com/codex/guides/agents-md):
  instruction hierarchy and bounded combined context.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices):
  concise instructions, exact check commands and automated enforcement.
- [Claude memory/imports](https://code.claude.com/docs/en/memory):
  `CLAUDE.md` imports `AGENTS.md`; do not maintain divergent copies.
- [Cursor rules](https://cursor.com/docs/rules): scoped rules and references to
  canonical implementation instead of copied manuals.
- [T3 Code AGENTS.md](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md):
  minimal systems, ownership of processes/state and checking affected surfaces.
- [GitHub auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request):
  automatic merge depends on the actual required checks/reviews.

Do not treat an instruction as a guarantee: CI enforces documentation budgets
and consistency; behavior tests and an actual visual inspection enforce the
app-specific acceptance criteria.
