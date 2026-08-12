# `contracts/` — the EVM escrow

⚠️ **This file used to be the stock README that `forge init` writes.** Sixty-six lines about what
Foundry is, with zero mentions of the contract that actually lives here. A reviewer opening this folder
got a tool description instead of documentation, which is worse than an empty file: it looks like
someone wrote it. Replaced on 2026-08-11.

## There are TWO escrows in this project, one per chain family. This is the EVM one.

That is the single most useful thing to know before reading anything else here, because the two are easy
to mix up and they share nothing but the idea:

| | Where it lives | Language | What holds the money |
|---|---|---|---|
| **EVM escrow** | **this folder** | Solidity | `WasiAIEscrow.sol`, one contract per network |
| **Solana escrow** | the `solana-programs` repo | Rust + Anchor | a program plus one account per remittance |

Chaski's Solana remittances go through the **other** one. If you are chasing a devnet deposit, you are in
the wrong folder.

## What is actually here

Measured 2026-08-11:

| File | Lines | What it is |
|---|---|---|
| `src/WasiAIEscrow.sol` | 329 | the contract |
| `src/interfaces/IWasiAIEscrow.sol` | 95 | its interface, which the TypeScript side reads |
| `test/WasiAIEscrow.t.sol` | 892 | behaviour tests |
| `test/WasiAIEscrow.invariant.t.sol` | 388 | invariant tests (fuzzed sequences of calls) |
| `test/WasiAIEscrow.invariant2.t.sol` | 687 | a second invariant suite |

So there are **1,967 lines of tests for 424 lines of contract and interface**, and two of the three
suites are invariant suites, which means they do not check one scripted case: they throw random call
sequences at the contract and check that a rule never breaks.

**`forge test` on 2026-08-11: 76 tests passed, 0 failed, 0 skipped, in under a second.** That number is a
reading of a moment. Re-run it rather than trusting this line, which is also why the command is right
below.

## No deployed address is recorded here, on purpose

Searched 2026-08-11: this folder holds no address of any deployed copy. The addresses are per-network
configuration and live in the deployment environment, never in the repo, so this README cannot go stale
about which contract is live where. To find out what is deployed, ask the network.

## The TypeScript that mirrors this contract, and will go wrong quietly

Editing the contract can break code in `src/` that copies its numbers by hand. These are the places that
do, so they are the places to check:

- `src/adapters/escrow/debit-capture.ts:55` mirrors `WasiAIEscrow.MAX_DEADLINE_TTL = 1 hours`, and says
  so, citing `WasiAIEscrow.sol:45`.
- `src/adapters/escrow/arbiter-executor.ts:50` says its `ESCROW_ABI` matches `IWasiAIEscrow.sol:24-28`
  **byte for byte**.

A copied constant and a hand-written ABI are both the same trap: nothing fails at build time when the
contract changes underneath them. If you change a constant or a function signature, grep for it here.

## Running it

Foundry is the toolchain: `forge` builds and tests, `cast` talks to a chain, `anvil` runs a local one.
Install it from [getfoundry.sh](https://book.getfoundry.sh/getting-started/installation).

```bash
forge build            # compile
forge test             # the 3 suites above
forge test -vvv        # with traces, for when one fails
forge fmt              # format
forge snapshot         # gas snapshot
```

Full Foundry docs: https://book.getfoundry.sh/
