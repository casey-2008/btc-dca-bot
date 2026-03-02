import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    OP_NET,
    Revert,
    Selector,
    StoredU256,
    StoredBoolean,
    AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─── Storage Pointer Constants ─────────────────────────────────────────────────
const POINTER_TOTAL_DEPOSITED: u16 = 1;
const POINTER_TOTAL_EXECUTED: u16   = 2;
const POINTER_PAUSED: u16           = 3;

const POINTER_DEPOSIT_BALANCE: u16  = 10;
const POINTER_INTERVAL_BLOCKS: u16  = 11;
const POINTER_AMOUNT_PER_SWAP: u16  = 12;
const POINTER_LAST_EXEC_BLOCK: u16  = 13;
const POINTER_TOTAL_BOUGHT: u16     = 14;
const POINTER_ACTIVE: u16           = 15;

// ─── DCA Vault Contract ────────────────────────────────────────────────────────
// Users deposit OP-20 tokens and define a block-interval DCA schedule.
// Anyone (keeper / user) calls executeSwap() to trigger a swap via Motoswap
// once the interval has elapsed.
// ──────────────────────────────────────────────────────────────────────────────

@final
export class DCAVault extends OP_NET {

    // ── Global state ──────────────────────────────────────────────────────────

    private readonly totalDeposited: StoredU256 = new StoredU256(
        POINTER_TOTAL_DEPOSITED,
        u256.Zero,
    );
    private readonly totalExecuted: StoredU256 = new StoredU256(
        POINTER_TOTAL_EXECUTED,
        u256.Zero,
    );
    private readonly paused: StoredBoolean = new StoredBoolean(
        POINTER_PAUSED,
        false,
    );

    // ── Per-user maps ─────────────────────────────────────────────────────────

    private readonly depositBalance: AddressMemoryMap<Address, StoredU256>;
    private readonly intervalBlocks: AddressMemoryMap<Address, StoredU256>;
    private readonly amountPerSwap: AddressMemoryMap<Address, StoredU256>;
    private readonly lastExecBlock: AddressMemoryMap<Address, StoredU256>;
    private readonly totalBought: AddressMemoryMap<Address, StoredU256>;
    private readonly active: AddressMemoryMap<Address, StoredBoolean>;

    public constructor() {
        super();

        this.depositBalance = new AddressMemoryMap<Address, StoredU256>(
            POINTER_DEPOSIT_BALANCE,
            u256.Zero,
        );
        this.intervalBlocks = new AddressMemoryMap<Address, StoredU256>(
            POINTER_INTERVAL_BLOCKS,
            u256.Zero,
        );
        this.amountPerSwap = new AddressMemoryMap<Address, StoredU256>(
            POINTER_AMOUNT_PER_SWAP,
            u256.Zero,
        );
        this.lastExecBlock = new AddressMemoryMap<Address, StoredU256>(
            POINTER_LAST_EXEC_BLOCK,
            u256.Zero,
        );
        this.totalBought = new AddressMemoryMap<Address, StoredU256>(
            POINTER_TOTAL_BOUGHT,
            u256.Zero,
        );
        this.active = new AddressMemoryMap<Address, StoredBoolean>(
            POINTER_ACTIVE,
            false,
        );
    }

