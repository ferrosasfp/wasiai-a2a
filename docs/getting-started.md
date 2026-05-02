# Getting Started — WasiAI A2A Protocol

This is the linear walkthrough for a developer or autonomous agent that
wants to call the WasiAI A2A gateway from scratch. Six steps, end to
end:

1. Register an A2A key via `POST /auth/agent-signup`.
2. Make your first authenticated call to `POST /compose` (or
   `POST /orchestrate`).
3. Receive `HTTP 402` with the x402 payment payload (anonymous path).
4. Sign EIP-712 (`EIP-3009 TransferWithAuthorization`).
5. Retry with the `payment-signature` header.
6. Verify the on-chain transaction in KiteScan or Snowtrace.

Steps 1, 2 and 6 apply to every integration. Steps 3–5 are only needed
for the **anonymous x402 path** — if you authenticate with an A2A key,
the gateway debits your tracked budget and skips the 402 challenge.

---

## Prerequisites

- Node.js 18+ (uses the global `fetch`).
- `viem` installed locally for EIP-712 signing if you want to use the
  TypeScript samples below: `npm install viem`.
- A wallet private key with PYUSD on Kite testnet (chain `2368`) **or**
  USDC.e on Kite mainnet (chain `2366`, opt-in). See
  [networks.md](./networks.md).
- Base URL — the hosted gateway is `https://app.wasiai.io/api/v1`. Use
  the placeholder `<YOUR_GATEWAY_URL>` throughout this doc.

> All sample code uses placeholders for secrets:
> `<YOUR_A2A_KEY>`, `<YOUR_GATEWAY_URL>`, `<OPERATOR_PRIVATE_KEY>`,
> `<YOUR_RPC_URL>`. Never paste real values into version control.

---

## Step 1 — Register an A2A key

A2A keys give you a tracked budget, scoped permissions and a stable
identity. The endpoint is rate-limited per IP.

> **Note on token format.** The `wasi_a2a_` prefix on the issued token is
> **case-sensitive** (lowercase only). The HTTP `Bearer` scheme keyword in
> the `Authorization` header is **case-insensitive** (`Bearer`, `bearer`,
> `BEARER` are all accepted by the middleware).

```bash
curl -X POST <YOUR_GATEWAY_URL>/auth/agent-signup \
  -H 'content-type: application/json' \
  -d '{
    "owner_ref": "your-stable-owner-id",
    "display_name": "My Agent",
    "daily_limit_usd": 10
  }'
```

```ts
const res = await fetch('<YOUR_GATEWAY_URL>/auth/agent-signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    owner_ref: 'your-stable-owner-id',
    display_name: 'My Agent',
    daily_limit_usd: 10,
  }),
});
if (res.status !== 201) throw new Error(`signup failed: ${res.status}`);
const { token, key_id } = await res.json();
console.log('key', key_id, 'token starts with', token.slice(0, 12));
```

The response includes the `wasi_a2a_*` token **once** — store it
securely. You can verify the key later with `GET /auth/me`.

---

## Step 2 — First authenticated call

Use the new key to call `POST /compose` (multi-step pipeline) or
`POST /orchestrate` (goal-based).

### `POST /compose` — TypeScript

```ts
const res = await fetch('<YOUR_GATEWAY_URL>/compose', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-a2a-key': '<YOUR_A2A_KEY>',
  },
  body: JSON.stringify({
    steps: [
      { agentSlug: 'example-summarizer', input: { text: 'Hello world' } },
    ],
    maxBudget: 0.5,
  }),
});
const body = await res.json();
console.log(res.status, body);
```

### `POST /compose` — curl

```bash
curl -X POST <YOUR_GATEWAY_URL>/compose \
  -H 'content-type: application/json' \
  -H 'x-a2a-key: <YOUR_A2A_KEY>' \
  -d '{
    "steps": [{ "agentSlug": "example-summarizer", "input": { "text": "Hello world" } }],
    "maxBudget": 0.5
  }'
```

### `POST /orchestrate` — TypeScript

