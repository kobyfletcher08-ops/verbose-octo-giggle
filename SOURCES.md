# Integration sources

Reviewed 2026-10-11. Fixed addresses are in `lib/networks.mjs`; chain, token, factory and executor configuration are validated before execution. Liquidity and loan availability are runtime checks.

- [Telegram Bot API](https://core.telegram.org/bots/api): HTTPS JSON, long polling, command menus, callbacks, limits and flood-control handling.
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps): inline Web App buttons, SDK initialization and signed init-data validation. The bot checks the owner, age and HMAC before issuing a one-use encrypted wallet session.
- [Official BotFather](https://t.me/BotFather): create the bot/token.
- [Uniswap V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments): Base/BSC factories and Router02.
- [PancakeSwap V2 deployments](https://developer.pancakeswap.finance/contracts/v2/addresses): Base/BSC factories and routers.
- [Aave deployed contracts](https://aave.com/docs/resources/addresses): official Address Book link.
- [Aave V3 Base Address Book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol): Pool, WETH and native USDC.
- [Aave V3 BNB Address Book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BNB.sol): Pool, WBNB and USDT. BSC USDT uses 18 decimals.
- [Aave V3 flash loans](https://aave.com/docs/aave-v3/guides/flash-loans): receiver callback, fee getter and repayment.
- [ethers v6 wallets](https://docs.ethers.org/v6/api/wallet/): derivation, encryption and unlocking; dependency pinned to 6.17.0.
- [OP Stack transaction fees](https://docs.optimism.io/op-stack/transactions/fees): execution, L1-data and operator fees; the bot uses a conservative extra-fee allowance.
- [BNB RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).
- [Base JSON-RPC reference](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getTransactionCount).
- [Caddy running guide](https://caddyserver.com/docs/running) and [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy): included Docker Compose HTTPS hosting.
- [Docker Compose environment variables](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation): initial token/domain configuration and container environment overrides.
- [DEX Screener API](https://docs.dexscreener.com/api/reference): used only by the separate retained indicative CLI.

The executor and bot application were written for this project. Protocol contract source is not copied into the executor. Dependencies retain their upstream licenses.
