import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    DeployableContract,
    encodeSelector,
    Selector,
    StoredU256,
    StoredBoolean,
    StoredAddress,
    NetEvent,
    BOOLEAN_BYTE_LENGTH,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─── Storage Pointer Layout ──────────────────────────────────────────────────
// Each user's schedule is stored under a unique sub-pointer derived from their address.
// Pointer namespace (u16):
//   1 → inputToken per user
//   2 → outputToken per user
//   3 → depositBalance per user
//   4 → swapAmountPerInterval per user
//   5 → intervalBlocks per user
//   6 → lastExecutedBlock per user
//   7 → totalBought per user
//   8 → isActive per user
//   9 → totalDeposited (global)
//  10 → totalSwapsExecuted (global)
//  11 → totalActiveSchedules (global)
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER_FEE_BPS: u64 = 10; // 0.1% keeper fee in basis points

// ─── Events ──────────────────────────────────────────────────────────────────

class ScheduleActivatedEvent extends NetEvent {
    constructor(user: Address, inputToken: Address, outputToken: Address, depositAmount: u256, swapAmount: u256, intervalBlocks: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 3 + U256_BYTE_LENGTH * 3);
        writer.writeAddress(user);
        writer.writeAddress(inputToken);
        writer.writeAddress(outputToken);
        writer.writeU256(depositAmount);
        writer.writeU256(swapAmount);
        writer.writeU256(intervalBlocks);
        super('ScheduleActivated', writer);
    }
}

class SwapExecutedEvent extends NetEvent {
    constructor(user: Address, amountIn: u256, amountOut: u256, executor: Address) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH * 2);
        writer.writeAddress(user);
        writer.writeU256(amountIn);
        writer.writeU256(amountOut);
        writer.writeAddress(executor);
        super('SwapExecuted', writer);
    }
}

class ScheduleCancelledEvent extends NetEvent {
    constructor(user: Address, refundAmount: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        writer.writeAddress(user);
        writer.writeU256(refundAmount);
        super('ScheduleCancelled', writer);
    }
}

class WithdrawEvent extends NetEvent {
    constructor(user: Address, token: Address, amount: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        writer.writeAddress(user);
        writer.writeAddress(token);
        writer.writeU256(amount);
        super('Withdraw', writer);
    }
}

// ─── Main Contract ────────────────────────────────────────────────────────────

@final
export class DCAVault extends DeployableContract {

    // Global stats
    private readonly _totalDeposited: StoredU256;
    private readonly _totalSwapsExecuted: StoredU256;
    private readonly _totalActiveSchedules: StoredU256;

