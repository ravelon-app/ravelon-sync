# Ravelon repositories and branches

Each repository is independently versioned and must work in a standalone clone.
Use Git metadata to locate siblings; do not embed one developer's absolute paths.
Branch examples were observed on 2026-11-09; they do not assert current merge or
deployment state. Use the live commands below when a branch matters.

| Repository | Owns | Does not own |
| --- | --- | --- |
| `ravelon-app` | Tauri/Rust desktop, React UI, local sessions, vault, installed agent adapters/tools | Cloud billing and the mobile client |
| `ravelon-ios` | Native SwiftUI iPhone/iPad client, Keychain, StoreKit client, mobile agent control | Agent execution on the desktop or payment verification |
| `ravelon-website` | Public website, account/admin portals **and the commercial Pro Cloud API** in `server/`; accounts, billing, entitlements, hosted sync/relay | The MIT self-hosted product |
| `ravelon-sync` | **MIT open source**, self-hosted Fastify sync API and admin web UI; opaque encrypted data | Pro licences, subscriptions, checkout or the commercial Cloud API |

`ravelon-sync` is free self-hosting without a licence check. Adding a hosted
Pro feature to `ravelon-website/server/` does not add it to the self-hosted
server. Confirm explicitly which deployment receives a protocol change.

## Branch roles

| Branch/family | Purpose and base |
| --- | --- |
| `main` in each repo | Integrated default branch of that repo; normal PR target. A merge is not proof of installed/live availability. |
| `dev` (desktop, when present) | Integration/CI branch; use only for an explicitly scoped integration, not as an assumed base for every task. |
| `feat/*`, `feature/*`, `fix/*`, `docs/*`, `chore/*`, `ci/*`, `perf/*`, `refactor/*`, `copy/*`, `content/*`, `improve/*`, `refresh/*`, `deps/*`, `codex/*` | Bounded task branches, normally based on current `origin/main`; prefixes describe intent, not deployment environments. |
| `release/*`, `chore/release-*` | Release preparation/versioning; not the base for unrelated work. Creation/tagging/publication requires an explicit release task. |
| `agents-gap/*`, `integration/*` | Desktop audit work packages and their integration. Check actual PR dependencies and ancestor commits before taking one as a base. |
| `merge/*`, `tmp/*`, `qa/*` | Merge/conflict or QA scratch owned by another task; not authoritative main and not automatically yours to clean. |
| `dependabot/*` | Dependency bot proposals, handled by the repo's existing policy and checks. |

A branch name is local to one Git repository. Equal names across repos mean a
coordinated feature only when its PRs/contracts say so; they do not share commits.
An upstream of `origin/main` on a `fix/*` branch does not turn that branch into
main. For a stacked PR, document `base -> parent PR -> child PR`, merge in that
order and re-check the child against its new base. Never squash a branch with
unrelated inherited work into main.

## Cross-repo changes

| Area / observed branch names | Required relationship |
| --- | --- |
| Remote agents: `feat/computers-as-environments`, `feat/relay-environments`, historical `feat/remote-control` | Desktop owns execution/capabilities; iOS owns mobile control; website Cloud and self-hosted sync each own their server relay. Negotiate wire versions and test older clients/hosts. |
| `codex/agents-continuity-20261030` | Coordinated historical client/server continuity work; verify whether each PR is already merged rather than treating the branch name as current status. |
| `feat/public-links`, website `feat/cloud-public-links` | Desktop sealing/rendering plus server storage/viewer; Cloud and self-hosted implementations are separate. |
| `feat/chat-requests` | Desktop review/start/reply UI plus self-hosted Slack/Discord server routes; check commercial Cloud support separately. |
| Telemetry / `feature/android-telemetry`, `codex/telemetry-privacy` | Client consent and payload schema plus separate Cloud/self-hosted ingestion; keep content out of telemetry. |
| Release branches | Desktop and iOS versions/releases are independent; the website owns release listing/downloads, not the signed binaries' implementation. |

For any contract change name the affected repos and PRs, wire/API version,
compatibility/fallback, deployment order and the joint acceptance check in the
PR description. Implement only the sides required by the task, and report
unavailable/unshipped peers. Never claim end-to-end parity from one green repo.

## Get the live map cheaply

```sh
git status --short --branch
git remote -v
git worktree list --porcelain
git for-each-ref --sort=refname --format='%(refname:short) | %(upstream:short) | %(objectname:short) | %(contents:subject)' refs/heads refs/remotes/origin
gh pr list --state open --json number,title,headRefName,baseRefName,isDraft,url
```

Fetch `origin` once when remote state matters. Reuse the results during the task.
Do not open all historical branches or switch someone else's checkout just to
classify it. The subject/PR is evidence; a prefix alone is a hypothesis.

## This repo

`feat/chat-requests` and `feat/public-links` supply self-hosted server capabilities for the desktop peers. `codex/agents-continuity-20261030` is coordinated historical protocol work. This public MIT repo must not acquire commercial licensing/billing or private Cloud implementation/history. The server can expose different optional capabilities from hosted Cloud.
