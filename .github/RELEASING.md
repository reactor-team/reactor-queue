# Releasing

`@reactor-team/queue` is distributed to npm automatically by
[`.github/workflows/release.yml`](./workflows/release.yml). You never run
`npm publish` by hand for a normal release, and there is **no `NPM_TOKEN`** —
publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC), which authenticates the GitHub Actions workflow itself.

| Package               | Directory        | Release tag    |
| --------------------- | ---------------- | -------------- |
| `@reactor-team/queue` | `packages/queue` | `queue/vX.Y.Z` |

## How a release happens

The **version field in `packages/queue/package.json` is the trigger.** On every
push to `main`, the workflow checks it: if the version has no matching release
tag yet, it builds, publishes to npm, and cuts a `queue/v<version>` GitHub
release. If the version already has a tag, the job is a no-op.

So the flow is:

1. Merge normal PRs freely — **a version bump is not required to merge**, and a
   PR that doesn't bump the version releases nothing.
2. When you want to ship, open a PR that bumps `version` in
   `packages/queue/package.json` (plus a changelog entry if you keep one).
3. Merge it. The job sees a version with no tag, publishes it, and tags the
   release.

Because the tag is the "already released" marker, the workflow is safe to
re-run and safe to run on every push — it only ever publishes a version once.

### Picking a version

Use semver and bump the package you're shipping:

```bash
# from the package directory
cd packages/queue
pnpm version patch   # or minor / major — edits package.json, no git tag pushed
```

`pnpm version` writes the new number into `package.json`; commit that on your
branch. (The git tag it creates locally is irrelevant — CI cuts the real,
namespaced tag on merge. Delete the local tag if it bothers you.)

## One-time setup: trusted publishing

npm trusted publishing has a chicken-and-egg: **you can only configure a trusted
publisher for a package that already exists on npm.** So the package needs a
single manual bootstrap publish, after which CI takes over forever.

1. **Bootstrap publish from your machine** (creates the package on npm):

   ```bash
   npm login                      # an account with publish rights to @reactor-team
   pnpm install
   pnpm build
   pnpm --filter @reactor-team/queue publish --no-git-checks
   ```

   `pnpm publish` respects `publishConfig.access: public`. (No provenance is
   generated here — that needs CI — which is exactly why this step is manual.)

2. **Configure the trusted publisher** on npmjs.com: go to
   `https://www.npmjs.com/package/@reactor-team/queue/access` → **Trusted
   Publisher** → **GitHub Actions**, and enter:
   - **Organization / user:** `reactor-team`
   - **Repository:** `reactor-queue`
   - **Workflow filename:** `release.yml`
   - **Environment:** _(leave blank)_
   - **Allowed actions:** enable **`npm publish`** (required for publisher
     configs created after 2026-05-20).

From then on, never publish by hand. Bump the version in a PR, merge, and the
workflow publishes with provenance over OIDC.

## Requirements baked into the workflow

These are already configured; listed here so they aren't accidentally removed:

- **`permissions: id-token: write`** in `release.yml` — without it the OIDC
  token can't be minted and publishing falls back to (nonexistent) tokens.
- **`permissions: contents: write`** — needed to create the release tag.
- **Node 24** in `actions/setup-node` — trusted publishing needs npm ≥ 11.5.1,
  which ships with Node 24.
- **pnpm ≥ 10.28** (pinned via `packageManager` in the root `package.json`) —
  earlier pnpm mishandles the `${NODE_AUTH_TOKEN}` placeholder that
  `setup-node` writes and 404s instead of falling back to OIDC.
- **`repository` + `publishConfig.access`** in `packages/queue/package.json` —
  the `repository` URL is required for provenance; `access: public` makes the
  scoped package public.

## Troubleshooting

- **`404 Not Found` on publish** — the package doesn't exist yet (do the
  bootstrap publish) or the trusted publisher isn't configured for it.
- **`401`/`403` / "unable to authenticate"** — the trusted publisher fields
  don't match: check org, repo, and that the workflow filename is exactly
  `release.yml`. A package can have only one trusted publisher at a time.
- **Provenance error** — confirm `id-token: write` is present and the package's
  `repository.url` points at this repo.
- **Nothing published after merge** — the version probably already has a tag.
  Check the run logs for the `Release skipped` notice, and bump the version.
