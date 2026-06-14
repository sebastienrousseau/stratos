# Governance

This document describes how decisions are made in the Stratos project.

## Project model

Stratos is a **single-maintainer-with-deputies** project (sometimes called
BDFL-light). One maintainer holds the casting vote on direction and
release timing; one or two deputies have full write access and the
authority to merge routine changes (fixes, tests, docs, dependency-free
features that fit the design ethos). The maintainer-and-deputies are
listed in [`MAINTAINERS.md`](./MAINTAINERS.md).

This model is deliberate. Stratos is intentionally small (a single Node
ESM file with zero runtime dependencies). The cost of consensus-building
across a large governing body would exceed the rate at which the project
genuinely needs to evolve. As the project grows, the model is expected to
evolve toward a small steering committee — see *Evolution* below.

## Roles

### Maintainer (1)

- Sets the project's direction and the versioning policy
- Owns the `release.yml` workflow and the signing key
- Cuts releases and approves the release notes
- Casting vote on disputed decisions
- Listed first in `MAINTAINERS.md`

### Deputies (0–3)

- Full write access (branch protection still requires PR review)
- Authority to merge routine changes without explicit maintainer sign-off
- Triage incoming issues and PRs
- Maintain shipping channels they own (e.g. the Homebrew tap, the Scoop
  bucket, the docs site once it exists)

### Contributors (anyone)

- Open issues, submit pull requests, comment on RFCs
- All technical decisions are taken in public — the issue tracker is the
  forum, the PR description is the record

## How decisions are made

### Routine changes

Any deputy or the maintainer may approve and merge:

- Bug fixes that don't change public behaviour
- Test additions
- Documentation changes
- Dependency-free internal refactors
- New commands that fit the
  [`CONTRIBUTING.md`](./CONTRIBUTING.md) checklist

PR review by one maintainer/deputy is required; CI must be green.

### Direction-setting changes

The maintainer signs off on:

- Public-API additions (new top-level commands, new global flags, new
  output formats, new exit codes / error types)
- Anything that touches `release.yml` or the supply-chain story
- The `~/Drop/stratos-ip.md` implementation plan or its successors
- Versioning policy changes
- Adding or removing a maintainer or deputy

For these, the maintainer comments approval on the PR or issue. If the
maintainer is unavailable, a deputy can approve subject to the
maintainer's later review.

### Non-goals

Some scope decisions are made *not* to do something. These live in
[`NON-GOALS.md`](./NON-GOALS.md) and require the maintainer's sign-off to
add. Issue triage for "please add X" requests should check `NON-GOALS.md`
first.

### Disagreements

Technical disagreements get resolved in public, with concrete examples.
The pattern is:

1. State the position in the issue or PR thread
2. Provide the smallest reproducer or test case that demonstrates the
   tradeoff
3. The maintainer or a deputy summarises the decision and the rationale
4. If a deputy disagrees with the maintainer, the maintainer's vote is
   final, but the dissent is captured in the thread

There is no private decision channel. If a discussion needs to be off-record
(e.g. a security disclosure), the public outcome is still recorded
afterwards.

## Adding a maintainer or deputy

Deputies are added when:

- They have meaningfully contributed (multiple merged PRs, sustained
  engagement) over at least 8 weeks
- The maintainer trusts their judgement on the scope/non-scope line
- They are willing to take on triage and release-channel duties

The maintainer proposes the addition in an issue, names the deputy, and
asks for confirmation. If no objection is raised within 7 days, the
addition is effective.

The maintainer is the same person who started the project unless they
explicitly hand it over. A handover proposal is made in a dedicated
issue, the named successor agrees in writing on the issue thread, and the
handover is effective 14 days later (to allow community feedback).

## Removing a maintainer or deputy

A maintainer or deputy can step down at any time by opening a PR removing
themselves from `MAINTAINERS.md`. Their commit rights are revoked when the
PR merges.

In the rare case a deputy is *removed* against their will (Code of Conduct
violation, repeated direction-setting overreach), the maintainer proposes
removal in a private email to all current maintainers and deputies,
explains the reason, and merges the `MAINTAINERS.md` change once a 7-day
written notice has passed.

If the maintainer themselves is implicated in a Code of Conduct violation
or otherwise unable to continue, the deputies collectively select a
successor by simple majority. The chosen successor takes over after a
14-day public-comment period.

## Releases

The maintainer cuts releases. The mechanism is in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The versioning policy is in
[`CHANGELOG.md`](./CHANGELOG.md) (small `v0.0.x` increments until v1.0.0
is genuinely earned).

A deputy may cut a routine release (test additions, dep-bump, doc) with
maintainer approval recorded in the release-PR thread.

## Evolution

This model is for the current scale (single maintainer, a few
contributors, ~520 tests, ~3800 lines). If the project grows to 5+
sustained contributors or 5+ named production users, the maintainer will
propose a transition to a small steering committee with explicit voting
on direction-setting changes. The transition will be drafted in an RFC
issue and require both the maintainer's and a majority of deputies'
approval.

## Code of Conduct

All participation is subject to the
[Code of Conduct](./CODE_OF_CONDUCT.md). Enforcement is the maintainer's
responsibility; deputies assist with triage. Reports go to
**sebastian.rousseau@gmail.com**.
