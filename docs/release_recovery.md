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

## Can I reuse the tag?

**Yes — for retrying an identical build.** Re-pushing `vX.Y.Z` re-runs `release.yml` against the
same commit, producing the same artifacts; PyPI `skip-existing` skips whatever already uploaded
and completes the rest, and the GitHub Release step is idempotent. Recipe:

```bash
git tag -d vX.Y.Z                    # delete the local tag
git push origin :refs/tags/vX.Y.Z    # delete the remote tag
git tag -a vX.Y.Z -m X.Y.Z           # recreate on the same commit
git push origin vX.Y.Z               # re-trigger CI
```

**No — if you need to change anything shipped.** Bump to the next patch (`post-release.sh` will
have moved you to `X.Y.(Z+1)-alpha`) and cut that instead. Do not move a published tag to a new
commit and expect a re-publish; the already-published files won't be replaced.

## Why the pipeline is recoverable by design

- **npm publishes *before* PyPI.** In `release.yml`, `pypi-publish` `needs` `npm-publish`, so an
  npm failure aborts the run *before* any immutable PyPI version is burned. (npm runs in
  parallel with the slow wheel builds, so this costs almost no wall-clock.)
- **PyPI uses `skip-existing: true`** — re-runs never error on already-uploaded files.
- **Build jobs gate the publish jobs** — a build break can never half-publish.
- **The GitHub Release is gated on both publishes** — the "release" only appears once the
  packages are actually out.

## Failure playbook

| Where it failed | State | Do this |
| --- | --- | --- |
| **A build job** (`build-rfb`/`nvenc`/`vtenc`) | Nothing published | Fix the cause, then re-run: either re-run the failed jobs from the Actions UI, or re-push the tag (recipe above). Safe — no artifacts are out. |
| **`npm-publish`** | Maybe some npm packages out | Re-run. Already-published packages error (npm has no `skip-existing`) — publish only the missing ones by hand: `pnpm --dir widgets --filter "@habemus-papadum/rfb-<pkg>" publish --provenance --no-git-checks`. PyPI hasn't run yet (it's gated on npm), so nothing to undo there. |
| **`pypi-publish`** (e.g. rfb ok, nvenc failed) | Some PyPI files out (immutable) | Re-push the tag / re-run the job. `skip-existing` skips the uploaded files and completes the rest. **Never** rebuild-and-overwrite an existing file. |
| **`github-release`** | Packages published, no Release | Re-run the job, or locally: `gh release create vX.Y.Z --generate-notes` (or `gh release edit vX.Y.Z` if a draft exists). |
| **Need to change shipped content** | Version burned | **Bump to the next version and release that.** Do not attempt to overwrite. Avoid `npm unpublish` (72-hour window, discouraged, breaks anyone who installed it). |
| **`post-release.sh` (dev bump)** | Release is fine | Just re-run `./scripts/post-release.sh <bump>`; it's a plain commit + push. |

## Trusted-publishing / provenance gotchas

If `pypi-publish` fails with an **OIDC / trusted-publishing** error, the publisher isn't
configured for that project — add it (`pypi.org` → project → *Publishing*: owner
`habemus-papadum`, repo `pdum_rfb`, workflow `release.yml`, environment `pypi`), or use the
**pending publisher** form for a brand-new project, then re-run.

If `npm-publish` fails on **provenance** (`missing "repository" field` or an OIDC error): the
four published `package.json`s must carry a `repository` field, the repo must be public, and the
job must have `permissions: id-token: write` — all already set; a failure here usually means a
missing/incorrectly-scoped `NPM_TOKEN` secret (needs write on the whole `@habemus-papadum`
scope).

## Manual fallback

If CI is unavailable, you can publish out-of-band from a maintainer box with
`scripts/publish.sh` (PyPI) + the legacy `scripts/release.sh` (see
[Manual fallback](development.md#manual-fallback-scriptspublishsh-env)). The same immutability
rule applies: `skip`/`*_WHEEL_DIR` to complete a partial release; bump the version to change
content.
