---
name: deploy-partykit
description: Deploy a @reactor-team/queue PartyKit waiting-room server to your own Cloudflare account (cloud-prem) so the room runs on your Cloudflare Workers + Durable Objects under a `<name>.<your-org>.workers.dev` host (or a domain you control). Use after building a queue demo with the building-reactor-queue-demos skill, when you're ready to ship the PartyKit room beyond `partykit dev`. Covers the Cloudflare account + API token setup, the Workers Paid and workers.dev-subdomain requirements, the inline `partykit deploy --domain` command, passing the queue's secrets with `--var`, the expected (and harmless) one-time PartyKit GitHub login, pointing your web app at the deployed host, and the common footguns — free-plan Durable Objects failure, wrong account id, the deploy silently falling back to PartyKit's hosted platform, secrets from `.env` not being uploaded, and custom-subdomain zones being Enterprise-only. Also covers *optionally* automating the deploy as a GitHub Action on every push to main — this is opt-in, so suggest it and only add it when the user explicitly asks — including how to generate the `PARTYKIT_TOKEN`/`PARTYKIT_LOGIN` PartyKit variables for non-interactive CI auth (since CI can't do the browser login) and branch-scoped GitHub Environment secrets.
---

# Deploying a `@reactor-team/queue` room to Cloudflare (cloud-prem)

You've built a queue demo (see the `building-reactor-queue-demos` skill): a
`partykit.json` and a `partykit/server.ts` that does
`export default createReactorQueueServer({ … })`, plus a web app that connects to
it. So far it only runs under `partykit dev`. This skill ships the PartyKit room
to **production on your own Cloudflare account** — _cloud-prem_: the room runs on
**your** Cloudflare Workers + Durable Objects, not on PartyKit's hosted platform.

The deployed room is a backend WebSocket endpoint your web app talks to; end
users never see its URL. It deploys **separately** from your web app — the app
(Vercel, etc.) just needs the room's host in one env var.

> **There are two ways to deploy a PartyKit app.** `partykit deploy` with no
> `--domain` publishes to PartyKit's **hosted platform** (`*.partykit.dev`) —
> quick, but it runs on infrastructure you don't own. This skill uses
> **cloud-prem** instead: you pass `--domain` + your Cloudflare credentials and
> the room lands on **your** account. Prefer cloud-prem for anything you want to
> own, rate-limit, or keep on your own org's domain.

## Before you deploy

- The queue project checked out locally, with `partykit` available as a
  devDependency (run it via `pnpm exec partykit`).
- A **Cloudflare account on the Workers Paid plan** (see below — this is not
  optional).
- That account's **Account ID** and an **API token** (see below).
- A **`workers.dev` subdomain** enabled on the account (gives you
  `<your-org>.workers.dev`), or a domain you control as a Cloudflare zone.

Keep the room's runtime config (`model`, `coordinatorUrl`, `maxSessions`,
`usersPerSession`, durations, …) **in code** in `createReactorQueueServer({ … })`.
Then the deploy only has to carry the two secrets, and there's no per-deploy
config to keep in sync. (The building skill covers this pattern.)

## One-time Cloudflare setup

1. **Workers Paid plan.** PartyKit rooms are **classic Durable Objects**. The
   free Workers plan only supports SQLite-backed Durable Objects, so a free-plan
   deploy fails with a Durable Objects plan error. Enable **Workers Paid** on the
   Cloudflare account you're deploying to (Cloudflare dashboard → Workers & Pages
   → Plans). This is the single most common reason a first deploy fails.

2. **A `workers.dev` subdomain.** To publish at `<name>.<your-org>.workers.dev`
   you need a workers.dev subdomain registered for the account: Cloudflare
   dashboard → Workers & Pages → Overview → set your subdomain (e.g.
   `your-org`). Without it there's no `<your-org>.workers.dev` to deploy under.

3. **An API token + the Account ID.** Create a token from the **“Edit Cloudflare
   Workers”** template (Cloudflare dashboard → My Profile → API Tokens →
   Create Token). Copy the **Account ID** from the account's Workers & Pages
   page. **The token must be scoped to the account that has Workers Paid** — a
   token for a different account (e.g. a personal one on the free plan) will hit
   the Durable Objects plan error even though the token “works”.

Treat the account ID + token as secrets. Store them in your org's secret manager
(1Password, Vault, etc.) — never commit them.

## Deploy

Run from the directory that contains `partykit.json`. Pass **everything inline** —
do not rely on a `.env` file:

- The Cloudflare credentials must be **inline environment variables** on the
  command. They (together with `--domain`) are what switch the deploy into
  cloud-prem mode.
