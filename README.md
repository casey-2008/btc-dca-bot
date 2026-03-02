# SATS.DCA — Smart Contract

On-chain Dollar Cost Averaging vault on **Bitcoin L1** via [OP_NET](https://opnet.org).

## Contract: `DCAVault`

### Methods

| Method | Caller | Description |
|---|---|---|
| `deposit()` | User | Deposit OP-20 tokens into the vault |
| `setSchedule()` | User | Set DCA schedule (outputToken, swapAmount, intervalBlocks) |
| `executeSwap()` | Anyone (keeper) | Trigger a swap when interval has elapsed |
| `cancelSchedule()` | User | Cancel schedule and refund remaining balance |
| `withdraw()` | User | Withdraw tokens without cancelling schedule |
| `getSchedule()` | Anyone | Read a user's current schedule |
| `getGlobalStats()` | Anyone | Read total deposited / swaps / active schedules |
| `canExecute()` | Anyone | Check if a user's swap is ready to execute |

### Events

- `ScheduleActivated` — emitted when a user sets up a DCA schedule
- `SwapExecuted` — emitted on each successful swap execution
- `ScheduleCancelled` — emitted when a user cancels
- `Withdraw` — emitted on token withdrawal

### Keeper Incentive

Anyone can call `executeSwap()` when the interval has elapsed.
The caller earns **0.1% (10 BPS)** of the swap amount as a fee.

---

## Build & Deploy

### Prerequisites

- Node.js >= 18
- OP_WALLET Chrome extension (set to **Testnet** or **Regtest**)
- Testnet BTC from [faucet.opnet.org](https://faucet.opnet.org/)

### 1. Install dependencies

```bash
npm install
```

### 2. Build the contract

```bash
npm run build
```

This produces `build/DCAVault.wasm`.

### 3. Deploy via OP_WALLET

1. Open **OP_WALLET** extension
2. Click **Deploy Contract**
3. Drag & drop `build/DCAVault.wasm`
4. Confirm the transaction
5. Copy the deployed contract address from OP_WALLET or [OPScan](https://opscan.org)

### 4. Update the frontend

In your frontend repo, update the contract address constant:

```ts
export const DCA_CONTRACT_ADDRESS = 'YOUR_DEPLOYED_ADDRESS_HERE';
```

---

## How DCA Works On-Chain

```
User deposits MOTO → approves contract → calls deposit()
             ↓
User calls setSchedule(outputToken=$PILL, swapAmount=100, interval=144)
             ↓
Every 144 blocks (~1 day), keeper calls executeSwap(userAddress)
  → contract deducts 100 MOTO from user balance
  → 0.1% goes to keeper, 99.9% routed via Motoswap in frontend
  → SwapExecuted event emitted
             ↓
User can withdraw() or cancelSchedule() at any time
```

> **Note on Motoswap integration:** OP_NET testnet cross-contract calls to Motoswap
> require the Motoswap router address. The frontend handles the actual swap routing;
> the contract tracks balances and enforces timing. Full Motoswap integration
> can be added once the router ABI is confirmed.

---

## Deployed Addresses

| Network | Address |
|---|---|
| Testnet | `TBD — deploy and paste here` |
| Mainnet | `Coming after March 17` |