```ts
const res = await fetch('<YOUR_GATEWAY_URL>/orchestrate', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Authorization: 'Bearer <YOUR_A2A_KEY>',
  },
  body: JSON.stringify({
    goal: 'Summarize this article and translate to French',
    budget: 2.0,
    preferCapabilities: ['text-summarization', 'translation'],
    maxAgents: 5,
  }),
});
const body = await res.json();
console.log(res.status, body);
```

### `POST /orchestrate` — curl

```bash
curl -X POST <YOUR_GATEWAY_URL>/orchestrate \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <YOUR_A2A_KEY>' \
  -d '{
    "goal": "Summarize this article and translate to French",
    "budget": 2.0,
    "preferCapabilities": ["text-summarization", "translation"],
    "maxAgents": 5
  }'
```

If your A2A key has enough budget, the response is `200 OK` with
`kiteTxHash` (the inbound payment tx) and the per-step output. **You're
done.** Skip ahead to step 6 to verify the tx.

If you do not send `x-a2a-key` / `Authorization`, the gateway falls
through to the anonymous x402 flow — continue with step 3.

---

## Step 3 — Receive the `HTTP 402`

The anonymous path returns:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "error": "payment-signature header is required",
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:2368",
      "maxAmountRequired": "1000000000000000000",
      "resource": "https://app.wasiai.io/api/v1/compose",
      "description": "WasiAI Compose Service — Multi-agent pipeline execution",
      "mimeType": "application/json",
      "payTo": "0x...operator-wallet...",
      "maxTimeoutSeconds": 60,
      "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
      "extra": null,
      "merchantName": "WasiAI A2A Gateway"
    }
  ]
}
```

The values in `accepts[0]` are dynamic — read them from the live
response, do not hardcode. The fields you need to sign with are:

- `network` → tells you the chain (`eip155:2368` = Kite testnet, see
  [networks.md](./networks.md)).
- `asset` → ERC-20 token contract address.
- `payTo` → the operator wallet that will receive the funds.
- `maxAmountRequired` → atomic units of the token (string).
- `maxTimeoutSeconds` → how many seconds your `validBefore` can sit
  in the future.

> **WARNING — atomic units, NOT 18-decimal wei.**
>
> The `value` you sign in the EIP-712 message is **always atomic units of
> the actual ERC-20 token**, which on this protocol's supported assets
> (PYUSD on Kite testnet, USDC.e on Kite mainnet) means **6 decimals**:
>
> - `1.00 PYUSD` = `'1000000'` (six zeros).
> - `0.5 USDC` = `'500000'` (NOT `'500000000000000000'`).
> - `1.50 PYUSD` = `'1500000'`.
>
> If you sign 1 PYUSD as `'1000000000000000000'` (18 decimals, the ETH/wei
> convention) you are authorizing **one trillion PYUSD** — the wallet
> balance check will fail and the facilitator will reject with `402 /
> insufficient balance`, but you should not be writing values that high in
> the first place.
>
> **Known quirk.** The default placeholder you may see in the 402 payload
> as `1000000000000000000` (18 zeros) is left over from the historical
> wei-style env default in `KITE_PAYMENT_AMOUNT` — it does not reflect the
> token's actual decimal count. The values you sign, and that the
> facilitator validates, are still 6-decimal atomic units. Documented
> alignment work is tracked separately; for now, **trust the token's
> documented decimals (see [networks.md](./networks.md)), not the digit
> count of `maxAmountRequired`**.

---

## Step 4 — Sign EIP-712

The EIP-712 typed message you sign depends on which **facilitator mode**
the gateway you are calling is running. WasiAI supports two:

| Mode | When | `primaryType` | `verifyingContract` |
|------|------|---------------|---------------------|
| `pieverse` | **Default in production today**, including `app.wasiai.io`. | `Authorization` | Pieverse facilitator contract `0x12343e649e6b2b2b77649DFAb88f103c02F3C78b` |
| `x402` | Canonical x402 spec; opt-in via `KITE_FACILITATOR_MODE=x402` on the server. | `TransferWithAuthorization` | The asset's ERC-20 token contract (e.g. PYUSD / USDC.e) |

Both modes sign the **same six fields** (`from`, `to`, `value`,
`validAfter`, `validBefore`, `nonce`) and produce a `payment-signature`
header in the same wire format. The differences are the EIP-712 domain
and the `primaryType` — get those wrong and the facilitator returns
`402 / signature invalid`.

The reference implementation lives at
`src/adapters/kite-ozone/payment.ts:62-64` (mode selector) and
`payment.ts:353-401` (the two signing branches).

### Detecting the active facilitator mode

Today there is no dedicated discovery endpoint that tells you the mode —
you infer it from environment knowledge or from the 402 response:

- **Operator-side knowledge.** If you (or your platform) operates the
  gateway, the active mode is whatever `KITE_FACILITATOR_MODE` evaluates
  to at startup. Unset → `pieverse`. The hosted `app.wasiai.io` runs
  `pieverse` by default at the time of writing; track changes via the
  release notes or check the running service's env.
- **Response shape.** The 402 `accepts[0]` payload is identical in both
  modes (this is by design — clients should only need one parser), so it
  alone does not disambiguate. The `description` field on `accepts[0]`
  will not change between modes either. If you cannot ask the operator,
  **try `pieverse` first** (today's prod default). If verification fails
  with `signature invalid` and you've ruled out domain/value drift, retry
  with the `x402` recipe below.
- **Roadmap.** Adding an explicit `extra.facilitatorMode` field to the
  `accepts[0]` payload is on the backlog; until then this disambiguation
  is out-of-band.

### 4A — `pieverse` mode (today's production default)

Sign `primaryType: 'Authorization'` against the **Pieverse facilitator
contract** (NOT the token contract). The domain `name`/`version` are the
ERC-20 token's domain (`PYUSD`/`1` on Kite testnet, `USDC`/`2` on Kite
mainnet — see [networks.md](./networks.md#eip-712-domain-inbound)).

```ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { kiteTestnet } from './chain'; // or define inline — see networks.md

