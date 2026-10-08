# Claude on ravelon-sync

Follow `AGENTS.md`. These rules are not optional.

- Never push to `main`. Never merge. Open a pull request and stop.
- Never commit secrets, `.env`, or key material.
- The server must never be able to read vault contents. Do not add a route,
  a log line or a debug helper that would change that.
- Do not "fix" a security finding by deleting the check that surfaced it,
  skipping auth, or relaxing `TRUSTED_PROXY_IPS`.
- Auth, sync and access-control changes fail closed and need a test.
- A change is not done until `npm test`, `npm run typecheck`, `npm run lint`
  and `npm run build` pass.
- Never edit a shipped migration. Append a new one.
- Server: single quotes. Web: double quotes. Both: TypeScript, two spaces,
  semicolons, enforced by Biome (`npm run lint:fix`). Visible copy goes
  through `useI18n`.
- Commits: short imperative summaries, one outcome each.
