# Changelog

Notable changes, newest first. This project follows
[semantic versioning](https://semver.org).

## Unreleased

### Security

- Nodemailer 10.0.13 and a patched fast-uri. The previous versions had
  advisories for SMTP credential disclosure across transports, recipient
  parsing that could exhaust the stack, and host normalisation.

### New

- A team invitation lets the invited person create an account with that
  address, even when sign-up needs an invitation, and joins the team at once.
  The invitation page offers "Create account and join" next to signing in.
- Vaults and teams can be renamed in the web interface.

### Improved

- Deleting a team asks for its name first; it takes its vaults with it.
- The team dialogs explain that a team vault also needs its sharing key from
  the Ravelon app, sent separately from the invitation.
- Changing, resetting or setting a password explains that Ravelon asks for the
  previous password once to re-seal the vault key.
- Without mail, "Forgot password" no longer promises a link; it points to an
  administrator. The test button for mail saves the form first.
- The device list only shows devices that are still signed in.
- The vault table fits narrower windows.

### Fixed

- Deleting a vault or team and signing out a device worked, but the dialog
  stayed open and the list unchanged
- Saving the general settings showed no confirmation, and a refused mail test
  showed nothing
- After a second factor or a team invitation, sign-in ignored where it was
  supposed to return to
- Enter in the first step of turning on two-factor closed the dialog
- The recovery-code dialog could be closed with Escape or its close button
  before confirming the codes were saved
- A session revoked by signing out, a password change or a disabled account
  was logged as a stolen refresh token
- Sign-up mentioned a separate sync passphrase, and the overview named the
  wrong place in the app to enter the server
- Administrators were labelled "Administration"; counts read "1 members"

### Important

- `PUBLIC_URL` is now required when `NODE_ENV=production`; the server refuses
  to start without it. Invitation, reset and pairing links were otherwise built
  from request headers.
- `domain` sign-up now always requires a confirmed address before an account
  can sync.
- The Docker image is based on Node.js 24 LTS.

### Fixed

- A pull on PostgreSQL could report a cursor past a record that committed
  between two reads, so that record was never delivered
- A push based on a record the server no longer has (after restoring an older
  backup) was answered with a conflict no client could resolve; it is stored
- A record re-encrypted under its previous revision was acknowledged as
  unchanged and never stored
- Concurrent first pushes to a new vault on PostgreSQL failed with a server
  error, and could exceed the vault limit
- The long-poll fallback held requests for 50 seconds, past the iOS client's
  timeout, and answered at once for clients waiting on the sync cursor
- An expired token closed the event socket with a reason iOS read as a
  permanent refusal
- Restoring a record version could be undone by a device pushing its older copy
- Hashed interface assets were served uncacheable
- `scripts/backup.sh` could report success for a failed or partial backup, and
  the documented restore steps did not work

### Added

- The event socket is pinged every 25 seconds and access is checked again, so
  signed-out devices and removed members stop receiving notifications
- Pull pages are bounded by bytes instead of 100 rows, so a first sync of a
  large vault no longer runs into the rate limit
- `status` and `watch` report the sync cursor; `watch` accepts `afterCursor`
- Answers for hosted-only client requests (push registration, usage counters)
  instead of 404
- PostgreSQL test suite in CI

### Security

- Password reset links can no longer be pointed at another host with a forged
  `X-Forwarded-Host`
- The second-factor lockout per account now counts every wrong code
- Recovery codes, password change and device pairing share one per-account
  lockout; recovery codes and pairing require the second factor
- Content Security Policy and HSTS for the web interface
- Deleting an account no longer deletes teams and team vaults others use
- Two browser tabs no longer sign each other out
- Sign-up no longer reveals whether an address already has an account
- The first personal vault, which holds the account key, cannot be deleted
- Failed sign-ins, failed codes and refresh token reuse are audited
- The `@claude` workflow only runs for the person who triggered it having
  write access

## 1.0.0

First release.

### Added

- Self-hosted sync server for Ravelon desktop and iOS clients, compatible with
  the protocol current clients already speak
- Zero-knowledge sync: per-record encryption with compare-and-swap conflict
  detection, cursor-based pulls, tombstoned deletes and bounded version history
- WebSocket change events, plus a long-poll fallback for older clients
- Accounts with scrypt password hashing and rotating, single-use refresh tokens
- Two-factor authentication with TOTP, encrypted secrets, replay protection and
  one-time recovery codes
- Teams, shared vaults and four vault roles
- Invitation, domain-restricted, open and closed sign-up policies
- Browser-approved device pairing with a code to compare
- Web interface for administration and for members, in the Ravelon design
  language, with an i18n layer
- Audit log with configurable retention
- Optional SMTP; without it, invitation and reset links are shown to copy
- SQLite by default, PostgreSQL optional, with locked migrations
- Single-container deployment: API and interface on one port

### Security

- A push that looks like plaintext is refused rather than stored
- Vault key material naming an unwrapped secret is refused
- Refresh token reuse revokes the device
- Sign-in and password reset do not reveal whether an address has an account
- The last administrator cannot be demoted, disabled or deleted
- Sensitive account changes require the password again, and a code where one
  is enrolled
