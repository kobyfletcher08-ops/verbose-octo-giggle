# Base + BSC Telegram DEX arbitrage bot

**Version 3.0, written in Node.js:** set up and operate the trading wallet from a private Telegram bot. Wallet import/create/unlock, contract deployment, approvals, limits, paper/live mode, automatic trades, withdrawals and encrypted backups are available through the bot.

**Experimental, unaudited software.** Local tests are not an audit or evidence of profitable mainnet opportunities. Reverted transactions still spend gas. The bot's server holds the unlocked signing key while it operates. Keep only intended trading funds in this wallet. No mainnet transaction was broadcast during this build.

## Supported DEX routes

| Chain | Round trip | DEXs | Capital source |
| --- | --- | --- | --- |
| Base, 8453 | USDC → WETH → USDC | Uniswap V2 ↔ PancakeSwap V2 | Aave V3 flash loan or wallet USDC |
| BNB Smart Chain, 56 | USDT → WBNB → USDT | Uniswap V2 ↔ PancakeSwap V2 | Aave V3 flash loan or wallet USDT |

Both swaps and any loan repayment happen atomically on the same chain. Both directions are checked, using direct V2 pairs. No CEX orders, bridges, cross-chain trades, arbitrary tokens, V3/V4 or Aerodrome adapters are included. If pools or loans are unavailable, too small or unprofitable, the bot skips the route. The retained original DEX Screener CLI is indicative only; its spot gaps never authorize live trades.

## One-time hosting setup

Telegram needs a running bot server and an HTTPS address for the wallet form. This initial infrastructure setup needs your BotFather token; afterward the trading workflow runs through Telegram.

