# Self-Rescue 7702 — Telegram, multiple EVM chains, private relayer

**Experimental, unaudited. Never use with significant funds without independent auditing and testnet simulation.**

A separate owner-controlled Telegram rescue bot in the same repository as the arbitrage bot. It is *not* a magic fix for a wallet whose private key an attacker controls. The attacker can still sign transactions and revoke or replace EIP-7702 code. There is no guarantee a rescue will beat an attacker.

## Security model

* The original wallet's private key **never** goes to Telegram, Render, GitHub, or the bot server. The user signs two things **locally**: a chain-specific EIP-7702 delegation authorization and a one-time EIP-712 rescue instruction.
* The EIP-712 signed instruction authorizes exactly **one chain, EOA, asset (native/ERC-20), safe recipient, minimum raw-unit balance, nonce, and deadline**. The contract transfers its whole currently available balance of that asset to the safe destination. A namespaced used-nonce prevents replay.
* A funded *different* `RESCUE_RELAYER_KEY` on Render pays gas to broadcast a type-4 EIP-7702 transaction atomically. This is **gas sponsored for the compromised wallet**, not fee-free; the relayer pays gas. The relayer cannot choose a different rescue recipient without invalidating the signature.
* Built-in private submission uses `eth_sendRawTransaction` to Flashbots Protect on Ethereum. Other chains require your own **verified private RPC endpoint**. The bot never falls back to a public RPC. No claim of privacy can be guaranteed by the code if a provider itself rebroadcasts publicly.
* A signed EIP-7702 delegation sets code on the account **persistently**. It is not revoked just because the rescue is complete. The EOA's original private key retains absolute control. Delegate contracts must be independently audited; do not authorise arbitrary implementations.

## What works

* Auto watch native coin or **one supported ERC-20 per signed job** per chain; send when balance >= locally signed minimum, with a one-time nonce.
* Built-in presets: Ethereum (1), Base (8453), BSC (56). More compatible EVM networks can be entered at runtime with `/chainadd NAME ID HTTPS_RPC` (up to 20 entries). Node and relay must actually support EIP-7702, and the rescue contract must be deployed **individually on every selected chain**. This does not blindly claim all networks are compatible.
* Telegram: `/start`, `/help`, `/chains`, `/chainadd`, `/chaindel`, upload `rescue-*.json` signed package, `/jobs`, `/check ID`, `/watch on|off`, `/mode paper|live`, `/execute ID`, `/pause`, `/status`.
* Strictly owner-locked Telegram private chat via `RESCUE_OWNER_TELEGRAM_ID`. Separate bot token from arbitrage bot. No user key/seed import in Telegram.
* Persistent JSON job storage, proof-of-ownership signature verification at import, deployed bytecode matching compiled local source, strict cross-chain checks, spending cap and per-day transaction cap, no public broadcast fallback, status reconciliation.

## 1. Compile / deploy an immutable delegate (one time per chain)

From cloned repository on a trusted machine:

```sh
npm ci
node rescue/compile.mjs
# Set RESCUE_DEPLOYER_KEY in the local process environment (not Render/GitHub).
# The deployer pays gas for creating the immutable contract.
node rescue/prepare.mjs deploy --rpc https://ethereum-rpc.publicnode.com --chain 1
```

Record the `Delegate address` returned. On the chosen block explorer **verify the deployed source bytecode and independently review the contract**. Never send an EIP-7702 authorization to a contract you have not inspected. Solidity is compiled using the repo's locked `solc` version. You need a different deployment address for each chain unless deliberately deployed deterministically (not included).

## 2. Locally sign a one-shot rescue package

**Only run this command locally.** Set `RESCUE_OWNER_PRIVATE_KEY` in your computer's environment (never in Render). **Do not enter this key into any Telegram message, bot Mini App, website or GitHub code.** Sign and stop using the compromised key on completion. Use a new safe destination wallet not derived from the compromised seed. If your seed is known to an attacker, moving its assets is an ongoing race.

```sh
node rescue/prepare.mjs sign \
  --rpc https://ethereum-rpc.publicnode.com \
  --chain 1 \
  --delegate 0xYOUR_VERIFIED_DEPLOYED_DELEGATE \
  --token native \
  --safe 0xYOUR_NEW_SAFE_WALLET \
  --min 1 \
  --hours 24 \
  --out rescue-job.json
```

