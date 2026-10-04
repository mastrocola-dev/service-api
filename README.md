# service-api

Public HTTP API in front of the mastrocola.dev agent. It accepts a visitor's question, decides whether the question may run, hands it to the worker through a queue and answers the site's polling. It contains no agent code and owns all runtime state ([ADR-007](https://github.com/mastrocola-dev/docs/blob/main/adr/007-agent-runtime.md)); conventions shared with the other TypeScript repositories are recorded in [ADR-004](https://github.com/mastrocola-dev/docs/blob/main/adr/004-typescript-without-build.md).

## Contract

| Request | Response |
|---|---|
| `POST /jobs` with `{ question, token }` | `202 { jobId }`, or a refusal below |
| `GET /jobs/{id}` | `200 { status, step?, output?, reason? }`, or `404 { error: 'unknown' }` |
| `POST /warm` | `202 {}` |

`token` is the Cloudflare Turnstile response. `status` is `queued`, `running`, `done` or `failed`. `step` is the latest thing the agent did (`{ kind: 'model' }` or `{ kind: 'tool', name }`), `output` is `{ outOfScope, answer, sources }` and `reason` is `timeout`, `budget`, `redelivered` or `error`.

Refusals of `POST /jobs`, in the order they are checked:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid` | question outside 3–500 characters, missing token or missing client address |
| 503 | `budget` | today's spending reached US$ 1 |
| 403 | `challenge` | Turnstile rejected the token |
| 429 | `busy` | three questions are already being answered |
| 429 | `quota` | this address asked ten questions today |

Cheap and global checks come first: a spent budget is answered without calling Turnstile, and the quota is consumed only by a question that will actually run.

## Messages

The API and the worker share no code, only the contract in ADR-007; each side validates what it reads with its own schema and ignores unknown fields.

- To the queue `jobs`: `{ v: 1, type: 'run', jobId, instance: 'ask', input: { question } }` and `{ v: 1, type: 'warm' }`
- From the queue `events`: `started`, `step`, `completed` and `failed`, each with `jobId` and `seq`

The queue does not keep order. An event is applied only when its `seq` is greater than the stored one and the job is not finished, so a late step is dropped without effect and a finished job stays final. Events with an unknown version or type, or with an answer over the limits (1500 characters, five sources), are ignored.

## State

One table in Table Storage, partitioned by UTC day, behind the `JobStore` and `QuotaStore` ports (`src/store.ts`); `src/table.ts` is the only file that knows the storage SDK.

| Row | Holds |
|---|---|
| `job:<id>` | status, latest sequence and step, output or failure reason, cost |
| `quota:<hash>` | questions asked today by one address |
| `state` / `warm` | when the worker was last woken |

- A job id starts with its day (`20261004-<uuid>`), so a job is a point read and cleanup is deleting old partitions. A daily timer keeps today and yesterday.
- Today's spending is the sum of the cost stored on today's jobs. The cost is written in the same conditional update that finishes the job, so a redelivered event cannot count twice and there is no separate counter to drift.
- The concurrency limit counts unfinished jobs created in the last two minutes, by query. A stored counter would stay wrong forever after one lost event.
- A job unfinished after three minutes is reported as `failed` with reason `timeout`, without being rewritten: its real result still wins if it arrives.
- Every write is conditional on the entity tag and retried on conflict.
- The client address is never stored. The quota key is `SHA-256(day:address)`: enough to keep addresses out of the table, not anonymisation — the address space is small enough to enumerate for anyone holding the table. Rows are deleted within two days.

## Trust

The client address comes from `CF-Connecting-IP` and nothing else. That header is trustworthy only because the origin accepts connections from Cloudflare alone; a request without it is refused. The quota means nothing on an origin reachable directly.

## Layout

```
src/api.ts        decisions: what runs, what is refused, how events change a job
src/store.ts      JobStore and QuotaStore over a four-operation Table port
src/table.ts      Table over Azure Table Storage (entity tags, retries)
src/azure.ts      managed identity token, Key Vault secret, queue send, Turnstile verification
src/function.ts   Azure Functions adapter: three HTTP routes, the events trigger, the purge timer
```

| Setting | Use |
|---|---|
| `AzureWebJobsStorage__accountName` | storage account of the host, which also holds the table |
| `ServiceBus__fullyQualifiedNamespace`, `ServiceBus__credential`, `ServiceBus__clientId` | identity-based connection of the `events` trigger; the namespace is also where `jobs` messages are sent |
| `AZURE_CLIENT_ID` | user-assigned identity that requests tokens |
| `TURNSTILE_SECRET_URI` | Key Vault secret holding the Turnstile secret, read on every verification |

CORS is configured on the function app, not here.

## Test

```sh
npm ci
npm test
npm run test:coverage
```

`api.ts` and `store.ts` are tested through an in-memory `Table` (`test/fixtures/memory.ts`); `table.ts` against a fake client that reproduces entity-tag conflicts; `azure.ts` with `fetch` replaced. `function.ts` is loaded and exercised only on paths that reach no service; opening the real table stays uncovered by design.

## Deploy

A push to `main` that passes the gates deploys the API: the `deploy` job of [`ci.yml`](.github/workflows/ci.yml) installs production dependencies, zips the sources as they are (`src`, `node_modules`, `host.json`, `package.json`) and posts the package to the app's publish endpoint as `id-service-api` over OIDC ([ADR-006](https://github.com/mastrocola-dev/docs/blob/main/adr/006-identity-and-secrets.md)). It then waits until the app lists the `submit` function, because a package the host cannot load still deploys successfully.

Required repository variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `FUNCTION_APP_NAME`.

## Decisions

- **Storage SDK, own credential.** `@azure/data-tables` handles entity tags, paging and key escaping, on which the quota and the budget depend; the token comes from the platform's identity endpoint through a three-line credential, so `@azure/identity` is not needed.
- **Queue sends over REST.** One `fetch` with the identity's token, the same mechanism the worker uses for events.
- **Budget before challenge.** When the day's budget is spent nothing else is worth checking, and Turnstile is not called.
- **Verification failures are errors, not refusals.** If Turnstile or Key Vault cannot be reached the request fails with 500; answering 403 would blame the visitor for an outage.
- **Latest step only.** Polling shows what the agent is doing now; a history would need every event in order, which the queue does not provide.
- **`warm` is unauthenticated and rate-limited.** It fires when the question field gains focus, before any challenge is solved; at most one message a minute reaches the queue.
- **Style enforced by tooling.** Biome formats and lints (no semicolons, single quotes); `lineWidth: 320` is the author's choice.