- The queue's secrets go through **`--var`** flags. Values sitting in a `.env`
  are **not** reliably uploaded to the Worker.

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
  pnpm exec partykit deploy \
    --name <your-queue> \
    --domain <your-queue>.<your-org>.workers.dev \
    --var RQ_REACTOR_API_KEY=<reactor-api-key> \
    --var RQ_ADMIN_PASSWORD=<admin-password>
```

- **`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`** — from your secret manager.
  Without them (or without `--domain`) PartyKit falls back to its hosted
  platform.
- **`--var RQ_REACTOR_API_KEY`** — required; the Reactor API key the queue uses
  to mint JWTs and create/stop sessions. It's a secret — keep it out of the repo.
- **`--var RQ_ADMIN_PASSWORD`** — optional; only if you enabled the admin
  dashboard. Add a `--var` for any other config your `createReactorQueueServer`
  reads from env; anything you don't override falls back to the value baked into
  `partykit/server.ts`.

> **On the first deploy the PartyKit CLI asks you to log in with GitHub. That's
> expected, and it's fine — it does not change where your room lands.** The CLI
> requires a one-time GitHub login to run `deploy`; it does **not** put your room
> on PartyKit's hosted platform, because you passed `--domain …workers.dev`
> together with the Cloudflare credentials, so the room deploys to **your**
> Cloudflare account. Just log in and let it continue. The login is cached, so
> subsequent deploys don't prompt.

On success you'll see something like:

```text
Deployed ./partykit/server.ts to https://<your-queue>.<your-org>.workers.dev
We're provisioning the <your-queue>.<your-org>.workers.dev domain. This can take up to 2 minutes. Hold tight!
```

## Naming → your subdomain

`--name` is the Cloudflare Worker name and it **becomes the subdomain**:
`<name>.<your-org>.workers.dev`. Pick one per demo and keep `--name` and the
`--domain` subdomain identical:

- `--name meeting` → `meeting.<your-org>.workers.dev`
- `--name my-demo` → `my-demo.<your-org>.workers.dev`

A convenient pattern is to bake the name + domain into a script so the command
you run day-to-day stays short:

```json
"scripts": {
  "deploy:party": "partykit deploy --name <your-queue> --domain <your-queue>.<your-org>.workers.dev"
}
```

…then `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm deploy:party --var RQ_REACTOR_API_KEY=…`.

## Point your web app at it

In your web app's deploy environment (Vercel, etc.), set the one variable the
browser needs — the deployed room host:

```bash
NEXT_PUBLIC_PARTYKIT_HOST=<your-queue>.<your-org>.workers.dev
```

The client opens its WebSocket to that host. The Reactor API key and admin
password live with the room, never in the web app.

## Verify

Give the domain ~2 minutes to provision after the deploy line appears, then load
your web app with `NEXT_PUBLIC_PARTYKIT_HOST` pointed at the host. The queue
should connect (a position, then your turn). If you set an admin password, the
admin dashboard shows live rooms and surfaces any Coordinator errors with their
HTTP status and body.

## Re-deploying

Re-run the **exact same command** (same `--name`) to push changes — it updates
the existing Worker in place. No teardown.

# Automate it: deploy on every push to main (GitHub Actions)

> **Optional — opt-in only.** Do **not** set this up by default. Most demos are
> fine shipping with the manual deploy above. **Suggest** automation to the user
> ("want me to add a GitHub Action that redeploys on every push to `main`?") and
> only add the workflow if they **explicitly say yes**. It introduces a CI token,
> extra secrets, and a deploy-on-merge side effect the user should choose
> knowingly.

Once the manual deploy works, you can wire it into CI so a merge to `main` ships
the room with no manual step. The catch is auth: locally the PartyKit CLI does a
one-time interactive **GitHub login**, and CI can't open a browser. The fix is a
long-lived PartyKit token.

## 1. Generate the PartyKit variables (`PARTYKIT_TOKEN` + `PARTYKIT_LOGIN`)

These two are the "PartyKit variables" the workflow needs. Generate them **on a
dev machine** (one time) — they can't be produced inside CI, which is the whole
point:

```bash
npx partykit token generate
```

This opens a browser so you can authorize with the **same GitHub account** you
deploy with, then prints exactly two lines, e.g.:

```text
PARTYKIT_LOGIN=your-github-username
PARTYKIT_TOKEN=eyJhbGciOi…long-lived-token
```

Copy both values and store them as secrets (step 2). `PARTYKIT_LOGIN` is your
GitHub username; `PARTYKIT_TOKEN` is a long-lived session token — treat it like a
password. Together they replace the interactive browser login in CI and are
**mandatory even for a cloud-prem deploy** — without them the Action hangs
waiting for a browser that never opens. Re-run the command anytime to mint a
fresh token (e.g. to rotate it).

## 2. Store secrets in a branch-scoped GitHub Environment

Put the secrets in a **GitHub Environment** (e.g. `production`) rather than plain
repo secrets, and restrict that environment to `main` (repo Settings →
Environments → `production` → Deployment branches and tags → "Selected branches"
→ a rule for `main`). Then the credentials are only available to runs on `main` —
never to PR branches or forks. The environment needs:

| Secret                                           | What                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Your Cloudflare account (Workers Paid) + token.                                                                            |
| `PARTYKIT_TOKEN` / `PARTYKIT_LOGIN`              | From `partykit token generate` (step 1).                                                                                   |
| `PARTYKIT_SERVER_URL`                            | The deploy host, e.g. `<your-queue>.<your-org>.workers.dev`. Keeping it a secret lets the same workflow serve any project. |
| `RQ_REACTOR_API_KEY`                             | The queue's Reactor API key (passed as `--var`).                                                                           |
| `RQ_ADMIN_PASSWORD`                              | Admin dashboard password, if you enabled it (passed as `--var`).                                                           |

## 3. The workflow

`.github/workflows/deploy-partykit.yml` (adjust the package manager / install step
to your repo):

```yaml
name: Deploy PartyKit

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-partykit
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production # branch-scoped to main
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Deploy to Cloudflare
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          PARTYKIT_TOKEN: ${{ secrets.PARTYKIT_TOKEN }}
          PARTYKIT_LOGIN: ${{ secrets.PARTYKIT_LOGIN }}
          PARTYKIT_SERVER_URL: ${{ secrets.PARTYKIT_SERVER_URL }}
          RQ_REACTOR_API_KEY: ${{ secrets.RQ_REACTOR_API_KEY }}
          RQ_ADMIN_PASSWORD: ${{ secrets.RQ_ADMIN_PASSWORD }}
        run: |
          set -euo pipefail
          # --name is the host's first label; --domain is the whole host. Room
          # shape stays baked into partykit/server.ts, so only secrets are --var.
          name="${PARTYKIT_SERVER_URL%%.*}"
          npx partykit deploy \
            --name "$name" \
            --domain "$PARTYKIT_SERVER_URL" \
            --var RQ_REACTOR_API_KEY="$RQ_REACTOR_API_KEY" \
            --var RQ_ADMIN_PASSWORD="$RQ_ADMIN_PASSWORD"
