# UI and theme acceptance

Use this before editing a visible surface. Also consult
[reference-tools.md](reference-tools.md) for substantial new/changed workflows.

1. Inspect the current screen and its nearest accepted component. Record the
   specific desired change, the applicable theme/type/spacing tokens and states.
   Existing product conventions win over a generic redesign prompt.
2. Reuse primitives and semantic tokens. Do not introduce arbitrary colors,
   fonts, fixed text sizes, shadow/radius systems or a dependency for a one-off
   view. Native exceptions must be deliberate and justified.
3. Preserve functionality: routes, APIs, permissions, validation, session/state
   ownership, localization and all entry/exit paths. Check supported providers
   and local/remote modes when the flow depends on them.
4. Run the affected behavior/design checks and open the actual changed flow.
   Inspect populated, loading, empty, error, disabled and focus/keyboard states
   that apply, at the sizes/themes below. Fix clipping, overflow, inconsistent
   tokens, contrast and console warnings before asking the user to review.
5. Save a small set of genuine screenshots/verification notes with build/commit,
   route, state, viewport/device, theme and observed result. Compare with the
   baseline or intended behavior. Do not bless a snapshot merely to make it
   green; review intentional visual changes. Never commit customer data.
6. Before merge, state what was actually seen and any native/device/provider
   gap. For a critical visible flow a unit test or a simulated screenshot alone
   is insufficient. Clean up owned resources as in [workflow.md](workflow.md).

## Self-hosted admin UI

The implemented visual source is `web/src/index.css`, not a DESIGN.md assumed
to exist in this repo. Reuse `panel`, semantic `--color-*` tokens, existing
forms/buttons/focus treatment and the current dark palette. Inter is the UI
font; JetBrains Mono is for technical text. Keep reduced-motion behavior.

Inspect affected setup/sign-in/vault/account/admin flows at phone (390), tablet
(768) and desktop (1440) widths, with keyboard/focus, long localized text,
validation, empty/error/loading states and any permission differences. Test the
actual web build served by this server when routing/deployment is affected.
Do not introduce Pro upsells, licence checks or Cloud account assumptions.


## Small evidence format

Use the PR description or existing QA report, not a new diary on every task:
`Commit/build | route/flow | viewport/device | theme/type | state | result | image/log`.
A small copy fix needs proportionate evidence; a new global token or navigation
requires all affected surfaces. Documentation-only changes need no UI launch.
