# Release recovery

What to do when a release goes wrong — a CI build fails, a publish half-completes, a tag needs
re-running. Companion to [Releasing](development.md#releasing-the-pipeline).

## The one rule

**Published versions are immutable.** Once a file exists on PyPI or a version exists on npm,
you can *never* overwrite it. So every recovery is one of two moves:

- **Retry the same version** — safe, and only *fills gaps*. Requires the artifacts to be
  byte-identical (they are: same tag → same commit → same build). This is what `skip-existing`
  on PyPI and re-pushing the tag are for.
- **Bump to a new version** — required whenever the *content* must change. You cannot "fix and
  re-publish `0.3.0`"; you publish `0.3.1`.

## Retrying: re-run vs re-dispatch

The tag is cut **by CI** (the `prepare` job), not pushed by hand — so recovery is about the
*run*, not the tag:

- **Retry the same version → "Re-run failed jobs"** on the failed run (Actions → the run →
  *Re-run failed jobs*). Same tag → same commit → byte-identical artifacts; PyPI `skip-existing`
  fills whatever didn't upload and the GitHub Release step is idempotent. This is the move for a
  **transient** failure (a flaky network, a secret you just added).
- **A fresh dispatch always cuts a NEW version.** `prepare` computes `bump(last tag, bump)`, and
  the failed run already pushed `vX.Y.Z`, so re-dispatching yields `vX.Y.(Z+1)` (or higher) — it
  will **not** retry `X.Y.Z`. Use a fresh dispatch only when you need to **change shipped
  content** (immutability rule): you cannot fix and re-publish `0.3.0`; you release `0.3.1`.

> A `git push` can't re-trigger anything (there is no tag trigger) — everything is a
> `workflow_dispatch` or a job **re-run** from the Actions UI. If `prepare` failed *before*
> tagging, nothing was pushed: just fix and dispatch again (it computes the same version).

## Why the pipeline is recoverable by design

- **npm publishes *before* PyPI.** In `release.yml`, `pypi-publish` `needs` `npm-publish`, so an
  npm failure aborts the run *before* any immutable PyPI version is burned. (npm runs in
  parallel with the slow wheel builds, so this costs almost no wall-clock.)
- **PyPI uses `skip-existing: true`** — re-runs never error on already-uploaded files.
- **Build jobs gate the publish jobs** — a build break can never half-publish.
- **The GitHub Release is gated on both publishes** — the "release" only appears once the
  packages are actually out.
- **The `+dev` finalize is gated on both publishes** — `main` returns to the dev marker only
  after a real publish; if *only* `finalize` fails, the release itself already succeeded.

## Failure playbook

| Where it failed | State | Do this |
| --- | --- | --- |
| **A build job** (`build-rfb`/`nvenc`/`vtenc`) | Nothing published | Fix the cause, then **Re-run failed jobs** (transient), or dispatch a fresh release (a code fix needs a new version). Safe — no artifacts are out. |
| **`npm-publish`** | Maybe some npm packages out | Re-run failed jobs. Already-published packages error (npm has no `skip-existing`) — publish only the missing ones by hand: `pnpm --dir widgets --filter "@habemus-papadum/rfb-<pkg>" publish --provenance --no-git-checks`. PyPI hasn't run yet (it's gated on npm), so nothing to undo there. |
| **`pypi-publish`** (e.g. rfb ok, nvenc failed) | Some PyPI files out (immutable) | **Re-run failed jobs.** `skip-existing` skips the uploaded files and completes the rest. **Never** rebuild-and-overwrite an existing file. |
| **`github-release`** | Packages published, no Release | Re-run the job, or locally: `gh release create vX.Y.Z --generate-notes` (or `gh release edit vX.Y.Z` if a draft exists). |
| **`finalize`** (the `+dev` bump) | Release is fine | Re-run the `finalize` job, or locally: `python3 scripts/_versioning.py set X.Y.Z+dev` (X.Y.Z = the release just cut) → `uv lock` → commit + push `main`. |
| **Need to change shipped content** | Version burned | **Dispatch a fresh release** (pick the bump); `prepare` computes the next version from the last tag. Do not attempt to overwrite. Avoid `npm unpublish` (72-hour window, discouraged, breaks anyone who installed it). |

## Auth gotchas (token publishing)

CI currently publishes with **token secrets** (not OIDC — the maintainer is locked out of PyPI
2FA; see the [migration proposal](proposals/active/trusted_publishing_migration.md)).

If `pypi-publish` fails with a **403 / auth** error, the `PYPI_API_TOKEN` secret is missing,
revoked, or not scoped to that project — check `gh secret list` and that the token covers all
three projects. (Once trusted publishing is restored, an **OIDC** error there instead means the
publisher isn't registered — add it per the migration proposal, then re-run.)

If `npm-publish` fails on **provenance** (`missing "repository" field` or an OIDC error): the
published `package.json`s must carry a `repository` field, the repo must be public, and the job
must have `permissions: id-token: write` — all already set; a failure here usually means a
missing/incorrectly-scoped `NPM_TOKEN` secret (needs write on the whole `@habemus-papadum`
scope).

## Break-glass fallback

If CI is unavailable, publish out-of-band from a maintainer box with `scripts/publish.sh` (see
[Break-glass fallback](development.md#break-glass-fallback-scriptspublishsh-env)). The same
immutability rule applies: `SKIP_*` / `*_WHEEL_DIR` to complete a partial release; bump the
version to change content.
