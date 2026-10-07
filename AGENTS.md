# Repository guidelines

## What this is

Ravelon Sync is a self-hosted, zero-knowledge sync server for Ravelon clients.
The defining constraint: **the server stores ciphertext it cannot read**. Any
change that would let it read vault contents, or that quietly weakens a check
protecting that property, is wrong regardless of what it makes easier.

## Structure

- `server/src/` — Fastify API. `routes/` holds one file per area, `lib/` the
  shared primitives, `auth/` sessions and two-factor, `db/` the database
  abstraction and migrations.
- `server/test/` — Node's test runner, in-memory SQLite, one file per area.
- `web/src/` — React interface. `pages/` routed screens, `components/` shared
  UI, `lib/` API client, auth context, i18n and formatting.
- `web/src/locales/` — one file per language. English is the source.
- `docs/` — installation, configuration, security model, API, backup.

The web build outputs to `server/public/`, which the server serves. Do not
commit it, or `dist/`, `node_modules/`, `data/`, or any `.env`.

## Commands

```sh
npm install
npm run dev:server     # API on 4100
npm run dev:web        # interface on 5174, proxying the API
npm test
npm run typecheck
npm run lint           # Biome: lint and formatting check
npm run lint:fix       # apply safe lint fixes and formatting
npm run build
```

A change is not done until `npm test`, `npm run typecheck`, `npm run lint`
and `npm run build` all pass.

## Style

TypeScript everywhere. Two-space indent, semicolons. Server uses single
quotes, the web interface double quotes. Biome (`biome.json`) enforces the
formatting and lint rules; run `npm run lint:fix` rather than formatting by
hand. React components in PascalCase, hooks
prefixed `use`, helpers camelCase.

Comments explain why, not what. Restating the line below adds nothing; naming
the failure a piece of code prevents is worth keeping. Avoid Unicode dash
punctuation in source text.

Every visible string in the interface goes through `useI18n`. A hardcoded
string cannot be translated later without editing the component again.

## Security rules

These are not style preferences.

- Never log or return tokens, ciphertext, password material or recovery codes.
- Keep constant-time comparison for anything secret.
- Fail closed. An unexpected state refuses; it does not allow.
- Do not widen what an error reveals. "Vault not found or not accessible" is
  one message on purpose, so probing cannot distinguish the two cases.
- Do not resolve a security finding by deleting the check that surfaced it,
  relaxing `TRUSTED_PROXY_IPS`, or skipping authentication.
- Sensitive account changes require the password again, and a second factor
  where one is enrolled.
- Never commit secrets, `.env`, or key material.

## Testing

Add focused tests for changed behaviour. Files are `*.test.ts` under
`server/test/`. Authentication, sync conflict handling, access control and
two-factor need a test for anything that changes, because a regression there
is silent.

Tests run against in-memory SQLite with rate limiting off. When a test needs a
fresh TOTP step, clear `last_totp_step` rather than sleeping.

## Agent automation

Dependabot opens grouped weekly dependency updates; majors are left to a human.
Claude answers `@claude` on issues and pull requests, but only for accounts
that already have write access, because this repository is public.

Hard limits for every agent here:

- Never push to `main`. Never merge. Never force-push.
- Never commit secrets, `.env`, or key material.
- Do not resolve a security finding by deleting the check that surfaced it.
- A change is not done until `npm test`, `npm run typecheck`,
  `npm run lint` and `npm run build` pass.
- Do not silence a lint finding in security code by disabling the rule;
  fix it, or explain a targeted `biome-ignore` in its comment.

## Review guidelines

Flag P0 and P1 only: authentication bypass, anything that would let the server
read vault contents, leaked secrets, broken access control, a lost audit trail,
and CI that no longer runs the tests. Ignore style nits and optional refactors.
Treat Dependabot lockfile-only pull requests as review-only unless tests fail.

## Commits and pull requests

Short imperative summaries, one outcome each. Pull requests explain user
impact, list the commands run, and call out migrations, new environment
variables and security consequences explicitly.

Never edit a migration that has shipped. Append a new one.