    public constructor() {
        super();

        // Global storage slots (pointer, sub-pointer)
        this._totalDeposited = new StoredU256(9, u256.Zero);
        this._totalSwapsExecuted = new StoredU256(10, u256.Zero);
        this._totalActiveSchedules = new StoredU256(11, u256.Zero);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    public override onDeployment(_calldata: Calldata): void {
        // Nothing to init — storage defaults to zero/false
    }

    // ─── Method Dispatch ─────────────────────────────────────────────────────

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case encodeSelector('deposit()'):
                return this.deposit(calldata);
            case encodeSelector('setSchedule()'):
                return this.setSchedule(calldata);
            case encodeSelector('executeSwap()'):
                return this.executeSwap(calldata);
            case encodeSelector('cancelSchedule()'):
                return this.cancelSchedule(calldata);
            case encodeSelector('withdraw()'):
                return this.withdraw(calldata);
            case encodeSelector('getSchedule()'):
                return this.getSchedule(calldata);
            case encodeSelector('getGlobalStats()'):
                return this.getGlobalStats();
            case encodeSelector('canExecute()'):
                return this.canExecute(calldata);
            default:
                return super.execute(method, calldata);
        }
    }

    // ─── deposit() ────────────────────────────────────────────────────────────
    // Calldata: address inputToken, u256 amount
    // User must have approved this contract for `amount` on the inputToken contract BEFORE calling deposit.
    private deposit(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const inputToken: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        assert(amount > u256.Zero, 'Amount must be > 0');

        // transferFrom user → this contract via cross-contract call
        this._transferFrom(inputToken, user, Blockchain.contractAddress, amount);

        // Update user deposit balance
        const currentBalance = this._getUserBalance(user);
        this._setUserBalance(user, currentBalance + amount);

        // Store inputToken for user (if not set yet)
        const stored = this._getUserInputToken(user);
        if (stored.isZero()) {
            this._setUserInputToken(user, inputToken);
        }

        // Update global stat
        this._totalDeposited.value = this._totalDeposited.value + amount;

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── setSchedule() ────────────────────────────────────────────────────────
    // Calldata: address outputToken, u256 swapAmountPerInterval, u256 intervalBlocks
    private setSchedule(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const outputToken: Address = calldata.readAddress();
        const swapAmount: u256 = calldata.readU256();
        const intervalBlocks: u256 = calldata.readU256();

        assert(swapAmount > u256.Zero, 'Swap amount must be > 0');
        assert(intervalBlocks >= u256.fromU64(6), 'Interval must be >= 6 blocks (~1 hour)');

        const balance = this._getUserBalance(user);
        assert(balance >= swapAmount, 'Deposit balance < swap amount');

        const wasActive = this._getUserIsActive(user);

        this._setUserOutputToken(user, outputToken);
        this._setUserSwapAmount(user, swapAmount);
        this._setUserInterval(user, intervalBlocks);
        this._setUserLastExecuted(user, Blockchain.blockNumber);
        this._setUserIsActive(user, true);

        if (!wasActive) {
            this._totalActiveSchedules.value = this._totalActiveSchedules.value + u256.One;
        }

        this.emitEvent(new ScheduleActivatedEvent(
            user,
            this._getUserInputToken(user),
            outputToken,
            balance,
            swapAmount,
            intervalBlocks
        ));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── executeSwap() ────────────────────────────────────────────────────────
    // Calldata: address user
    // Anyone can call — keeper earns KEEPER_FEE_BPS of the swap amount
    private executeSwap(calldata: Calldata): BytesWriter {
        const targetUser: Address = calldata.readAddress();
        const executor: Address = Blockchain.tx.sender;

        assert(this._getUserIsActive(targetUser), 'Schedule not active');

        const lastBlock = this._getUserLastExecuted(targetUser);
        const interval = this._getUserInterval(targetUser);
        const currentBlock = Blockchain.blockNumber;

        assert(
            currentBlock >= lastBlock + interval,
            'Interval not elapsed yet'
        );

        const balance = this._getUserBalance(targetUser);
        const swapAmount = this._getUserSwapAmount(targetUser);

        assert(balance >= swapAmount, 'Insufficient balance for swap');

        // Calculate keeper fee
        const keeperFee: u256 = (swapAmount * u256.fromU64(KEEPER_FEE_BPS)) / u256.fromU64(10000);
        const netSwapAmount: u256 = swapAmount - keeperFee;

        // Deduct from user balance
        this._setUserBalance(targetUser, balance - swapAmount);

        // If balance after swap < swapAmount → deactivate
        const newBalance = balance - swapAmount;
        if (newBalance < swapAmount) {
            this._setUserIsActive(targetUser, false);
            this._totalActiveSchedules.value = this._totalActiveSchedules.value - u256.One;
        }

        // Update last executed block
        this._setUserLastExecuted(targetUser, currentBlock);

        // Update global stats
        this._totalSwapsExecuted.value = this._totalSwapsExecuted.value + u256.One;

        // Update user totalBought (tracked as inputToken spent — actual swap via Motoswap in frontend)
        const prevBought = this._getUserTotalBought(targetUser);
        this._setUserTotalBought(targetUser, prevBought + netSwapAmount);

        // Transfer keeper fee to executor
        if (keeperFee > u256.Zero) {
            const inputToken = this._getUserInputToken(targetUser);
            this._transfer(inputToken, executor, keeperFee);
        }

        this.emitEvent(new SwapExecutedEvent(targetUser, swapAmount, netSwapAmount, executor));

        const writer = new BytesWriter(U256_BYTE_LENGTH * 2);
        writer.writeU256(swapAmount);
        writer.writeU256(netSwapAmount);
        return writer;
    }

    // ─── cancelSchedule() ────────────────────────────────────────────────────
    private cancelSchedule(_calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;

        const wasActive = this._getUserIsActive(user);
        if (wasActive) {
            this._setUserIsActive(user, false);
            this._totalActiveSchedules.value = this._totalActiveSchedules.value - u256.One;
        }

        const refund = this._getUserBalance(user);
        if (refund > u256.Zero) {
            const inputToken = this._getUserInputToken(user);
            this._setUserBalance(user, u256.Zero);
            this._transfer(inputToken, user, refund);
        }

        this.emitEvent(new ScheduleCancelledEvent(user, refund));

        const writer = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(refund);
        return writer;
    }

    // ─── withdraw() ───────────────────────────────────────────────────────────
    // Calldata: u256 amount
    private withdraw(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const amount: u256 = calldata.readU256();

        const balance = this._getUserBalance(user);
        assert(balance >= amount, 'Insufficient balance');

        const inputToken = this._getUserInputToken(user);
        this._setUserBalance(user, balance - amount);

        // If withdrawal leaves balance < swapAmount, deactivate
        const remaining = balance - amount;
        const swapAmount = this._getUserSwapAmount(user);
        if (remaining < swapAmount && this._getUserIsActive(user)) {
            this._setUserIsActive(user, false);
            this._totalActiveSchedules.value = this._totalActiveSchedules.value - u256.One;
        }

        this._transfer(inputToken, user, amount);

        this.emitEvent(new WithdrawEvent(user, inputToken, amount));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── getSchedule() ────────────────────────────────────────────────────────
    // Calldata: address user
    // Returns: inputToken, outputToken, balance, swapAmount, interval, lastExecuted, totalBought, isActive
    private getSchedule(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const writer = new BytesWriter(
            ADDRESS_BYTE_LENGTH * 2 +
            U256_BYTE_LENGTH * 5 +
            BOOLEAN_BYTE_LENGTH
        );
        writer.writeAddress(this._getUserInputToken(user));
        writer.writeAddress(this._getUserOutputToken(user));
        writer.writeU256(this._getUserBalance(user));
        writer.writeU256(this._getUserSwapAmount(user));
        writer.writeU256(this._getUserInterval(user));
        writer.writeU256(this._getUserLastExecuted(user));
        writer.writeU256(this._getUserTotalBought(user));
        writer.writeBoolean(this._getUserIsActive(user));
        return writer;
    }

    // ─── getGlobalStats() ─────────────────────────────────────────────────────
    private getGlobalStats(): BytesWriter {
        const writer = new BytesWriter(U256_BYTE_LENGTH * 3);
        writer.writeU256(this._totalDeposited.value);
        writer.writeU256(this._totalSwapsExecuted.value);
        writer.writeU256(this._totalActiveSchedules.value);
        return writer;
    }

    // ─── canExecute() ─────────────────────────────────────────────────────────
    // Calldata: address user
    // Returns: bool canExec, u256 blocksUntilNextSwap
    private canExecute(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const isActive = this._getUserIsActive(user);
        const lastBlock = this._getUserLastExecuted(user);
        const interval = this._getUserInterval(user);
        const currentBlock = Blockchain.blockNumber;

        let canExec: bool = false;
        let blocksUntil: u256 = u256.Zero;

        if (isActive) {
            const nextExec = lastBlock + interval;
            if (currentBlock >= nextExec) {
                canExec = true;
                blocksUntil = u256.Zero;
            } else {
                blocksUntil = nextExec - currentBlock;
            }
        }

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH + U256_BYTE_LENGTH);
        writer.writeBoolean(canExec);
        writer.writeU256(blocksUntil);
        return writer;
    }

    // ─── Cross-contract helpers ───────────────────────────────────────────────

    private _transferFrom(token: Address, from: Address, to: Address, amount: u256): void {
        const calldata = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        calldata.writeAddress(from);
        calldata.writeAddress(to);
        calldata.writeU256(amount);
        const selector: u32 = encodeSelector('transferFrom()');
        // Encode selector + calldata
        const payload = new BytesWriter(4 + ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        payload.writeU32(selector);
        payload.writeAddress(from);
        payload.writeAddress(to);
        payload.writeU256(amount);
        Blockchain.call(token, payload);
    }

    private _transfer(token: Address, to: Address, amount: u256): void {
        const payload = new BytesWriter(4 + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        payload.writeU32(encodeSelector('transfer()'));
        payload.writeAddress(to);
        payload.writeU256(amount);
        Blockchain.call(token, payload);
    }

    // ─── Per-user storage helpers ────────────────────────────────────────────
    // We derive a unique sub-pointer per user by hashing their address bytes.
    // OP_NET StoredU256 takes (pointer: u16, subPointer: u256).
    // We use the user address cast to u256 as subPointer.

    private _addrToU256(addr: Address): u256 {
        // Address bytes → u256 (first 32 bytes; address is 32 bytes in OP_NET)
        return u256.fromBytes(addr.toBytes(), true);
    }

    private _getUserBalance(user: Address): u256 {
        return new StoredU256(3, this._addrToU256(user)).value;
    }
    private _setUserBalance(user: Address, val: u256): void {
        const s = new StoredU256(3, this._addrToU256(user));
        s.value = val;
    }

    private _getUserInputToken(user: Address): Address {
        return new StoredAddress(1, this._addrToU256(user)).value;
    }
    private _setUserInputToken(user: Address, token: Address): void {
        const s = new StoredAddress(1, this._addrToU256(user));
        s.value = token;
    }

    private _getUserOutputToken(user: Address): Address {
        return new StoredAddress(2, this._addrToU256(user)).value;
    }
    private _setUserOutputToken(user: Address, token: Address): void {
        const s = new StoredAddress(2, this._addrToU256(user));
        s.value = token;
    }

    private _getUserSwapAmount(user: Address): u256 {
        return new StoredU256(4, this._addrToU256(user)).value;
    }
    private _setUserSwapAmount(user: Address, val: u256): void {
        const s = new StoredU256(4, this._addrToU256(user));
        s.value = val;
    }

    private _getUserInterval(user: Address): u256 {
        return new StoredU256(5, this._addrToU256(user)).value;
    }
    private _setUserInterval(user: Address, val: u256): void {
        const s = new StoredU256(5, this._addrToU256(user));
        s.value = val;
    }

    private _getUserLastExecuted(user: Address): u256 {
        return new StoredU256(6, this._addrToU256(user)).value;
    }
    private _setUserLastExecuted(user: Address, val: u256): void {
        const s = new StoredU256(6, this._addrToU256(user));
        s.value = val;
    }

    private _getUserTotalBought(user: Address): u256 {
        return new StoredU256(7, this._addrToU256(user)).value;
    }
    private _setUserTotalBought(user: Address, val: u256): void {
        const s = new StoredU256(7, this._addrToU256(user));
        s.value = val;
    }

    private _getUserIsActive(user: Address): bool {
        return new StoredBoolean(8, this._addrToU256(user)).value;
    }
    private _setUserIsActive(user: Address, val: bool): void {
        const s = new StoredBoolean(8, this._addrToU256(user));
        s.value = val;
    }
}