```

`CLOUDFLARE_*` + `--domain` keep it cloud-prem; `PARTYKIT_TOKEN`/`PARTYKIT_LOGIN`
satisfy the CLI's auth without a browser. A `concurrency` group means a newer
push supersedes an in-flight deploy instead of racing it.

# Footguns (read before you ship)

### 1. The GitHub login is required — and harmless

The PartyKit CLI makes you log in with GitHub on the first `deploy`. This is
**not** a sign you're deploying to the wrong place: with `--domain …workers.dev`
and the Cloudflare credentials, the room still lands on your Cloudflare account.
Log in and continue. In CI there's no browser to log in with — generate a
long-lived `PARTYKIT_TOKEN`/`PARTYKIT_LOGIN` instead (see _Automate it_ above).

### 2. Credentials must be inline, not in `.env`

`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` must be inline env vars on the
deploy command, and runtime secrets must go through `--var`. PartyKit does **not**
reliably read these from a `.env` for a deploy. A `.env` is fine for
`partykit dev`; it is not the mechanism for `deploy`.

### 3. Free plan → Durable Objects failure

PartyKit rooms are classic Durable Objects, which need **Workers Paid**. A
free-plan account fails the deploy with a Durable Objects plan error. Enable
Workers Paid on the target account first.

### 4. Use the _right_ account

The `--domain` host, the `CLOUDFLARE_ACCOUNT_ID`, and the API token's scope must
all point at the **same** account — the one with Workers Paid and the
`workers.dev` subdomain. A token that verifies fine but is scoped to a different
account (e.g. a personal free-plan one) is the classic cause of a confusing
plan error. Double-check the account id and that the token manages that account.

### 5. No `--domain` → hosted platform

Omit `--domain` (or the Cloudflare creds) and PartyKit deploys to its own hosted
platform (`*.partykit.dev`) instead of your Cloudflare account. If you wanted
cloud-prem, always pass both.

### 6. Subdomains as separate zones are Enterprise-only

You **cannot** add `queue.example.com` to Cloudflare as its own zone on a normal
plan — Cloudflare's "add a domain" only accepts an apex/registrable domain, and
splitting a subdomain into its own zone is an Enterprise feature. For a normal
plan, deploy under `*.workers.dev`, or use an apex domain you fully control as a
Cloudflare zone.

# Resources

- `building-reactor-queue-demos` skill — build the room + client this deploys.
- `README.md` — full library reference; `examples/basic` — a runnable room you
  can deploy with exactly the steps above.
- PartyKit deploy docs: <https://docs.partykit.io/guides/deploy-to-cloudflare/>
