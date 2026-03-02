import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    ABIDataTypes,
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
    encodeSelector,
} from '@btc-vision/btc-runtime/runtime';

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

// ─── Storage helpers ──────────────────────────────────────────────────────────

function u256Stor(pointer: u16, user: Address): StoredU256 {
    return new StoredU256(pointer, user.toUint8Array());
}

function addrStor(pointer: u16, user: Address): StoredAddress {
    return new StoredAddress(pointer, user.toUint8Array());
}

function boolStor(pointer: u16, user: Address): StoredBoolean {
    return new StoredBoolean(pointer, user.toUint8Array());
}

function globalU256(pointer: u16): StoredU256 {
    const z = new Uint8Array(32);
    return new StoredU256(pointer, z);
}

// ─── Main Contract ────────────────────────────────────────────────────────────

@final
export class DCAVault extends OP_NET {

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {}

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ─── deposit(address inputToken, u256 amount) ─────────────────────────────
    @method(
        { name: 'inputToken', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public deposit(calldata: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;
        const inputToken: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        assert(u256.gt(amount, u256.Zero), 'Amount must be > 0');

        this._transferFrom(inputToken, user, Blockchain.contractAddress, amount);

        const bal = u256Stor(3, user);
        bal.set(u256.add(bal.value, amount));

        const storedToken = addrStor(1, user);
        if (storedToken.value.isZero()) {
            storedToken.set(inputToken);
        }

        const td = globalU256(200);
        td.set(u256.add(td.value, amount));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── setSchedule(address outputToken, u256 swapAmount, u256 intervalBlocks)
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

        const balance = u256Stor(3, user).value;
        assert(u256.ge(balance, swapAmount), 'Balance < swap amount');

        const isActiveStor = boolStor(8, user);
        const wasActive = isActiveStor.value;

        addrStor(2, user).set(outputToken);
        u256Stor(4, user).set(swapAmount);
        u256Stor(5, user).set(intervalBlocks);
        u256Stor(6, user).set(Blockchain.block.numberU256);
        isActiveStor.set(true);

        if (!wasActive) {
            const tas = globalU256(202);
            tas.set(u256.add(tas.value, u256.One));
        }

        const inputToken = addrStor(1, user).value;
        this.emitEvent(new ScheduleActivatedEvent(user, inputToken, outputToken, balance, swapAmount, intervalBlocks));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── executeSwap(address targetUser) ─────────────────────────────────────
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

        const isActiveStor = boolStor(8, targetUser);
        assert(isActiveStor.value, 'Schedule not active');

        const lastBlock = u256Stor(6, targetUser).value;
        const interval = u256Stor(5, targetUser).value;
        const currentBlock = Blockchain.block.numberU256;

        assert(u256.ge(currentBlock, u256.add(lastBlock, interval)), 'Interval not elapsed');

        const balStor = u256Stor(3, targetUser);
        const balance = balStor.value;
        const swapAmount = u256Stor(4, targetUser).value;

        assert(u256.ge(balance, swapAmount), 'Insufficient balance');

        const keeperFee = u256.div(u256.mul(swapAmount, u256.fromU64(KEEPER_FEE_BPS)), u256.fromU64(10000));
        const netSwapAmount = u256.sub(swapAmount, keeperFee);

        const newBalance = u256.sub(balance, swapAmount);
        balStor.set(newBalance);

        if (u256.lt(newBalance, swapAmount)) {
            isActiveStor.set(false);
            const tas = globalU256(202);
            const total = tas.value;
            if (u256.gt(total, u256.Zero)) {
                tas.set(u256.sub(total, u256.One));
            }
        }

        u256Stor(6, targetUser).set(currentBlock);

        const tse = globalU256(201);
        tse.set(u256.add(tse.value, u256.One));

        const boughtStor = u256Stor(7, targetUser);
        boughtStor.set(u256.add(boughtStor.value, netSwapAmount));

        if (u256.gt(keeperFee, u256.Zero)) {
            const inputToken = addrStor(1, targetUser).value;
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

        const isActiveStor = boolStor(8, user);
        if (isActiveStor.value) {
            isActiveStor.set(false);
            const tas = globalU256(202);
            const total = tas.value;
            if (u256.gt(total, u256.Zero)) {
                tas.set(u256.sub(total, u256.One));
            }
        }

        const balStor = u256Stor(3, user);
        const refund = balStor.value;
        if (u256.gt(refund, u256.Zero)) {
            const inputToken = addrStor(1, user).value;
            balStor.set(u256.Zero);
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

        const balStor = u256Stor(3, user);
        const balance = balStor.value;
        assert(u256.ge(balance, amount), 'Insufficient balance');

        const remaining = u256.sub(balance, amount);
        const swapAmount = u256Stor(4, user).value;
        balStor.set(remaining);

        const isActiveStor = boolStor(8, user);
        if (u256.lt(remaining, swapAmount) && isActiveStor.value) {
            isActiveStor.set(false);
            const tas = globalU256(202);
            const total = tas.value;
            if (u256.gt(total, u256.Zero)) {
                tas.set(u256.sub(total, u256.One));
            }
        }

        const inputToken = addrStor(1, user).value;
        this._transfer(inputToken, user, amount);

        this.emitEvent(new WithdrawEvent(user, inputToken, amount));

        const writer = new BytesWriter(BOOLEAN_BYTE_LENGTH);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── getSchedule(address user) ────────────────────────────────────────────
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

        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH * 5 + BOOLEAN_BYTE_LENGTH);
        writer.writeAddress(addrStor(1, user).value);
        writer.writeAddress(addrStor(2, user).value);
        writer.writeU256(u256Stor(3, user).value);
        writer.writeU256(u256Stor(4, user).value);
        writer.writeU256(u256Stor(5, user).value);
        writer.writeU256(u256Stor(6, user).value);
        writer.writeU256(u256Stor(7, user).value);
        writer.writeBoolean(boolStor(8, user).value);
        return writer;
    }

    // ─── getGlobalStats() ────────────────────────────────────────────────────
    @method()
    @returns(
        { name: 'totalDeposited', type: ABIDataTypes.UINT256 },
        { name: 'totalSwapsExecuted', type: ABIDataTypes.UINT256 },
        { name: 'totalActiveSchedules', type: ABIDataTypes.UINT256 },
    )
    public getGlobalStats(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(U256_BYTE_LENGTH * 3);
        writer.writeU256(globalU256(200).value);
        writer.writeU256(globalU256(201).value);
        writer.writeU256(globalU256(202).value);
        return writer;
    }

    // ─── canExecute(address user) ─────────────────────────────────────────────
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns(
        { name: 'canExec', type: ABIDataTypes.BOOL },
        { name: 'blocksUntil', type: ABIDataTypes.UINT256 },
    )
    public canExecute(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const isActive = boolStor(8, user).value;
        const lastBlock = u256Stor(6, user).value;
        const interval = u256Stor(5, user).value;
        const currentBlock = Blockchain.block.numberU256;

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
        const data = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        data.writeAddress(from);
        data.writeAddress(to);
        data.writeU256(amount);
        Blockchain.call(token, encodeSelector('transferFrom(address,address,uint256)'), data);
    }

    private _transfer(token: Address, to: Address, amount: u256): void {
        const data = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(to);
        data.writeU256(amount);
        Blockchain.call(token, encodeSelector('transfer(address,uint256)'), data);
    }
}
