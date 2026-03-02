import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    StoredU256,
    StoredBoolean,
    StoredAddress,
    NetEvent,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
    BOOLEAN_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';

// ─── Keeper fee: 0.1% ────────────────────────────────────────────────────────
const KEEPER_FEE_BPS: u64 = 10;

// ─── Events ──────────────────────────────────────────────────────────────────

@final
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

@final
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

@final
class ScheduleCancelledEvent extends NetEvent {
    constructor(user: Address, refundAmount: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        writer.writeAddress(user);
        writer.writeU256(refundAmount);
        super('ScheduleCancelled', writer);
    }
}

@final
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
export class DCAVault extends OP_NET {

    private readonly _totalDeposited: StoredU256;
    private readonly _totalSwapsExecuted: StoredU256;
    private readonly _totalActiveSchedules: StoredU256;

    public constructor() {
        super();
        this._totalDeposited = new StoredU256(9, u256.Zero);
        this._totalSwapsExecuted = new StoredU256(10, u256.Zero);
        this._totalActiveSchedules = new StoredU256(11, u256.Zero);
    }

    public override onDeployment(_calldata: Calldata): void {
        // Nothing to initialize
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ─── deposit(address inputToken, u256 amount) ─────────────────────────────
    @method(
        { name: 'inputToken', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('ScheduleActivated')
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public deposit(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const inputToken: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        assert(u256.gt(amount, u256.Zero), 'Amount must be > 0');

        this._transferFrom(inputToken, user, Blockchain.contractAddress, amount);

        const currentBalance = this._getUserBalance(user);
        this._setUserBalance(user, u256.add(currentBalance, amount));

        const stored = this._getUserInputToken(user);
        if (stored.isZero()) {
            this._setUserInputToken(user, inputToken);
        }

        this._totalDeposited.value = u256.add(this._totalDeposited.value, amount);

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── setSchedule(address outputToken, u256 swapAmount, u256 intervalBlocks) ─
    @method(
        { name: 'outputToken', type: ABIDataTypes.ADDRESS },
        { name: 'swapAmount', type: ABIDataTypes.UINT256 },
        { name: 'intervalBlocks', type: ABIDataTypes.UINT256 },
    )
    @emit('ScheduleActivated')
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setSchedule(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const outputToken: Address = calldata.readAddress();
        const swapAmount: u256 = calldata.readU256();
        const intervalBlocks: u256 = calldata.readU256();

        assert(u256.gt(swapAmount, u256.Zero), 'Swap amount must be > 0');
        assert(u256.ge(intervalBlocks, u256.fromU64(6)), 'Interval must be >= 6 blocks');

        const balance = this._getUserBalance(user);
        assert(u256.ge(balance, swapAmount), 'Balance < swap amount');

        const wasActive = this._getUserIsActive(user);

        this._setUserOutputToken(user, outputToken);
        this._setUserSwapAmount(user, swapAmount);
        this._setUserInterval(user, intervalBlocks);
        this._setUserLastExecuted(user, Blockchain.blockNumber);
        this._setUserIsActive(user, true);

        if (!wasActive) {
            this._totalActiveSchedules.value = u256.add(this._totalActiveSchedules.value, u256.One);
        }

        this.emitEvent(new ScheduleActivatedEvent(
            user,
            this._getUserInputToken(user),
            outputToken,
            balance,
            swapAmount,
            intervalBlocks,
        ));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── executeSwap(address user) ────────────────────────────────────────────
    @method(
        { name: 'targetUser', type: ABIDataTypes.ADDRESS },
    )
    @emit('SwapExecuted')
    @returns(
        { name: 'amountIn', type: ABIDataTypes.UINT256 },
        { name: 'amountOut', type: ABIDataTypes.UINT256 },
    )
    public executeSwap(calldata: Calldata): BytesWriter {
        const targetUser: Address = calldata.readAddress();
        const executor: Address = Blockchain.tx.sender;

        assert(this._getUserIsActive(targetUser), 'Schedule not active');

        const lastBlock = this._getUserLastExecuted(targetUser);
        const interval = this._getUserInterval(targetUser);
        const currentBlock = Blockchain.blockNumber;

        assert(u256.ge(currentBlock, u256.add(lastBlock, interval)), 'Interval not elapsed');

        const balance = this._getUserBalance(targetUser);
        const swapAmount = this._getUserSwapAmount(targetUser);

        assert(u256.ge(balance, swapAmount), 'Insufficient balance');

        const keeperFee: u256 = u256.div(
            u256.mul(swapAmount, u256.fromU64(KEEPER_FEE_BPS)),
            u256.fromU64(10000),
        );
        const netSwapAmount: u256 = u256.sub(swapAmount, keeperFee);

        const newBalance = u256.sub(balance, swapAmount);
        this._setUserBalance(targetUser, newBalance);

        if (u256.lt(newBalance, swapAmount)) {
            this._setUserIsActive(targetUser, false);
            if (u256.gt(this._totalActiveSchedules.value, u256.Zero)) {
                this._totalActiveSchedules.value = u256.sub(this._totalActiveSchedules.value, u256.One);
            }
        }

        this._setUserLastExecuted(targetUser, currentBlock);
        this._totalSwapsExecuted.value = u256.add(this._totalSwapsExecuted.value, u256.One);

        const prevBought = this._getUserTotalBought(targetUser);
        this._setUserTotalBought(targetUser, u256.add(prevBought, netSwapAmount));

        if (u256.gt(keeperFee, u256.Zero)) {
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
    @method()
    @emit('ScheduleCancelled')
    @returns({ name: 'refund', type: ABIDataTypes.UINT256 })
    public cancelSchedule(_calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;

        const wasActive = this._getUserIsActive(user);
        if (wasActive) {
            this._setUserIsActive(user, false);
            if (u256.gt(this._totalActiveSchedules.value, u256.Zero)) {
                this._totalActiveSchedules.value = u256.sub(this._totalActiveSchedules.value, u256.One);
            }
        }

        const refund = this._getUserBalance(user);
        if (u256.gt(refund, u256.Zero)) {
            const inputToken = this._getUserInputToken(user);
            this._setUserBalance(user, u256.Zero);
            this._transfer(inputToken, user, refund);
        }

        this.emitEvent(new ScheduleCancelledEvent(user, refund));

        const writer = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(refund);
        return writer;
    }

    // ─── withdraw(u256 amount) ────────────────────────────────────────────────
    @method(
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('Withdraw')
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public withdraw(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const amount: u256 = calldata.readU256();

        const balance = this._getUserBalance(user);
        assert(u256.ge(balance, amount), 'Insufficient balance');

        const remaining = u256.sub(balance, amount);
        const swapAmount = this._getUserSwapAmount(user);

        this._setUserBalance(user, remaining);

        if (u256.lt(remaining, swapAmount) && this._getUserIsActive(user)) {
            this._setUserIsActive(user, false);
            if (u256.gt(this._totalActiveSchedules.value, u256.Zero)) {
                this._totalActiveSchedules.value = u256.sub(this._totalActiveSchedules.value, u256.One);
            }
        }

        const inputToken = this._getUserInputToken(user);
        this._transfer(inputToken, user, amount);

        this.emitEvent(new WithdrawEvent(user, inputToken, amount));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── getSchedule(address user) — view ────────────────────────────────────
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns(
        { name: 'inputToken', type: ABIDataTypes.ADDRESS },
        { name: 'outputToken', type: ABIDataTypes.ADDRESS },
        { name: 'balance', type: ABIDataTypes.UINT256 },
        { name: 'swapAmount', type: ABIDataTypes.UINT256 },
        { name: 'intervalBlocks', type: ABIDataTypes.UINT256 },
        { name: 'lastExecuted', type: ABIDataTypes.UINT256 },
        { name: 'totalBought', type: ABIDataTypes.UINT256 },
        { name: 'isActive', type: ABIDataTypes.BOOL },
    )
    public getSchedule(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const writer = new BytesWriter(
            ADDRESS_BYTE_LENGTH * 2 +
            U256_BYTE_LENGTH * 5 +
            BOOLEAN_BYTE_LENGTH,
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

    // ─── getGlobalStats() — view ──────────────────────────────────────────────
    @method()
    @returns(
        { name: 'totalDeposited', type: ABIDataTypes.UINT256 },
        { name: 'totalSwapsExecuted', type: ABIDataTypes.UINT256 },
        { name: 'totalActiveSchedules', type: ABIDataTypes.UINT256 },
    )
    public getGlobalStats(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(U256_BYTE_LENGTH * 3);
        writer.writeU256(this._totalDeposited.value);
        writer.writeU256(this._totalSwapsExecuted.value);
        writer.writeU256(this._totalActiveSchedules.value);
        return writer;
    }

    // ─── canExecute(address user) — view ─────────────────────────────────────
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns(
        { name: 'canExec', type: ABIDataTypes.BOOL },
        { name: 'blocksUntil', type: ABIDataTypes.UINT256 },
    )
    public canExecute(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const isActive = this._getUserIsActive(user);
        const lastBlock = this._getUserLastExecuted(user);
        const interval = this._getUserInterval(user);
        const currentBlock = Blockchain.blockNumber;

        let canExec: bool = false;
        let blocksUntil: u256 = u256.Zero;

        if (isActive) {
            const nextExec = u256.add(lastBlock, interval);
            if (u256.ge(currentBlock, nextExec)) {
                canExec = true;
            } else {
                blocksUntil = u256.sub(nextExec, currentBlock);
            }
        }

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH + U256_BYTE_LENGTH);
        writer.writeBoolean(canExec);
        writer.writeU256(blocksUntil);
        return writer;
    }

    // ─── Cross-contract helpers ───────────────────────────────────────────────

    private _transferFrom(token: Address, from: Address, to: Address, amount: u256): void {
        const payload = new BytesWriter(4 + ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        payload.writeSelector('transferFrom(address,address,uint256)');
        payload.writeAddress(from);
        payload.writeAddress(to);
        payload.writeU256(amount);
        Blockchain.call(token, payload);
    }

    private _transfer(token: Address, to: Address, amount: u256): void {
        const payload = new BytesWriter(4 + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        payload.writeSelector('transfer(address,uint256)');
        payload.writeAddress(to);
        payload.writeU256(amount);
        Blockchain.call(token, payload);
    }

    // ─── Per-user storage helpers ─────────────────────────────────────────────

    private _addrKey(user: Address): u256 {
        return u256.fromBytes(user.toBytes(), true);
    }

    private _getUserBalance(user: Address): u256 {
        return new StoredU256(3, this._addrKey(user)).value;
    }
    private _setUserBalance(user: Address, val: u256): void {
        new StoredU256(3, this._addrKey(user)).value = val;
    }

    private _getUserInputToken(user: Address): Address {
        return new StoredAddress(1, this._addrKey(user)).value;
    }
    private _setUserInputToken(user: Address, token: Address): void {
        new StoredAddress(1, this._addrKey(user)).value = token;
    }

    private _getUserOutputToken(user: Address): Address {
        return new StoredAddress(2, this._addrKey(user)).value;
    }
    private _setUserOutputToken(user: Address, token: Address): void {
        new StoredAddress(2, this._addrKey(user)).value = token;
    }

    private _getUserSwapAmount(user: Address): u256 {
        return new StoredU256(4, this._addrKey(user)).value;
    }
    private _setUserSwapAmount(user: Address, val: u256): void {
        new StoredU256(4, this._addrKey(user)).value = val;
    }

    private _getUserInterval(user: Address): u256 {
        return new StoredU256(5, this._addrKey(user)).value;
    }
    private _setUserInterval(user: Address, val: u256): void {
        new StoredU256(5, this._addrKey(user)).value = val;
    }

    private _getUserLastExecuted(user: Address): u256 {
        return new StoredU256(6, this._addrKey(user)).value;
    }
    private _setUserLastExecuted(user: Address, val: u256): void {
        new StoredU256(6, this._addrKey(user)).value = val;
    }

    private _getUserTotalBought(user: Address): u256 {
        return new StoredU256(7, this._addrKey(user)).value;
    }
    private _setUserTotalBought(user: Address, val: u256): void {
        new StoredU256(7, this._addrKey(user)).value = val;
    }

    private _getUserIsActive(user: Address): bool {
        return new StoredBoolean(8, this._addrKey(user)).value;
    }
    private _setUserIsActive(user: Address, val: bool): void {
        new StoredBoolean(8, this._addrKey(user)).value = val;
    }
}
