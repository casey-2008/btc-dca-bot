import {
    getContract,
    JSONRpcProvider,
    TransactionParameters,
} from 'opnet';
import { Address, Wallet } from '@btc-vision/transaction';
import { Network } from '@btc-vision/bitcoin';
import { ABICoder, BinaryWriter } from '@btc-vision/btc-runtime/runtime';

// ─── Config ───────────────────────────────────────────────────────────────────
const NETWORK: Network    = Network.Testnet;
const RPC_URL             = 'https://testnet.opnet.org';
const CONTRACT_ADDRESS    = 'YOUR_DEPLOYED_CONTRACT_ADDRESS'; // replace after deploy

// ─── ABI ─────────────────────────────────────────────────────────────────────
const DCA_ABI = [
    { name: 'deposit',         inputs: [{ name: 'amount',         type: 'uint256' }] },
    { name: 'setSchedule', inputs: [{ name: 'outputToken', type: 'address' }, { name: 'swapAmount', type: 'uint256' }, { name: 'intervalBlocks', type: 'uint256' }] },
    { name: 'executeSwap',     inputs: [{ name: 'target',         type: 'address' }] },
    { name: 'cancelSchedule',  inputs: [] },
    { name: 'withdraw',        inputs: [{ name: 'amount',         type: 'uint256' }] },
    { name: 'getSchedule',     inputs: [{ name: 'address',        type: 'address' }] },
    { name: 'getStats',        inputs: [] },
];

// ─── Client ───────────────────────────────────────────────────────────────────
export class DCAVaultClient {
    private readonly provider: JSONRpcProvider;
    private readonly wallet: Wallet;
    private readonly contract: any;

    constructor(wallet: Wallet) {
        this.provider = new JSONRpcProvider(RPC_URL, NETWORK);
        this.wallet   = wallet;

        const senderAddress = new Address(wallet.keypair.publicKey);
        this.contract = getContract(CONTRACT_ADDRESS, DCA_ABI, this.provider, NETWORK, senderAddress);
    }

    // ── Deposit source tokens into the vault ──────────────────────────────────
    async deposit(amount: bigint, feeRate: number = 10): Promise<string> {
        const sim = await this.contract.deposit(amount);
        return this.send(sim, feeRate);
    }

    // ── Create a DCA schedule ─────────────────────────────────────────────────
    // @param intervalBlocks  How many blocks between swaps (min 6 ≈ 1 hour)
    // @param amountPerSwap   How much to swap each time (in token base units)
    async createSchedule(
        intervalBlocks: bigint,
        amountPerSwap: bigint,
        feeRate: number = 10,
    ): Promise<string> {
        const sim = await this.contract.createSchedule(intervalBlocks, amountPerSwap);
        return this.send(sim, feeRate);
    }

    // ── Trigger a DCA swap for a target address ───────────────────────────────
    // Permissionless — anyone can call this to execute another address' schedule
    async executeSwap(targetAddress: string, feeRate: number = 10): Promise<string> {
        const sim = await this.contract.executeSwap(targetAddress);
        return this.send(sim, feeRate);
    }

    // ── Pause / cancel an active schedule ────────────────────────────────────
    async cancelSchedule(feeRate: number = 10): Promise<string> {
        const sim = await this.contract.cancelSchedule();
        return this.send(sim, feeRate);
    }

    // ── Withdraw remaining deposit ────────────────────────────────────────────
    async withdraw(amount: bigint, feeRate: number = 10): Promise<string> {
        const sim = await this.contract.withdraw(amount);
        return this.send(sim, feeRate);
    }

    // ── Read schedule details (view, no fee) ─────────────────────────────────
    async getSchedule(address: string): Promise<{
        depositBalance: bigint;
        intervalBlocks: bigint;
        amountPerSwap: bigint;
        lastExecBlock: bigint;
        totalBought: bigint;
        active: boolean;
    }> {
        const result = await this.contract.getSchedule(address);
        const bytes  = result.response as Uint8Array;
        const view   = new DataView(bytes.buffer);

        return {
            depositBalance: readU256(view, 0),
            intervalBlocks: readU256(view, 32),
            amountPerSwap:  readU256(view, 64),
            lastExecBlock:  readU256(view, 96),
            totalBought:    readU256(view, 128),
            active:         view.getUint8(160) === 1,
        };
    }

    // ── Read global vault stats (view, no fee) ────────────────────────────────
    async getStats(): Promise<{ totalDeposited: bigint; totalExecuted: bigint }> {
        const result = await this.contract.getStats();
        const bytes  = result.response as Uint8Array;
        const view   = new DataView(bytes.buffer);

        return {
            totalDeposited: readU256(view, 0),
            totalExecuted:  readU256(view, 32),
        };
    }

    // ── Internal: broadcast a pre-simulated transaction ───────────────────────
    private async send(sim: any, feeRate: number): Promise<string> {
        const params: TransactionParameters = {
            signer:                    this.wallet.keypair,
            refundTo:                  this.wallet.p2tr,
            maximumAllowedSatToSpend:  10_000n,
            feeRate,
            network:                   NETWORK,
        };
        const tx = await sim.sendTransaction(params);
        return tx.txid ?? tx;
    }
}

// ── Helper: read big-endian u256 from DataView ────────────────────────────────
function readU256(view: DataView, offset: number): bigint {
    let value = 0n;
    for (let i = 0; i < 32; i++) {
        value = (value << 8n) | BigInt(view.getUint8(offset + i));
    }
    return value;
}

// ─── Example usage (Node.js) ──────────────────────────────────────────────────
async function main(): Promise<void> {
    // Load wallet from mnemonic or private key
    // const wallet = Wallet.fromPhrase('word1 word2 … word12', NETWORK);

    // const client = new DCAVaultClient(wallet);

    // Deposit 1000 MOTO (18 decimals = 1000n * 10n**18n)
    // const depositTx = await client.deposit(1000n * 10n ** 18n);
    // console.log('Deposit tx:', depositTx);

    // Create schedule: swap 100 MOTO every 144 blocks (~1 day)
    // const scheduleTx = await client.createSchedule(144n, 100n * 10n ** 18n);
    // console.log('Schedule tx:', scheduleTx);

    // Read schedule
    // const schedule = await client.getSchedule(wallet.p2tr);
    // console.log('Schedule:', schedule);

    console.log('DCAVaultClient ready. Uncomment the calls above to interact.');
}

main().catch(console.error);
