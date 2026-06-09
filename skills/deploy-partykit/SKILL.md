---
name: deploy-partykit
description: Deploy a @reactor-team/queue PartyKit waiting-room server to production, two ways: the managed PartyKit platform (`partykit deploy` → `<name>.<github-user>.partykit.dev`, no Cloudflare account needed, secrets via `partykit secret put`) or cloud-prem on your own Cloudflare account (`partykit deploy --domain` → `<name>.<your-org>.workers.dev`, Workers Paid + API token + workers.dev subdomain). Use after building a queue demo with the building-reactor-queue-demos skill, when you're ready to ship beyond `partykit dev`. Covers both deploy commands, setting the queue's secrets, pointing your web app at the deployed host, the expected one-time PartyKit GitHub login, and the common footguns — free-plan Durable Objects failure, wrong Cloudflare account id, the deploy silently falling back to the managed platform, secrets from `.env` not being uploaded, and custom-subdomain zones being Enterprise-only. Also covers *optionally* automating the deploy as a GitHub Action on every push to main — this is opt-in (suggest it; only add it when the user explicitly asks) and **requires cloud-prem** — including how to generate the `PARTYKIT_TOKEN`/`PARTYKIT_LOGIN` PartyKit variables for non-interactive CI auth (since CI can't do the browser login) and branch-scoped GitHub Environment secrets.
---

# Deploying a `@reactor-team/queue` room to production

You've built a queue demo (see the `building-reactor-queue-demos` skill): a
`partykit.json` and a `partykit/server.ts` that does
`export default createReactorQueueServer({ … })`, plus a web app that connects to
it. So far it only runs under `partykit dev`. This skill ships it to production —
either on **PartyKit's managed platform** (simplest, no Cloudflare) or on **your
own Cloudflare account** (_cloud-prem_).

The deployed room is a backend WebSocket endpoint your web app talks to; end
users never see its URL. It deploys **separately** from your web app — the app
(Vercel, etc.) just needs the room's host in one env var. Whichever option you
pick, keep the room's runtime config (`model`, `coordinatorUrl`, `maxSessions`,
`usersPerSession`, durations, …) **in code** in `createReactorQueueServer({ … })`,
so a deploy only carries the secrets (the building skill covers this).

## Two ways to deploy

|                    | **Managed** (Option A)              | **Cloud-prem** (Option B)                          |
| ------------------ | ----------------------------------- | -------------------------------------------------- |
| Runs on            | PartyKit's infrastructure           | **your** Cloudflare account                        |
| Host               | `<name>.<github-user>.partykit.dev` | `<name>.<your-org>.workers.dev` (or your domain)   |
| Cloudflare account | not needed                          | required (**Workers Paid**)                        |
| Setup              | one command + a GitHub login        | account id + API token + a `workers.dev` subdomain |
| Best for           | quick demos, least setup            | owning the infra/domain, **CI auto-deploy**        |

Pick **managed** if you just want it live with the least setup and don't mind it
running on PartyKit's infrastructure. Pick **cloud-prem** if you want the room on
your own account/domain — and note the **push-to-main CI pipeline in this skill
requires cloud-prem** (it deploys with your Cloudflare credentials).

# Option A — Managed (PartyKit's hosted platform)

The simplest path, and it needs **no Cloudflare account**. PartyKit hosts the room
on its own infrastructure at `<name>.<your-github-username>.partykit.dev`, where
`name` is the `name` field in your `partykit.json`.

**Prerequisites:** just `partykit` as a devDependency plus your `partykit.json` +
`partykit/server.ts`. No Cloudflare, no plan, no Durable Objects setup.

## 1. Deploy

From the directory that contains `partykit.json`:

```bash
pnpm exec partykit deploy
```

The **first** run opens a browser for a one-time GitHub device authorization,
then deploys. Provisioning the `*.partykit.dev` host takes up to ~2 minutes the
first time. (This is the same login the CLI does for cloud-prem — see the GitHub
footgun below; it's expected and harmless.)

## 2. Set the secrets

Push the queue's secrets to the deployment — non-secret config stays baked into
`createReactorQueueServer`:

```bash
pnpm exec partykit secret put RQ_REACTOR_API_KEY
pnpm exec partykit secret put RQ_ADMIN_PASSWORD     # only if you enabled /admin
```

`partykit secret put` prompts for the value and stores it encrypted on the
deployment — it never touches your repo. Manage them with `partykit secret list`
/ `partykit secret delete`. (You can instead pass `--var NAME=value` on `deploy`,
but `secret put` keeps values out of your shell history.)

## 3. Point your web app at it

Set the one browser variable to the managed host:

```bash
NEXT_PUBLIC_PARTYKIT_HOST=<name>.<your-github-username>.partykit.dev
```

## Re-deploying (managed)

Re-run `pnpm exec partykit deploy` to push changes; secrets persist across
deploys. Tail live logs with `pnpm exec partykit tail`.

> **Want automated deploys?** The push-to-main CI pipeline in this skill is built
> on cloud-prem (Option B). If you need deploy-on-merge, set up cloud-prem rather
> than managed.

# Option B — Cloud-prem (your own Cloudflare account)

Runs the room on **your** Cloudflare Workers + Durable Objects under a host you
control. More setup than managed, but you own the infrastructure and domain — and
it's what the CI pipeline below builds on.

## Before you deploy

- The queue project checked out locally, with `partykit` available as a
  devDependency (run it via `pnpm exec partykit`).
- A **Cloudflare account on the Workers Paid plan** (see below — this is not
  optional).
- That account's **Account ID** and an **API token** (see below).
- A **`workers.dev` subdomain** enabled on the account (gives you
  `<your-org>.workers.dev`), or a domain you control as a Cloudflare zone.

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

This pipeline builds on **cloud-prem (Option B)** — it deploys with your
Cloudflare credentials to your own domain. If you went with the managed platform
(Option A), there's no CI workflow here; redeploy by re-running
`partykit deploy` by hand.

Once the cloud-prem deploy works, you can wire it into CI so a merge to `main`
ships the room with no manual step. The catch is auth: locally the PartyKit CLI
does a one-time interactive **GitHub login**, and CI can't open a browser. The
fix is a long-lived PartyKit token.

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
platform (`*.partykit.dev`) — that's Option A, and fine if intended. But if you
meant **cloud-prem**, this is the silent trap: always pass `--domain` + the
Cloudflare credentials together, or you'll quietly ship to the managed platform.

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
