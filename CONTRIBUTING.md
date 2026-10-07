# Contributing

Thanks for looking. This is a security-sensitive project that people run on
their own infrastructure, so the bar for changes is "would I run this", not
"does it compile".

## Getting set up

```bash
npm install
npm run dev:server     # API on http://127.0.0.1:4100
npm run dev:web        # interface on http://localhost:5174
```

Development needs no secrets; the server generates them at boot and warns that
it did.

## Before you open a pull request

```bash
npm test
npm run typecheck
npm run lint           # Biome: lint and formatting check
npm run build
```

All four, green. `npm run lint:fix` applies safe lint fixes and formatting. The test suite runs against in-memory SQLite and is fast.

## What a good change looks like

- **One outcome per pull request.** A bug fix and a refactor are two.
- **A test for changed behaviour.** Especially auth, sync conflicts and access
  control, where a regression is silent and expensive.
- **Explain the user impact.** Not what you changed, what it means for someone
  running this.
- **Call out migrations, new environment variables and security consequences.**
  Explicitly, in the description.

## Style

TypeScript throughout. Server uses single quotes, the web interface double
quotes; two-space indent and semicolons in both. [Biome](https://biomejs.dev)
enforces formatting and lint rules from `biome.json`, and CI runs it;
`npm run typecheck` is the arbiter for the rest.

The one-time formatting commit is listed in `.git-blame-ignore-revs`. To
skip it locally in `git blame`:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

Comments explain *why*, not what. A comment restating the line below it is
noise; one explaining why a conditional update is used instead of a read
followed by a write is worth keeping.

Visible strings in the web interface go through `useI18n`. A string typed
directly into a component cannot be translated later without touching the
component again.

## Security-relevant code

Changes to authentication, sessions, two-factor, access control or the sync
protocol get read closely. Please:

- Fail closed. An unexpected state refuses, it does not allow.
- Keep constant-time comparisons for anything secret.
- Never log tokens, ciphertext, password material or recovery codes.
- Never widen what an error reveals. "Not found or not accessible" is one
  message on purpose.
- Do not resolve a finding by removing the check that surfaced it.

If you are unsure whether something is a security change, assume it is and say
so in the description.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's "Report a vulnerability" on the
Security tab of this repository.

Include what you did, what happened, what you expected, and a proof of concept
if you have one. You will get an acknowledgement within a few days.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and what is
considered out of scope.

## Adding a language

1. Copy `web/src/locales/en.ts` to `web/src/locales/<code>.ts`
2. Translate the values, leave the keys alone
3. Register it in `web/src/lib/i18n.tsx`

English backs every lookup, so a partial translation shows real text rather
than a raw key. Partial translations are welcome.

## Licence

Contributions are accepted under the MIT licence in [LICENSE](LICENSE).
