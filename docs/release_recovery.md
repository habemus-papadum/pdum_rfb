# Release recovery

What to do when a release goes wrong — a publish fails, a wheel build fails, a step after the
publish fails. Companion to [Releasing](development.md#releasing).

## The one rule

**Published versions are immutable.** Once a file exists on PyPI or a version exists on npm,
you can *never* overwrite it. So every recovery is one of two moves:

- **Finish the same version** — fill the gaps for a version whose tag exists.
- **Release a new version** — required whenever the *content* must change. You cannot "fix and
  re-publish `0.3.1`"; you release `0.3.2`.

## What ship does on failure

`ship release` runs, in order: write the version → `before-build` → build → tests → publish →
commit + tag + push → GitHub release → `<version>+dev` back. **Any failure before the publish is
reverted**: the working tree is restored, nothing was pushed, no tag exists. Fix the cause and
dispatch again; ship computes the same version from the unchanged last tag.

**A failure after the publish is not reverted** (the registry already has the version). ship
prints the remaining commands — the commit, the tag, the push, the release — so they can be run
by hand from a checkout of `main`. Because the publish happens *before* the tag is pushed, the
tag lagging the registry is the one state to watch for: `ship deps check` and the next release
both read tags, so finish the tag and push before anything else.

Before a release, ship asks the registry that the next version does not exist yet. If it does
(a half-finished release), finish that version rather than releasing again.

## Failure playbook

| Where it failed | State | Do this |
| --- | --- | --- |
| **CI gate** (the commit's `ci.yml` is red, missing, or timed out) | Nothing done | Fix CI and dispatch again, or dispatch with `skip_ci_check=true` if you accept the risk. |
| **`before-build`, build, or tests** | Nothing published; tree restored | Fix the cause, dispatch again (same version). |
| **publish** (PyPI or npm rejected the upload) | Possibly partial | A PyPI 403: `PYPI_API_TOKEN` is missing, revoked or not scoped to that project (`gh secret list`). An npm error: `NPM_TOKEN` needs write on the whole `@habemus-papadum` scope; provenance needs a public repository and `id-token: write`, which the caller grants. If nothing landed, dispatch again. If files landed, treat it as "after the publish". |
| **after the publish** (commit, tag, push, GitHub release, `+dev` write-back) | Registry has the version; tag or release missing | Run the commands ship printed from a clean checkout of `main`; at minimum commit the version, tag `<package>-v<version>`, push commit and tag together, `gh release create <tag> --generate-notes`, then write `<version>+dev` back and push. |
| **`build-nvenc-sdk-wheel.yml` / `build-vtenc-wheel.yml`** (a `build = false` package: ship tagged and released, the wheel build or its publish failed) | Tag and GitHub release exist; wheels missing | Fix the cause if it is the runner's, then re-run the workflow for the tag: `gh workflow run build-nvenc-sdk-wheel.yml -f ref=habemus-papadum-nvenc-v<version>` (or re-run the failed run). `uv publish --check-url` skips files PyPI already has and `gh release upload --clobber` is idempotent. **Do not release again** for a build failure; the version is cut. |
| **`build-wheels` dispatch job in `release.yml`** did not run or failed | Tag and release exist; no wheel run | Dispatch the wheel workflow by hand with `ref=<tag>` as above. |
| **Need to change shipped content** | Version burned | Release a new version (pick the bump). Do not attempt to overwrite. Avoid `npm unpublish` (72-hour window, discouraged, breaks anyone who installed it). |

## Checking state

```bash
uv run ship packages          # manifest version and last tag per package
uv run ship deps check        # every manifest must say <last tag>+dev
git ls-remote --tags origin 'habemus-papadum-rfb-v*'
gh release view habemus-papadum-nvenc-v<version>
```

## Auth notes (token publishing)

CI currently publishes with **token secrets** (not OIDC — the maintainer is locked out of PyPI
2FA; see the [migration proposal](proposals/active/trusted_publishing_migration.md)). The same
secrets serve the wheel workflows' `publish` jobs. There is no local publish path.