1. Create a bot with the official [@BotFather](https://t.me/BotFather) using `/newbot`.
2. Extract the ZIP. Copy `.env.example` to `.env`. Set `BOT_TOKEN` and either your numeric `OWNER_TELEGRAM_ID` or use the one-time pairing code printed at startup.
3. Host the included wallet form over HTTPS. Choose one of the two options below. Keep the bot's `data` directory persistent and private.

### Docker Compose with automatic HTTPS

On a server with Docker Compose and a domain pointing to it, set these initial `.env` values:

```dotenv
BOT_TOKEN=your_botfather_token
OWNER_TELEGRAM_ID=your_numeric_telegram_id
APP_DOMAIN=bot.your-domain.com
```

Allow incoming ports 80 and 443 for the included Caddy proxy, then run:

```bash
docker compose up -d --build
```

The proxy serves `https://bot.your-domain.com`; the bot's HTTP port stays inside the container network. Docker volumes preserve the encrypted wallet, state and certificates. If you leave `OWNER_TELEGRAM_ID` empty, read the pairing command with `docker compose logs bot`, then send that command to the bot in a private chat. Keep the pairing command private.

### Node.js behind an existing HTTPS proxy

Use current Node.js 22 or 24 LTS, minimum 22.9:

```bash
npm ci --omit=dev --ignore-scripts
npm start
```

Set `APP_PUBLIC_URL=https://bot.your-domain.com` in `.env`. Proxy that domain to `127.0.0.1:3000`, preserving POST bodies and the Origin header. Use the same origin at the public URL; the app refuses cross-origin API requests. Do not expose port 3000 directly to the internet.

Only one process should poll this bot token and sign with this wallet. Use a new BotFather bot or remove any pre-existing webhook. `/id` reveals the sender's own numeric ID without granting access. Groups/channels and other users cannot control the bot. A public URL alone does not authenticate wallet setup: the backend verifies Telegram's signed launch data, its age and the paired owner's ID.

## Deploy with Render (GitHub)

1. Create a **private** GitHub repository and upload these project files at the repository root (not an enclosing folder). Do **not** upload `.env`, `data/`, seed phrases, or private keys. `.gitignore` excludes `.env` and `data/`.
2. In [Render](https://dashboard.render.com/) select **New > Blueprint**, link the private GitHub repository, and select its `render.yaml`. Review billing before creating the Blueprint: it selects a **paid** Docker web service and a **1 GB persistent disk** because wallet/owner/state data must survive restarts. Do not use an ephemeral/free service with a funded wallet.
3. During creation, set `BOT_TOKEN` to the secret token from Telegram [@BotFather](https://t.me/BotFather). Do not put it in GitHub or chat. The bot automatically uses Render's HTTPS `RENDER_EXTERNAL_URL` for the wallet form. If you later add a custom domain, set `APP_PUBLIC_URL` explicitly to its HTTPS origin and redeploy.
4. After deployment, visit `https://<your-render-hostname>/healthz` and confirm `{"ok":true}`. In Render logs, find the private `/start <pair-code>` command unless you have configured your numeric `OWNER_TELEGRAM_ID` directly in Render's Environment tab. Start the bot in a **private** Telegram chat.
5. Run `/setup`, create a fresh dedicated wallet through the authenticated Telegram HTTPS form, and start in **paper mode**. Do not move real funds until you have independently reviewed the unaudited code and on-chain deployment. Tests and paper mode are not proof of live profitability.

This Blueprint disables automatic deploys for predictable bot restarts. Deploy updated commits manually from the Render dashboard. Keep **one instance** per bot token. The persistent disk contains the encrypted wallet and bot state; your separate wallet password and phrase need their own secure backups. Unlocking after a restart is required unless you separately provide a secure password file, which is **not** included in the Git repository.

## Complete setup inside Telegram

Open the paired bot, send `/setup`, and follow its buttons:

1. **Wallet setup → Import / create / unlock wallet.** The form opens inside Telegram. Enter a valid English BIP-39 phrase, optionally its BIP-39 passphrase and account path, or generate a new 24-word wallet. Review the full derived address. Set and confirm a separate wallet encryption password of at least 12 characters. Save a generated phrase outside Telegram before continuing.
2. **Deposit.** The bot displays the wallet address and networks. Send ETH on Base and/or BNB on BSC for gas from your existing wallet or exchange. Funded mode also needs USDC on Base or USDT on BSC. Flash loans fund trading principal, not gas or deployment.
3. **Choose Base, BSC or Both.** Use one chain first while validating your setup.
4. **Deploy Base / Deploy BSC.** Review the owner, predicted executor address, estimated fee and maximum fee ceiling. Tap Confirm to broadcast. After two confirmations, the bot verifies the runtime bytecode, owner and immutable protocol configuration and automatically saves the executor address. No file editing or restart is needed. To attach a previously deployed copy of the included contract, use `/executor base 0xAddress` or `/executor bsc 0xAddress`.
5. **Choose funding.** `/funding flashloan` uses Aave V3 `flashLoanSimple`. Availability and actual premium are checked on-chain. `/funding funded` uses wallet tokens: deposit principal, then use `/approve base 1000` or `/approve bsc 1000`. Approval is bounded by your maximum trade size. A nonzero allowance can require a separately confirmed zero reset followed by the Finish approval button. `/revoke base` or `/revoke bsc` sets allowance to zero.
6. **Settings and Check setup.** Change size, profit floor, slippage and other limits in the chat. `/check` verifies the configured chain/DEX/executor and fully simulates a qualifying opportunity when one exists. Lack of a qualifying route is not a successful simulation.
7. **Paper mode → Start trading.** The bot simulates qualifying atomic trades without broadcasting trades. Deployment, approvals and withdrawals remain real transactions when their previews are confirmed, including in paper mode.
8. **Live mode → Confirm live mode → Start trading.** `/mode live` is a separate reviewed mode change. It leaves automatic trading paused. An unlocked wallet and verified executor are required before `/trade on`. Once activated, qualifying trades execute automatically within the saved limits without individual trade confirmations.

The seed is derived in the wallet form on your device. The phrase and BIP-39 passphrase are not sent to Telegram or saved on the server. The derived private key and encryption password are RSA-OAEP encrypted for the bot server and sent directly over HTTPS, using a short-lived, single-use authenticated request. Only the derived key is saved in an encrypted Ethereum V3 keystore with mode 600. This is server-side signing; the server temporarily holds the unlocked key. The form does not use localStorage, Telegram CloudStorage, analytics or logging of secrets. The pinned ethers browser module is served by the same bot server.

**Never paste a real seed, key or encryption password into a chat message.** The bot directs seed-like text to the form and tries to delete it. Deletion cannot undo disclosure through a messaging service. Use a trusted, private host and a dedicated wallet.

## Commands

| Command | Action |
| --- | --- |
| `/setup` | Guided wallet/chain/contract/funding/trading setup |
| `/wallet`, `/import`, `/unlock` | Open wallet import/create/unlock form inside Telegram |
| `/lock` | Lock signing and pause trading; pending tracking stays available |
| `/deposit` | Display the public wallet address and correct funding networks |
| `/backup` | Send the encrypted JSON keystore to the owner in Telegram; no password or seed is included |
| `/deploy base` / `/deploy bsc` | Preview, confirm, verify and automatically configure the executor |
| `/executor chain 0xAddress` | Verify and attach an existing included executor |
| `/approve chain [amount]`, `/revoke chain` | Preview/confirm bounded allowance or revoke it |
| `/mode paper` / `/mode live` | Switch mode; live requires its confirmation button |
| `/funding flashloan` / `/funding funded` | Select the capital source and pause trading |
| `/settings`, `/configure`, `/set name value` | Review and change validated limits without restarting |
| `/size 100`, `/chains base` / `bsc` / `both` | Set size or selected chains and pause trading |
| `/scan [base\|bsc\|both]` | Fresh round-trip quotes; never executes a trade |
| `/watch on` / `/watch off` | Enable/disable opportunity alerts |
| `/trade on` / `/trade off`, `/pause` | Start/stop automatic execution or pause all monitoring |
| `/withdraw chain token amount 0xRecipient` | Preview/confirm a native or quote-token transfer |
| `/status`, `/check [chain]`, `/history` | Configuration, checks and last confirmed transactions |
| `/pending`, `/reconcile` | Track intended transaction hashes and confirmation status |
| `/cancel`, `/help`, `/id` | Cancel an input/preview, help or your own Telegram ID |

Examples:

```text
/set profit 2
/set slippage_bps 30
/set base_rpc https://your-base-rpc-host
/withdraw base ETH 0.01 0xRecipientWallet
/withdraw bsc USDT 100 0xRecipientWallet
```

`/configure` lists every supported setting. Numeric inputs use decimal amounts, not scientific notation. `profit`, `size` and `max_size` use USDC units on Base and USDT units on BSC. `slippage_bps` uses basis points; `base_gas_price` and `bsc_gas_price` use gwei; gas caps/daily budgets use native ETH/BNB. Saved bot settings override the initial `.env` values on subsequent starts. All changes pause trading; use Start trading again after review.

## Restarts, backups and pending transactions

A restart loads the public address and encrypted keystore without a terminal password prompt. Use `/unlock` inside Telegram and then `/trade on` to resume live trading. A locally configured `WALLET_PASSWORD_FILE` with mode 600 optionally permits unattended unlocking; its setup is a host administration choice. `/backup` sends only the encrypted keystore. Keep the encryption password and original seed backup separately. The wallet form also offers a browser download of the encrypted file; use `/backup` if your Telegram client does not support that download.

Keep `data` persistent. It contains encrypted wallet material, the paired owner, saved settings, executor addresses and intended hashes. Wallet import refuses to overwrite an existing keystore. The local maintenance CLI remains available for advanced recovery; stop the bot before using an external signer or modifying files.

Any unresolved trade, deployment, approval or withdrawal blocks every further transaction. Intent hashes are saved **before** broadcasting. An ambiguous RPC response retains that hash and keeps trading paused; the bot never automatically repeats it. `/pending` provides the explorer link and `/reconcile` checks for two confirmations. Do not delete pending records to force another attempt. If the RPC cannot locate the intended hash, investigate the wallet nonce and original transaction before resubmitting. Two confirmations are not irreversible finality. `/pause` cannot cancel a transaction already sent to the chain.

One-off transaction previews expire after two minutes and can be used once. Confirmation rechecks transaction details, nonce, fees and gas balance. Deployment uses a ceiling of ten times the chain trading gas cap; approval/withdrawal use the trading gas cap. These manual setup/withdrawal transactions have individual fee limits and sit outside the automatic trade daily counters.

## Automatic execution checks

Both exact-input swaps are quoted at a pinned block, including router fees and AMM impact. The bot re-quotes, fully simulates, estimates gas, verifies native balance/nonce/chain and rejects stale quotes or excessive fees before signing. Pool-reserve and trade-share caps filter small pools. The contract validates ownership, fixed routers/tokens, loan callback provenance, deadlines, outputs, repayment and minimum profit. Losses or repayment failures revert the entire round trip; reverted transactions still spend gas.

Estimated profit deducts a loan-fee allowance and a conservative native-gas valuation from pool reserve prices. The on-chain token-profit floor includes this gas budget plus the configured minimum net token profit. Base separately checks estimated L1-data/operator fees against an extra allowance. Prices, fees, MEV, RPC behavior and inclusion can change. These checks do not guarantee realized net profit. No private MEV relay is integrated.

Automatic trade limits use UTC days, reserve the full native gas budget and count uncertain submissions conservatively. They do not refund unused budget after cheaper transactions. Minimum profit is in quote-token units, not guaranteed dollars. Public RPCs are initial defaults; reliable RPCs with contract calls/estimation support are needed for actual operation.

## Development and validation

Runtime: Node.js; contract: Solidity. Python is not required. Compiled ABI/bytecode are included.

```bash
npm ci --ignore-scripts
npm test
npm run compile
```

Tests use local mock DEXs/tokens/lender and a local EVM, a mocked Telegram API, and an authenticated local wallet server. No real keys, Telegram account, mainnet deployment or trade are used. Ganache may fall back to its JavaScript implementation on newer Node versions. Mainnet integration and profitability remain unverified. See [VALIDATION.md](VALIDATION.md) and [SOURCES.md](SOURCES.md).
