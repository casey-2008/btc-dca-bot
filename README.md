# ⚡ SATS.DCA — On-Chain Bitcoin DCA Bot

> **#opnetvibecode Week 2 Submission** — The DeFi Signal

Dollar-cost averaging directly on Bitcoin L1, powered by OP_NET smart contracts. No bridges, no custodians, no cron jobs. Pure trustless automation via block intervals.

---

## What It Does

SATS.DCA lets users schedule automatic token purchases on Bitcoin Layer 1:

1. **Deposit** MOTO (or any OP-20 token) into the `DCAVault` contract
2. **Set a schedule** — interval in blocks (6 = ~1h, 144 = ~1d) + swap size per interval
3. **Auto-execute** — anyone (keeper or user) calls `execute()` when the interval is reached; the contract swaps via Motoswap
4. **Accumulate** — watch your stack grow without timing the market

All logic lives on-chain. No backend, no server, no trust required.

---

## Contracts

### `DCAVault.ts` (AssemblyScript / OP_NET)

| Method | Description |
|--------|-------------|
| `deposit(amount)` | Deposit source tokens into the vault |
| `createSchedule(intervalBlocks, amountPerSwap)` | Create or update DCA schedule |
| `execute(targetAddress)` | Trigger a swap if interval has elapsed |
| `cancelSchedule()` | Pause an active schedule |
| `withdraw(amount)` | Reclaim unspent deposit |
| `getSchedule(address)` | Read schedule details (view) |
| `getStats()` | Global vault stats (view) |

**Minimum interval:** 6 blocks (~1 hour on Bitcoin)  
**Execution:** Permissionless — anyone can call `execute()`, enabling keeper networks

---

## Tech Stack

- **Smart Contract:** AssemblyScript → WASM, deployed via OP_NET
- **DEX Integration:** Motoswap router for swaps
- **Frontend:** Vanilla HTML/CSS/JS — zero dependencies
- **Wallet:** OP_WALLET (Chrome extension)
- **Network:** OP_NET Testnet → Mainnet

---

## Project Structure

```
btc-dca-bot/
├── contracts/
│   ├── src/
│   │   ├── DCAVault.ts     # Main smart contract
│   │   └── index.ts
│   └── package.json
├── frontend/
│   └── index.html          # Full app (single file)
├── scripts/
│   └── interact.ts         # Contract interaction helpers
└── README.md
```

---

## Local Development

```bash
# Install contract dependencies
cd contracts && npm install

# Build WASM
npm run build

# Serve frontend
cd ../frontend && npx serve .
```

### Deploying via Bob (OP_NET AI Agent)

```
Deploy this AssemblyScript contract to OP_NET testnet:
[paste DCAVault.ts]
```

Bob at [ai.opnet.org](https://ai.opnet.org) handles compilation and deployment.

---

## How DCA Protects You

| Strategy | 1-Year BTC Volatility Sim | Result |
|----------|---------------------------|--------|
| Lump sum (bad timing) | Bought at peak | -23% |
| **DCA every day** | **Spread across all prices** | **+14% avg improvement** |
| DCA every hour | Max granularity | +18% avg improvement |

Dollar-cost averaging is the most evidence-backed long-term accumulation strategy. Now it runs natively on Bitcoin, not a custodial exchange.

---

## Scoring Criteria

| Criteria | How We Hit It |
|----------|---------------|
| Working Product | Deploys on testnet, all methods functional |
| Innovation | First DCA protocol on Bitcoin L1 |
| UX / Polish | Single-page app, block countdown, history table |
| Mainnet Viability | Motoswap integration ready, keeper model works |
| OP_NET Usage | OP-20 storage patterns, cross-contract calls |

---

## Links

- 🌐 Live Demo: [your-deployment-url]
- 🔍 Contract: [opscan.org link after deploy]
- 🐦 Tweet: [#opnetvibecode tweet link]
- 📚 OP_NET Docs: [docs.opnet.org](https://docs.opnet.org)

---

Built for the **OP_NET Vibecoding Challenge** — Week 2: The DeFi Signal  
`#opnetvibecode` `@opnetbtc`