const account = privateKeyToAccount('<OPERATOR_PRIVATE_KEY>');
const wallet = createWalletClient({
  account,
  chain: kiteTestnet, // chainId 2368
  transport: http('<YOUR_RPC_URL>'),
});

// Pull these from the 402 response you got in step 3:
const accepts = /* parsed accepts[0] */ {
  asset: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as const, // PYUSD testnet
  payTo: '0x0000000000000000000000000000000000000000' as const, // <- from 402
  maxAmountRequired: '1000000', // 1.00 PYUSD — 6 decimals (see WARNING above)
  maxTimeoutSeconds: 60,
  network: 'eip155:2368',
};

const PIEVERSE_FACILITATOR = '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b' as const;

const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + accepts.maxTimeoutSeconds);
const nonce = `0x${crypto.getRandomValues(new Uint8Array(32))
  .reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '')}` as `0x${string}`;

const signature = await wallet.signTypedData({
  domain: {
    name: 'PYUSD',                       // token EIP-712 domain name (testnet)
    version: '1',                        // token EIP-712 domain version (testnet)
    chainId: 2368,
    verifyingContract: PIEVERSE_FACILITATOR, // <- facilitator, NOT the token
  },
  types: {
    Authorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'Authorization',
  message: {
    from: account.address,
    to: accepts.payTo,
    value: BigInt(accepts.maxAmountRequired),
    validAfter,
    validBefore,
    nonce,
  },
});
```

### 4B — `x402` mode (canonical spec; opt-in)

Sign `primaryType: 'TransferWithAuthorization'` against the **asset's
ERC-20 token contract** (whatever `accepts.asset` is). Identical struct
fields, different domain and primaryType.

```ts
const signature = await wallet.signTypedData({
  domain: {
    name: 'PYUSD',
    version: '1',
    chainId: 2368,
    verifyingContract: accepts.asset, // <- the token, NOT the facilitator
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: account.address,
    to: accepts.payTo,
    value: BigInt(accepts.maxAmountRequired),
    validAfter,
    validBefore,
    nonce,
  },
});
```

### Build the `payment-signature` header (both modes)

The wire format the middleware expects is **base64(JSON)** with at
minimum `{ authorization, signature }` and optionally `network` (the
facilitator uses it to validate the chain match). The shape is identical
across modes:

```ts
const paymentPayload = {
  authorization: {
    from: account.address,
    to: accepts.payTo,
    value: accepts.maxAmountRequired,   // string, not bigint
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  },
  signature,
  network: accepts.network,
};
const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
```

Mainnet domain values differ — see
[networks.md](./networks.md#eip-712-domain-inbound) for the USDC.e (Kite
mainnet) domain (`name: 'USDC'`, `version: '2'`, `chainId: 2366`).

---

## Step 5 — Retry with `payment-signature`

```ts
const res = await fetch('<YOUR_GATEWAY_URL>/compose', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'payment-signature': paymentHeader,
  },
  body: JSON.stringify({
    steps: [{ agentSlug: 'example-summarizer', input: { text: 'Hello world' } }],
    maxBudget: 0.5,
  }),
});
const body = await res.json();
console.log(res.status, body);
```

```bash
curl -X POST <YOUR_GATEWAY_URL>/compose \
  -H 'content-type: application/json' \
  -H "payment-signature: $PAYMENT_HEADER" \
  -d '{
    "steps": [{ "agentSlug": "example-summarizer", "input": { "text": "Hello world" } }],
    "maxBudget": 0.5
  }'
