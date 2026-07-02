# Migrate CI publishing back to trusted publishing (OIDC)

**Status:** active / temporary workaround in place
**Owner:** maintainer (Nehal)
**Trigger to close:** PyPI account access recovered (2FA re-established)



## Current (temporary) state

`release.yml` publishes token-based:

| Package set | Auth today | Secret |
|---|---|---|
| PyPI: `habemus-papadum-rfb`, `-nvenc`, `-vtenc` | API token via `pypa/gh-action-pypi-publish` `password:` | `PYPI_API_TOKEN` |
| npm: `@habemus-papadum/rfb-widgets` + 3 wrappers | `_authToken` npmrc + `pnpm publish --provenance` | `NPM_TOKEN` |

The `pypi-publish` job no longer sets `environment: pypi` or `id-token: write`; the
`npm-publish` job is unchanged (it was already token-based — it keeps `id-token: write`
only for **provenance** attestation, which is independent of the publish auth).

Releasing is CI-only — the `release` workflow (`workflow_dispatch`); there is no local release
script. `scripts/publish.sh` (reading `.env`) remains a token-based manual break-glass fallback.

### Uploading the secrets (one-time, from a maintainer box)

The token values already live in the maintainer's git-ignored `.env`
(`HATCH_INDEX_AUTH` = the PyPI token, `NPM_TOKEN` = the npm token). Upload them without
printing the values:

```bash
cd /path/to/pdum_rfb
set -a; . ./.env; set +a            # load .env into the shell (values stay in-process)
printf '%s' "$HATCH_INDEX_AUTH" | gh secret set PYPI_API_TOKEN
printf '%s' "$NPM_TOKEN"        | gh secret set NPM_TOKEN
gh secret list                       # verify both are present
```

Then a normal release (Actions → **release** → *Run workflow*, pick `bump`) publishes everything
from CI using the secrets.

## Security notes (accepted, time-boxed)

- **Long-lived tokens in CI secrets** are the exact risk trusted publishing removes: a
  workflow compromise (malicious dependency in a build step, a poisoned action) could
  exfiltrate them. Kept acceptable only because this is short-lived and the project is
  not mission-critical.
- **Scope:** the PyPI token is account-wide (it published all three projects at 0.1.0).
  If PyPI access is recovered enough to mint tokens but not enough to set up trusted
  publishing, replace it with **three project-scoped tokens** to limit blast radius.
- **Optional gate:** move the secrets into a `pypi` GitHub Environment with a required
  reviewer, so every publish needs a human approval. Skipped for now for simplicity.
- **Rotate on exit:** treat both tokens as potentially exposed once this window closes —
  see the migration checklist.

## Migration checklist (do this once PyPI access is back)

2. **PyPI trusted publishers** — for each of `habemus-papadum-rfb`, `habemus-papadum-nvenc`,
   `habemus-papadum-vtenc`: project → *Publishing* → *GitHub Actions* → add:
   `owner=habemus-papadum`, `repository=pdum_rfb`, `workflow=release.yml`, `environment=pypi`.
3. **GitHub environment**: `gh api -X PUT repos/habemus-papadum/pdum_rfb/environments/pypi`
   (optionally add a required reviewer).
4. **Revert `pypi-publish`** in `release.yml` to OIDC:
   - restore `environment: pypi` and `permissions: id-token: write`;
   - remove the `password: ${{ secrets.PYPI_API_TOKEN }}` line.
5. **npm trusted publishers** (optional, if moving npm off tokens too) — needs npm ≥ 11.5.1:
   ```bash
   npm install -g npm@latest
   for pkg in rfb-widgets rfb-react rfb-svelte rfb-solid; do
     npm trust github "@habemus-papadum/$pkg" --repo habemus-papadum/pdum_rfb \
       --file release.yml --allow-publish -y
   done
   ```
   Then rework `npm-publish` to OIDC. **Caveat:** pnpm does not yet do the OIDC handshake
   reliably (pnpm [#9812](https://github.com/pnpm/pnpm/issues/9812),
   [#11513](https://github.com/pnpm/pnpm/issues/11513) — `pnpm publish` via OIDC 404s), so
   the workflow must **`pnpm pack`** each package (resolves the wrappers' `workspace:^` →
   a concrete range) and then **`npm publish <tarball> --provenance`** with npm ≥ 11.5.1,
   which does the OIDC exchange. Validate on a `v0.1.1rc1` tag before a real release. Until
   this is proven, keeping npm on `NPM_TOKEN` is a reasonable steady state.
6. **Delete the CI secrets**: `gh secret delete PYPI_API_TOKEN` (and `NPM_TOKEN` if npm
   moved to OIDC).
7. **Rotate the tokens**: mint a fresh PyPI token and **revoke the old one**; if npm moved
   to OIDC, revoke the old npm automation token. Update `.env` locally.
8. Restore the "trusted publishing" wording in `release.yml`'s header and
   `docs/development.md`, and mark this proposal completed.

## Appendix: the trusted-publishing setup (target state)

Exact values for all registries, for when step 2/5 are executed:

- **PyPI (web UI, per project):** owner `habemus-papadum`, repository `pdum_rfb`,
  workflow filename `release.yml`, environment `pypi`. No API exists — it is web-UI only.
- **npm (`npm trust` CLI, per package):** repo `habemus-papadum/pdum_rfb`, workflow file
  `release.yml`, `--allow-publish`, no `--env` (the `npm-publish` job runs in no
  environment). One trusted-publisher config per package (`npm trust revoke --id <id>`
  to replace).

### Sources
- [PyPI — adding a trusted publisher](https://docs.pypi.org/trusted-publishers/adding-a-publisher/)
- [npm — trusted publishing](https://docs.npmjs.com/trusted-publishers/) · [`npm trust` CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [npm OIDC trusted publishing GA (2025-07-31)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
- [pnpm OIDC gaps — issue #9812](https://github.com/pnpm/pnpm/issues/9812) · [npm trusted-publishing gotchas](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)
