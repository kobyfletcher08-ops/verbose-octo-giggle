# Delivered validation — version 3.0

Date: 2026-10-11. Runtime: Node.js 24.19.0 on Linux. Solidity compiler: 0.8.30, optimizer 200 runs, Paris EVM target. Default trading mode: paper.

- `npm test`: **34 passed, 0 failed, 0 skipped**.
- Real transactions on an isolated local EVM cover atomic funded/flash-loan trades, actual premium repayment, losing-trade reverts, allowance cleanup and owner/router/callback/deadline guards.
- Trading engine checks cover fresh on-chain quotes, simulation, signed execution, Base additional-fee allowances, gas/daily limits, intended-hash persistence before broadcast, paused execution, paper mode, reserve enablement and confirmation reconciliation.
- New Telegram lifecycle tests cover setup buttons, private owner authentication, unauthorized/group rejection, saved settings, reviewed live-mode activation, locked-wallet refusal, bounded deployment/approval/withdrawal previews and single-use confirmations.
- Local EVM setup transactions cover deployment and automatic executor verification/configuration, bounded approvals, zero reset followed by finishing approval, revocation, native/quote-token withdrawals and ambiguous/disk-failed broadcasts without retries.
- Wallet tests cover seed derivation, encrypted keystore round trips, lock/unlock, host-credential/path isolation from saved Telegram settings and state persistence.
- Mini App tests verify signed launch-data HMAC, the paired owner, age, duplicates and private context. Web Crypto RSA-OAEP requests are bound to one expiring session and cannot be reused.
- An actual local HTTP server test exercises wallet import, lock/unlock, encrypted backup, Origin enforcement and authenticated assets; it checks that seed/password/plaintext-key material is absent from saved data and Telegram notices.
- The shipped frontend controller is executed with a DOM fixture and real Web Crypto/server requests. It derives the selected account, submits encrypted data, rejects a bad replacement seed and clears secret inputs. This is not a browser-rendering test.
- Telegram encrypted backup uses multipart `sendDocument`, tested with a mocked API request.
- Clean production install: `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` succeeded with 9 runtime packages. No new runtime dependency was added.
- Production-only bot startup, owner commands, unauthorized-user rejection, settings persistence, wallet HTML/ethers-module serving and graceful shutdown passed with a mocked Telegram API. No real Telegram messages were sent.
- Syntax checks passed for 36 JavaScript modules, including application and test code. Docker Compose YAML parsed with no published bot HTTP port. The Docker/Caddy deployment itself was not launched here.
- The prior full dependency install passed; Ganache's optional Mac-only dependency lock metadata remains corrected for Linux installation.

## Limits

No real seed, Telegram account/token, funds, mainnet deployment or mainnet trade were used. The wallet Mini App has not been opened in a real Telegram client. A headless browser could not be installed in this environment because its download was unavailable, so mobile rendering and native Telegram WebView behavior remain unverified.

The previous standard ethers mainnet RPC probes timed out. A separate raw probe returned BSC chain ID 56; Base returned HTTP 403. Those results do not verify current liquidity, loan availability, runtime integrations or profitable routes. Mainnet/fork execution remains unverified.

The test AMMs, tokens and lender are mocks. These tests do not provide a security audit, protocol-accurate fork validation, MEV protection or a profitability guarantee. Review the source, use `/check`, and validate in paper mode before enabling live execution. Reverted mainnet transactions still consume gas.