```

Possible responses:

- `200` — payment verified + settled by the facilitator. Body contains
  `kiteTxHash` plus the pipeline output.
- `402` — verification failed (bad signature, wrong domain, expired
  `validBefore`, insufficient balance). Body's `error` field explains
  why. Common causes: chain ID mismatch, mainnet domain values used on
  testnet, `value` exceeds wallet balance.
- `400` — request body is malformed (e.g. missing `steps`).
- `503` — the gateway has no operator wallet configured
  (`KITE_WALLET_ADDRESS` unset). Operator-side issue, not yours.

---

## Step 6 — Verify the on-chain transaction

Inbound payments settle on Kite. Take the `kiteTxHash` from the
response and open it in the explorer for the chain you used:

- **Kite testnet (chain `2368`)**: `https://testnet.kitescan.ai/tx/<kiteTxHash>`
- **Kite mainnet (chain `2366`)**: `https://kitescan.ai/tx/<kiteTxHash>`

If your call triggered a downstream agent payment (compose with
`WASIAI_DOWNSTREAM_X402=true` server-side), the response includes a
`downstreamTxHash` settling on Avalanche:

- **Avalanche Fuji (chain `43113`)**: `https://testnet.snowtrace.io/tx/<downstreamTxHash>`
- **Avalanche C-Chain (chain `43114`)**: `https://snowtrace.io/tx/<downstreamTxHash>`

For the full chain list, asset contracts and activation flags, read
[networks.md](./networks.md).

---

## Bring your own Kite Passport

`[ROADMAP — WKH-69]` — Kite Passport identity binding is tracked but
not implemented today. The `bindings.kite_passport` field on
`GET /auth/me` always returns `null`, and `POST /auth/bind/:chain`
returns `501 not_implemented`. Do not depend on Kite Passport flows
yet; the next iteration of this doc will land alongside WKH-69.

---

## What to read next

- [api-reference.md](./api-reference.md) — every public endpoint, status
  codes, request/response shapes.
- [mcp-integration.md](./mcp-integration.md) — JSON-RPC 2.0 tools to
  call the gateway from an MCP-aware client.
- [networks.md](./networks.md) — chain IDs, asset contracts, explorer
  URLs, activation flags.

---

## Troubleshooting

- **`402` after retry** — re-read the live `accepts[0]` payload from
  the failed retry. Common drift: client-side hardcoded amounts (always
  use `maxAmountRequired` from the response).
- **`403 A2A_KEY_REQUIRED`** — you tried to mutate `/registries`
  without an A2A key. The anonymous x402 path is read-only there.
- **`403 SCOPE_DENIED`** — your A2A key has `allowed_*` filters that
  do not include the resolved agent / registry / category. Issue a
  broader key or update the scoping.
- **`504`** — request exceeded the per-route timeout. Default
  `TIMEOUT_COMPOSE_MS=180000`, `TIMEOUT_ORCHESTRATE_MS=120000`. Reduce
  the pipeline length or increase the operator-side env.
