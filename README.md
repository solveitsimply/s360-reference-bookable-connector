# s360-reference-bookable-connector

Out-of-process **reference** `BOOKABLE_OUTCOME_SOURCE` connector for Simply360
conformance. It exercises the public Bookable Experience Platform ingress using
**synthetic fixtures only** — it has no provider account, no customer data, no
database, and no internal Simply360 package imports.

This is the Phase 3 reference connector for the
[External Reservation Ingestion and Connectivity](https://github.com/solveitsimply/simply360)
workstream (BXP-02 S6 / BXP-08). It is deliberately not a real provider adapter:
Inn Style, SuperControl/Kip, and every live connector remain behind their own
provider-access, review, hosting, cost, and rollout gates.

## What it proves

The connector speaks only the public boundary:

1. **Token exchange** — client-credentials at `POST /marketplace/oauth/token`,
   yielding an installation access token (`s360_inst_at_…`, scope `records:write`).
2. **Ingress** — `POST /v1/integrations/outcome-sources/{preview,submit,snapshot}`.
   Team / installation / epoch identity is derived **server-side** from the token
   binding; the connector never puts installation identity in a body.

All payloads are built and re-verified with the **public** `@s360/contracts/app-platform`
authority (control totals, canonical SHA-256 hashes, snapshot manifests), so the
connector never duplicates canonical hashing logic.

### Conformance scenarios (`src/scenarios.ts`)

| Scenario                          | Expected server decision |
| --------------------------------- | ------------------------ |
| `baseline-snapshot`               | Complete `RETAIN_MISSING` snapshot (lodging + appointment) accepted; control totals verified |
| `authoritative-empty-snapshot`    | Empty `CANCEL_MISSING` snapshot accepted as an authoritative empty result |
| `delta-new`                       | New confirmed reservation → CREATE |
| `delta-modify`                    | Newer version/ordering evidence → `APPLY_NEWER` (UPDATE) |
| `delta-cancel`                    | Cancellation (with required `sourceUpdatedAt`) → CANCEL of the owned record |
| `replay-noop`                     | Identical key + content replay → `NO_OP_RETRY`, no duplicate |
| `idempotency-conflict`            | Same key, different content → `QUARANTINE_IDEMPOTENCY_CONFLICT`, HTTP 409 |
| `cross-installation-isolation`    | Documented; needs a second installation grant to execute end-to-end |

## Layout

- `src/fixtures.ts` — synthetic payloads derived from the public conformance
  fixtures (`createBookableOutcome*ConformanceFixtureV1`) plus new/modify/cancel
  deltas and snapshot builders.
- `src/client.ts` — token acquisition, retry/backoff, stable idempotent
  `submissionKey`, and public-contract validation before every post.
- `src/scenarios.ts` — the conformance scenarios above.
- `src/handler.ts` — AWS Lambda Function URL handler: `GET /health`,
  `POST /run?scenario=…`.
- `src/config.ts` — env / Secrets Manager credential loading.
- `test/no-internal-imports.test.ts` — **static ratchet** enforcing that `src/`
  imports only `@s360/contracts/app-platform` and safe dependencies.

## Local development

```bash
npm ci
npm run ratchet     # static no-internal-imports ratchet
npm test            # ratchet + client + scenario unit tests
npm run typecheck
npm run build       # esbuild → dist/handler.mjs
```

## Deployment

`.github/workflows/deploy.yml` authenticates to AWS via **GitHub OIDC** (no
static keys), runs the ratchet + unit tests + type-check, bundles the handler,
and deploys the Lambda + Function URL with a create-or-update pattern.

Required repository **variables**:

| Variable | Purpose |
| -------- | ------- |
| `AWS_REGION` | Deploy region |
| `AWS_DEPLOY_ROLE_ARN` | OIDC role to assume (`s360-ref-bookable-connector-deploy`) |
| `FUNCTION_NAME` | `s360-ref-bookable-connector` |
| `LAMBDA_EXEC_ROLE_ARN` | Lambda execution role (basic execution, no VPC) |
| `S360_SECRET_ARN` | ARN of `s360/ref-bookable-connector/client` |
| `S360_API_BASE_URL` | Simply360 origin (optional until live conformance) |

The OIDC trust is restricted to this repo's `refs/heads/main` (the org issues
GitHub's **immutable** subject claim, so the trust pins the immutable
`repo:<org>@<orgId>/<repo>@<repoId>:ref:refs/heads/main` sub).

The Function URL uses **`AWS_IAM`** auth: the NonProd account guardrail blocks
unauthenticated (`NONE`) Function URLs. Invoke `/health` with a SigV4-signed
request:

```bash
URL=$(aws lambda get-function-url-config --function-name s360-ref-bookable-connector --query FunctionUrl --output text)
curl -fsS "${URL}health" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  --aws-sigv4 "aws:amz:us-east-1:lambda" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN"
```

`GET /health` proves the deploy path (no connector credentials needed). `POST /run`
requires a seeded grant (see below) and returns a clear `not_configured` state
until then.

## npm-publication pause point (DEFERRED)

`@s360/contracts` is **not** published to a registry yet. Until publication is
approved, this connector consumes it as a **committed tarball** under
`vendor/s360-contracts-<version>.tgz`, referenced via a `file:` dependency. npm
cannot install a workspace package from a monorepo git URL, so the tarball is the
supported path.

Refresh it from a local monorepo checkout:

```bash
S360_MONOREPO_PATH=/path/to/simply360 node scripts/refresh-contracts.mjs
# then bump the "@s360/contracts" file: path in package.json if the version changed
```

When npm publication of `@s360/contracts` is unblocked, replace the `file:`
tarball dependency with the published `@s360/contracts@^x.y.z` and delete
`vendor/` + `scripts/refresh-contracts.mjs`.

## What remains for live conformance

`GET /health` works immediately after deploy. End-to-end scenario runs additionally require:

1. the dev ingress flag `BOOKABLE_OUTCOME_SOURCE_INGRESS_ENABLED` enabled (non-prod);
2. an `ENABLED` `BOOKABLE_OUTCOME_SOURCE` capability row on the installation's app version;
3. a seeded installation grant (client id/secret) written into the
   `s360/ref-bookable-connector/client` secret, mintable once the REP-03 saga can
   issue grants;
4. `S360_API_BASE_URL` pointed at the deployed dev origin.

Until then, live scenario posts 401/404 by design; the deploy and `/health` prove
the transport path.
