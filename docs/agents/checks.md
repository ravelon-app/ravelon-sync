# Verification by change

All checks apply to the final head SHA. Reuse current green CI; do not claim
a skipped or unrun suite passed. Fix relevant failures and preserve safeguards.

| Change | Checks before merge |
| --- | --- |
| Guidance/docs only | Guidance checker/tests, `git diff --check`, changed workflow syntax. Product CI still runs as configured; do not claim it was skipped. |
| Server/web behavior | Focused regression, then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. |
| Web UI/copy/theme | Above plus [UI evidence](ui-checklist.md) on the affected self-hosted flows and locales. |
| Auth/sync/access/migrations | Negative and happy-path tests for auth, MFA, conflict handling and access control; SQLite and PostgreSQL where relevant. |
| Packaging/deployment | Verify served web routes, health/public-config and unknown API 404s; relevant image/Compose checks. |

Focus an API file from `server/` with
`node --import tsx --test test/<file>.test.ts`. Tests use in-memory SQLite;
when testing a new TOTP step clear `last_totp_step` instead of sleeping.
CI currently tests Node 22/24/26 and PostgreSQL. Check every reported matrix job;
one green Node job is insufficient. Never add licensing or payment requirements
to make this public, self-hosted server resemble the commercial Cloud service.