* `--token native` is native ETH/BNB/etc; for ERC-20 use its checksummed token contract address.
* `--min` is an **integer in the smallest token units**, e.g. USDC 6 decimals: `1000000` means 1 USDC. Use `--min 1` to sweep any balance >0.
* The signed rescue sweeps the entire asset balance at execution, not just the threshold.
* The signed job file contains signatures and addresses, **not** any secret key. Signatures are nonetheless sensitive instructions: upload ONLY to the owner's bot and avoid public GitHub.
* `--hours` can be max 168 (7 days); the authorization itself stays reusable until its EOA nonce changes. The EIP-712 job becomes unusable after expiration.

## 3. Deploy a separate Render bot without changing arbitrage bot

In [Render](https://dashboard.render.com), **New → Blueprint**, choose the existing GitHub repository, set **Blueprint Path** to **`rescue/render.yaml`** (rather than the root arbitrage `render.yaml`), and deploy its paid Docker web service with persistent disk at `/app/data`.

Set these private Render environment values when prompted:

| Variable | Description |
| --- | --- |
| `RESCUE_BOT_TOKEN` | A new @BotFather token; **not** arbitrage `BOT_TOKEN` |
| `RESCUE_OWNER_TELEGRAM_ID` | Your numeric Telegram account ID |
| `RESCUE_RELAYER_KEY` | Private key for **a separate gas-payer wallet**, funded with native gas on enabled chains |
| `RESCUE_PRIVATE_RPC_1` | `https://rpc.flashbots.net/fast` (Ethereum default) |
| `RESCUE_PRIVATE_RPC_8453` | Verified private-submit-capable Base provider, if used |
| `RESCUE_PRIVATE_RPC_56` | Verified private-submit-capable BSC provider, if used |
| `RESCUE_PRIVATE_RPC_12345` | A compatible private RPC for a custom chain ID |
| `RESCUE_RPC_12345` | Optional secret-bearing public-read RPC for custom network (env only, **never paste API keys in Telegram**) |
| `RESCUE_MAX_GAS_COST_WEI` | Cap per transaction worst-case gas cost; default `15000000000000000` (0.015 native) |
| `RESCUE_MAX_TX_PER_DAY` | Default 5 |
| `ENABLE_RESCUE_LIVE` | **`false` by default**; explicitly change to `true` to allow `/mode live` |

This is a second Render service; do not run two Telegram polling processes with the same token. Use paid persistent storage; Render Free restarts will drop state and can sleep.

## 4. Operate in Telegram

Upload the **signed JSON** as a document to your private rescue bot. No seed phrases. Then:

```text
/jobs
/check <id>
/watch on
/status
```

In **paper mode**, the bot reports when the signed threshold is reached; no transaction is broadcast.

Only after testing, enable `ENABLE_RESCUE_LIVE=true` in Render, restart, and send `/mode live`. Monitoring with `/watch on` will automatically submit a private type-4 or delegated type-2 transaction when a job meets the threshold. `/execute <id>` does a one-off private submission in live mode. There is **no public fallback**.

If a private RPC accepts a transaction but it doesn't confirm, the bot marks it `unconfirmed` after 2 minutes and does NOT blindly replace/resend it. Check the hash carefully to avoid duplicate relayer costs. Attacker front-running or delegation nonce changes can still make the rescue fail, using relayer gas. A failed EIP-7702 execution can **still leave delegation set** even when a rescue reverts.

## Caveats

* Solana/Bitcoin and EVM networks without EIP-7702 support are not compatible. ERC-721/ERC-1155/NFT, protocol withdrawal, LP/unlock, permit, and private bundle APIs are **not implemented**; only native and standard ERC-20.
* The bot does **not** deploy the delegate automatically on new chains; deployment is an intentional one-time on-chain transaction made by the user.
* A Telegram owner ID controls access to job submission; **keep the Telegram account secured**. After compromise, use a newly generated safe wallet and consider all previously compromised keys unsafe.
* Hidden orderflow improves privacy but neither guarantees inclusion nor reliably beats a competing attacker transaction. On some L2s there is no Ethereum-style public mempool or Flashbots route; check provider properties.
* Keep rescue job files and owner keys out of GitHub; `.gitignore` covers `rescue-*.json` and `.env`, but review every commit.

### References

* [EIP-7702 specification](https://eips.ethereum.org/EIPS/eip-7702)
* [Ethers v6 EIP-7702 authorization](https://docs.ethers.org/v6/single-page/)
* [Flashbots Protect private RPC](https://docs.flashbots.net/flashbots-protect/quick-start)
* [Render custom Blueprint paths](https://render.com/changelog/blueprints-now-support-custom-filenames-and-paths)
