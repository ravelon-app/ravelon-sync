# Changelog

Notable changes, newest first. This project follows
[semantic versioning](https://semver.org).

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
