# Development and production, and how one becomes the other

Two stacks on one host. `dev.keepsaybot.online` is where work lands first; `keepsaybot.online` is
production. The host's address and its credentials are operational material and are not in this
repository.

## What "identical" means here, and what it does not

**Identical code.** Production never builds. It runs the exact image id that development was tested on,
promoted by tag. This matters because two builds of the same commit can differ — a base image moves, a
registry resolves a dependency differently — and then "it is the same code" is a hope rather than a
fact. Promotion tags the running dev image; nothing is recompiled on the way.

**Separate data.** Production has its own PostgreSQL, its own Redis, its own `AUTH_SECRET`, its own
channel-credential key and therefore its own sessions and its own encrypted provider tokens. Sharing any
of those with development is how a test run deletes a customer's conversation. The provider API keys are
shared, because they identify the product to Meta and to the model provider rather than identifying an
environment.

## The loop

1. Work on a branch, run `pnpm verify` locally.
2. `scripts/deploy-dev.sh` — then look at it.
3. `keepsay-promote` on the host.
4. `keepsay-diff` whenever you want to be sure they still match.

## Step 2, and why it is a script

The development host holds files the repository does not, at paths the repository *also* uses. The worst
of them is `compose.yaml`: the repository's is two services, Postgres and Redis, for running the app on
your own machine; the host's is five, and it is the one that runs the stack. Syncing the tree with a
hand-written exclude list overwrote it and deleted the `Dockerfile` beside it. Nothing went down — a
running container does not read its compose file — but the stack could not be rebuilt until both were
restored.

So the exclude list is not written down twice. `scripts/deploy-dev.sh` reads it from the host's artefact
directory, which is the record of what belongs to the host:

```
/root/staging-artifacts/   Dockerfile  compose.yaml  edge.conf  edge.conf.template
                           seed-demo.ts  staging.htpasswd  .env
```

**Put a copy of every host-only file there.** A file that is not in that directory is not protected, and
will be deleted by the next deploy. The script then does a dry run and refuses to transfer anything if
the plan touches a protected path, so the check runs before the damage rather than after it.

It takes its host and key from the environment — `KEEPSAY_DEV_HOST`, `KEEPSAY_DEV_KEY`, and optionally
`KEEPSAY_DEV_DIR` and `KEEPSAY_DEV_ARTEFACTS`. No address and no credential is in this repository.

It also refuses an empty artefact listing rather than treating it as "nothing to protect", and reports
the build's own exit code from a file on the host: a dropped ssh connection exits 255, and 255 read as a
build failure is how a successful deploy gets reported as broken.

`keepsay-promote` does six things and stops at the first that fails:

| Step | What it does | Why it can stop here |
| --- | --- | --- |
| 1 | Reads the image id dev is running | dev is not up, so there is nothing to promote |
| 2 | Asks dev's health endpoint | promoting a broken build to production is worse than not promoting |
| 3 | Tags that image `keepsaybot-app:current` and `keepsaybot-app:<timestamp>` | — |
| 4 | Starts production's database and applies migrations with that image | a migration fails |
| 5 | Starts production's web and worker on the tag, waits for health | the new build does not come up |
| 6 | Compares all four image ids | they disagree, which means something rebuilt |

The timestamp tag is the rollback handle: production can be pointed back at an earlier one without a
build.

`keepsay-diff` answers the same question three independent ways — the image id, the built asset name,
and a digest of what each origin actually serves — because each can be right while another is wrong. It
ends by hashing two different pages and checking they differ, so a comparison that has quietly stopped
comparing says so instead of reporting success.

## Things that are deliberately not identical

| | dev | production |
| --- | --- | --- |
| Indexing | `X-Robots-Tag: noindex, nofollow` | indexable |
| Database, Redis, sessions | its own | its own |
| `AUTH_URL` | the dev origin | the production origin |
| Legal page values | unset, so the pages show gaps | set per `LEGAL_PAGES.md` |

Dev is closed to search engines precisely *because* the promotion works: two origins serving byte-identical
pages would otherwise compete with each other for the product's own search results.

## Before production sign-in works

The Google OAuth client must list the production callback as an authorised redirect URI:

```
https://keepsaybot.online/api/auth/callback/google
```

Until it does, the sign-in page will offer the Google button — the deployment is configured, so the
button is honest — and Google will refuse the exchange with `redirect_uri_mismatch`. This is a change in
the Google Cloud console, not in this repository.