    // ── Selector router ───────────────────────────────────────────────────────

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case encodeSelector('deposit()'):
                return this.deposit(calldata);
            case encodeSelector('createSchedule()'):
                return this.createSchedule(calldata);
            case encodeSelector('executeSwap()'):
                return this.executeSwap(calldata);
            case encodeSelector('cancelSchedule()'):
                return this.cancelSchedule(calldata);
            case encodeSelector('withdraw()'):
                return this.withdraw(calldata);
            case encodeSelector('getSchedule()'):
                return this.getSchedule(calldata);
            case encodeSelector('getStats()'):
                return this.getStats(calldata);
            default:
                throw new Revert('Unknown method');
        }
    }

    // ── deposit(amount: u256) ─────────────────────────────────────────────────

    private deposit(calldata: Calldata): BytesWriter {
        this.requireNotPaused();

        const amount = calldata.readU256();
        const caller = Blockchain.tx.sender;

        // Production: call OP-20 transferFrom(caller, Blockchain.contractAddress, amount)
        const current    = this.depositBalance.get(caller);
        const newBalance = current.add(amount);
        this.depositBalance.set(caller, newBalance);

        this.totalDeposited.set(this.totalDeposited.get().add(amount));

        const writer = new BytesWriter(32);
        writer.writeU256(newBalance);
        return writer;
    }

    // ── createSchedule(interval: u256, amountPerSwap: u256) ──────────────────

    private createSchedule(calldata: Calldata): BytesWriter {
        this.requireNotPaused();

        const interval = calldata.readU256();
        const swapAmt  = calldata.readU256();
        const caller   = Blockchain.tx.sender;

        // Minimum 6 blocks (~1 hour on Bitcoin)
        if (interval < u256.fromU32(6)) {
            throw new Revert('Interval must be >= 6 blocks');
        }

        const balance = this.depositBalance.get(caller);
        if (balance < swapAmt) {
            throw new Revert('Deposit balance < amountPerSwap');
        }

        this.intervalBlocks.set(caller, interval);
        this.amountPerSwap.set(caller, swapAmt);
        this.lastExecBlock.set(caller, Blockchain.blockNumber);
        this.active.set(caller, true);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── executeSwap(target: Address) ──────────────────────────────────────────
    // Permissionless: anyone can call once the interval has elapsed.

    private executeSwap(calldata: Calldata): BytesWriter {
        this.requireNotPaused();

        const target = calldata.readAddress();

        if (!this.active.get(target)) {
            throw new Revert('No active schedule for target');
        }

        const interval  = this.intervalBlocks.get(target);
        const lastBlock = this.lastExecBlock.get(target);
        const current   = Blockchain.blockNumber;
        const nextBlock = lastBlock.add(interval);

        if (current < nextBlock) {
            throw new Revert('Interval not reached yet');
        }

        const swapAmt = this.amountPerSwap.get(target);
        const balance = this.depositBalance.get(target);

        if (balance < swapAmt) {
            this.active.set(target, false);
            throw new Revert('Insufficient balance: schedule deactivated');
        }

        // Deduct from vault balance
        this.depositBalance.set(target, balance.sub(swapAmt));

        // Record execution block
        this.lastExecBlock.set(target, current);

        // Track total bought
        const newBought = this.totalBought.get(target).add(swapAmt);
        this.totalBought.set(target, newBought);

        // Update global counter
        this.totalExecuted.set(this.totalExecuted.get().add(swapAmt));

        // TODO production:
        // const router = new MotoswapRouter(MOTOSWAP_ROUTER_ADDRESS);
        // const received = router.swapExactTokensForTokens(swapAmt, 0, path, target);

        const writer = new BytesWriter(64);
        writer.writeU256(swapAmt);                            // spent
        writer.writeU256(this.depositBalance.get(target));    // remaining balance
        return writer;
    }

    // ── cancelSchedule() ──────────────────────────────────────────────────────

    private cancelSchedule(_calldata: Calldata): BytesWriter {
        this.active.set(Blockchain.tx.sender, false);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── withdraw(amount: u256) ────────────────────────────────────────────────

    private withdraw(calldata: Calldata): BytesWriter {
        const amount = calldata.readU256();
        const caller = Blockchain.tx.sender;

        const balance = this.depositBalance.get(caller);
        if (balance < amount) {
            throw new Revert('Insufficient balance');
        }

        const newBalance = balance.sub(amount);
        this.depositBalance.set(caller, newBalance);
        // Production: call OP-20 transfer(caller, amount)

        const writer = new BytesWriter(32);
        writer.writeU256(newBalance);
        return writer;
    }

    // ── getSchedule(address: Address) — view ──────────────────────────────────

    private getSchedule(calldata: Calldata): BytesWriter {
        const addr = calldata.readAddress();

        const writer = new BytesWriter(161); // 5×32 bytes + 1 bool
        writer.writeU256(this.depositBalance.get(addr));
        writer.writeU256(this.intervalBlocks.get(addr));
        writer.writeU256(this.amountPerSwap.get(addr));
        writer.writeU256(this.lastExecBlock.get(addr));
        writer.writeU256(this.totalBought.get(addr));
        writer.writeBoolean(this.active.get(addr));
        return writer;
    }

    // ── getStats() — view ─────────────────────────────────────────────────────

    private getStats(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(64);
        writer.writeU256(this.totalDeposited.get());
        writer.writeU256(this.totalExecuted.get());
        return writer;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private requireNotPaused(): void {
        if (this.paused.get()) {
            throw new Revert('Contract is paused');
        }
    }
}
