/**
 * Micropayment Batching Engine
 *
 * Gas-free batched settlement for sub-cent agent payments.
 * Pools payments, settles in single transaction, amortizes gas across thousands of micro-transactions.
 *
 * Features:
 * - Gas-free transfers down to $0.000001 per payment after batching
 * - Instant verification via EIP-3009 signed messages
 * - Crosschain compatibility - single balance across supported chains
 * - Settlement optimization - batch when >100 payments or >$1 total
 *
 * References:
 * - Circle Nanopayments (169M+ processed)
 * - AWS AgentCore Payments
 * - Google Cloud Pay.sh
 */

import { webcrypto } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  MicropaymentQueueItem,
  BatchedSettlement,
  SettlementOptions,
  BatchStatistics
} from './types.js';

/**
 * Micropayment Engine - Batching system for agent payments
 *
 * Gas optimization:
 * - Individual payment: ~0.0003 USDC gas ($0.001 at current rates)
 * - Batched payment: ~0.000001 USDC gas per payment after 100+ items
 * - Settlement trigger: >100 payments OR >$1 total (configurable)
 */
export class MicropaymentEngine {
  private walletPrivateKey: `0x${string}`;
  private queue: Map<string, MicropaymentQueueItem[]> = new Map();
  private batchWindowMs: number;
  private settlementThresholds: {
    minPaymentCount: number;
    minTotalUsd: number;
  };

  constructor(config: {
    walletPrivateKey: string;
    batchWindowMs?: number;
    minPaymentCount?: number;
    minTotalUsd?: number;
  }) {
    if (typeof config.walletPrivateKey !== 'string' || config.walletPrivateKey.length === 0) {
      throw new Error('MicropaymentEngine: walletPrivateKey is required and must be a non-empty string');
    }
    if (!config.walletPrivateKey.startsWith('0x')) {
      throw new Error('MicropaymentEngine: walletPrivateKey must start with 0x');
    }

    this.walletPrivateKey = config.walletPrivateKey as `0x${string}`;
    this.batchWindowMs = config.batchWindowMs ?? 60_000;
    this.settlementThresholds = {
      minPaymentCount: config.minPaymentCount ?? 100,
      minTotalUsd: config.minTotalUsd ?? 1.0,
    };
  }

  async queuePayment(
    recipient: Address,
    amountUsd: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const paymentId = `mp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const item: MicropaymentQueueItem = {
      paymentId,
      recipient,
      amountUsd,
      amountBaseUnits: this.usdToBaseUnits(amountUsd),
      queuedAt: Date.now(),
      status: 'queued',
      metadata,
    };

    const windowKey = this.getBatchWindowKey();
    if (!this.queue.has(windowKey)) {
      this.queue.set(windowKey, []);
    }
    this.queue.get(windowKey)!.push(item);

    await this.checkAutoSettle(windowKey);
    return paymentId;
  }

  async batchPayments(paymentIds: string[], options?: SettlementOptions): Promise<BatchedSettlement> {
    // Index every known item by id, then resolve each requested id exactly once.
    // Previously this silently dropped unknown ids and happily batched
    // already-pending/settled items (CodeRabbit #8). We now include ONLY queued
    // items and fail loudly listing what could not be batched.
    const byId = new Map<string, MicropaymentQueueItem>();
    for (const items of this.queue.values()) {
      for (const item of items) {
        byId.set(item.paymentId, item);
      }
    }

    const payments: MicropaymentQueueItem[] = [];
    const missingIds: string[] = [];
    const nonQueued: string[] = [];
    for (const pid of paymentIds) {
      const item = byId.get(pid);
      if (item === undefined) {
        missingIds.push(pid);
      } else if (item.status !== 'queued') {
        nonQueued.push(`${pid} (status=${item.status})`);
      } else {
        payments.push(item);
      }
    }

    if (missingIds.length > 0 || nonQueued.length > 0) {
      const problems: string[] = [];
      if (missingIds.length > 0) {
        problems.push(`missing: ${missingIds.join(', ')}`);
      }
      if (nonQueued.length > 0) {
        problems.push(`not queued: ${nonQueued.join(', ')}`);
      }
      throw new Error(`Cannot batch payments - ${problems.join('; ')}`);
    }

    if (payments.length === 0) {
      throw new Error('No payments found with given IDs');
    }

    const totalUsd = payments.reduce((sum, p) => sum + parseFloat(p.amountUsd), 0);
    const totalBaseUnits = payments.reduce(
      (sum, p) => sum + BigInt(p.amountBaseUnits),
      BigInt(0)
    );

    const signedSettlement = await this.signBatchSettlement(payments);
    for (const payment of payments) {
      payment.status = 'pending';
    }

    const recipientSet = new Set(payments.map(p => p.recipient));
    const gasEstimateUsd = options?.skipGasEstimate
      ? 0
      // Price gas from THIS batch's recipients, not the whole queue (CodeRabbit #9).
      : this.estimateGasCost(payments.length, recipientSet.size);
    const gasPerPaymentUsd = gasEstimateUsd / payments.length;

    return {
      batchId: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      paymentIds: payments.map(p => p.paymentId),
      recipientCount: recipientSet.size,
      totalAmountUsd: totalUsd.toFixed(6),
      totalAmountBaseUnits: totalBaseUnits.toString(),
      averageAmountUsd: (totalUsd / payments.length).toFixed(6),
      gasEstimateUsd: gasEstimateUsd.toFixed(6),
      gasPerPaymentUsd: gasPerPaymentUsd.toFixed(6),
      signedSettlement,
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };
  }

  getGasEstimate(paymentCount: number): string {
    return this.estimateGasCost(paymentCount).toFixed(6);
  }

  setBatchWindow(seconds: number): void {
    this.batchWindowMs = seconds * 1000;
  }

  getQueueStatistics(): BatchStatistics {
    let totalPayments = 0;
    let totalUsd = 0;
    let pendingCount = 0;
    let queuedCount = 0;
    const paymentsByRecipient = new Map<string, number>();

    for (const items of this.queue.values()) {
      for (const item of items) {
        totalPayments++;
        totalUsd += parseFloat(item.amountUsd);

        if (item.status === 'queued') {
          queuedCount++;
        } else if (item.status === 'pending') {
          pendingCount++;
        }

        const count = paymentsByRecipient.get(item.recipient) ?? 0;
        paymentsByRecipient.set(item.recipient, count + 1);
      }
    }

    return {
      totalPayments,
      totalUsd,
      pendingCount,
      queuedCount,
      uniqueRecipients: paymentsByRecipient.size,
      paymentsByRecipient: Object.fromEntries(paymentsByRecipient),
      activeWindows: this.queue.size,
      averageUsdPerPayment: totalPayments > 0 ? totalUsd / totalPayments : 0,
      shouldSettle:
        totalPayments >= this.settlementThresholds.minPaymentCount ||
        totalUsd >= this.settlementThresholds.minTotalUsd,
    };
  }

  clearOldPayments(minutesOld: number): number {
    const cutoff = Date.now() - minutesOld * 60 * 1000;
    let cleared = 0;

    for (const [key, items] of this.queue.entries()) {
      const filtered = items.filter(item => {
        if (item.queuedAt < cutoff && item.status === 'settled') {
          cleared++;
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        this.queue.delete(key);
      } else {
        this.queue.set(key, filtered);
      }
    }

    return cleared;
  }

  getPaymentStatus(paymentId: string): MicropaymentQueueItem | undefined {
    for (const items of this.queue.values()) {
      const found = items.find(p => p.paymentId === paymentId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private async signBatchSettlement(
    payments: MicropaymentQueueItem[]
  ): Promise<{
    signature: Hex;
    from: Address;
    nonce: Hex;
    expiresAt: string;
    payments: Array<{
      recipient: `0x${string}`;
      amount: string;
      paymentId: string;
    }>;
  }> {
    const account = privateKeyToAccount(this.walletPrivateKey);
    const domain = {
      name: 'PayBot',
      version: '1',
      chainId: 8453,
      verifyingContract: '0x50b0f7224fFC5F4F7685DbcE1B8b7e7B8b8A4A23' as Address,
    };

    const nonce = this.generateNonce() as `0x${string}`;
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSeconds + BigInt(300);

    const paymentsData = payments.map(p => ({
      recipient: p.recipient as `0x${string}`,
      amount: p.amountBaseUnits,
      paymentId: p.paymentId,
    }));

    const totalAmount = payments.reduce(
      (sum, p) => sum + BigInt(p.amountBaseUnits),
      BigInt(0)
    );

    const types = {
      BatchSettlement: [
        { name: 'from', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'totalAmount', type: 'uint256' },
        { name: 'paymentCount', type: 'uint256' },
        { name: 'payments', type: 'Payment[]' },
      ],
      Payment: [
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'paymentId', type: 'string' },
      ],
    };

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: 'BatchSettlement',
      message: {
        from: account.address,
        nonce,
        expiresAt,
        totalAmount,
        paymentCount: BigInt(payments.length),
        payments: paymentsData,
      },
    });

    return {
      signature,
      from: account.address,
      nonce,
      expiresAt: expiresAt.toString(),
      payments: paymentsData,
    };
  }

  /**
   * Estimate the per-payment gas cost (USD), amortized across unique recipients.
   *
   * @param paymentCount - Number of payments to amortize the cost across.
   * @param uniqueRecipients - Distinct recipients to price gas for. When
   *   omitted (the public {@link getGasEstimate} path), falls back to the
   *   whole-queue recipient count. {@link batchPayments} passes the batch's own
   *   recipient count so a batch is never charged for unrelated queued
   *   recipients (CodeRabbit #9).
   * @returns The per-payment gas cost in USD.
   */
  private estimateGasCost(paymentCount: number, uniqueRecipients?: number): number {
    const baseGas = BigInt(21_000);
    const gasPerRecipient = BigInt(5_000);
    const recipients = uniqueRecipients ?? this.getQueueStatistics().uniqueRecipients;
    const totalGas = baseGas + BigInt(recipients) * gasPerRecipient;

    const gweiPrice = BigInt(5);
    const weiPerGwei = BigInt(1_000_000_000);
    const gasPriceWei = gweiPrice * weiPerGwei;
    const gasCostWei = totalGas * gasPriceWei;

    const ethPriceUsd = 3000;
    const weiPerEth = BigInt(1000000000000000000n);

    const gasCostEth = Number(gasCostWei) / Number(weiPerEth);
    const gasCostUsd = gasCostEth * ethPriceUsd;

    return gasCostUsd / paymentCount;
  }

  /**
   * Auto-settle `windowKey` when ITS OWN queued items cross a threshold.
   *
   * The decision is scoped to the target window's own queued items, NOT the
   * engine-wide aggregate (CodeRabbit #10). Previously `shouldSettle` came from
   * {@link getQueueStatistics} (all windows + pending items), so once
   * historical/pending items pushed the engine-wide total over a threshold,
   * queueing a single payment into a fresh window would settle only that new
   * sub-threshold window while the genuinely-full window sat unsettled.
   *
   * @param windowKey - The window to evaluate and (if eligible) settle.
   */
  private async checkAutoSettle(windowKey: string): Promise<void> {
    if (this.windowShouldSettle(windowKey)) {
      const paymentIds = this.getPaymentIdsForWindow(windowKey);
      if (paymentIds.length > 0) {
        await this.batchPayments(paymentIds);
      }
    }
  }

  /**
   * Whether a window's OWN queued items meet a settlement threshold.
   *
   * Mirrors the engine-wide `shouldSettle` rule (count OR total USD) but over
   * only this window's `queued` items, so a window settles on its own contents
   * independent of other windows or pending items (CodeRabbit #10).
   *
   * @param windowKey - The window to evaluate.
   * @returns `true` when the window's queued items cross a threshold.
   */
  private windowShouldSettle(windowKey: string): boolean {
    const items = this.queue.get(windowKey);
    if (!items || items.length === 0) {
      return false;
    }
    const queued = items.filter(item => item.status === 'queued');
    if (queued.length === 0) {
      return false;
    }
    const count = queued.length;
    const totalUsd = queued.reduce((sum, item) => sum + parseFloat(item.amountUsd), 0);
    return (
      count >= this.settlementThresholds.minPaymentCount ||
      totalUsd >= this.settlementThresholds.minTotalUsd
    );
  }

  private getBatchWindowKey(): string {
    const windowStart = Math.floor(Date.now() / this.batchWindowMs) * this.batchWindowMs;
    return `window_${windowStart}`;
  }

  private getPaymentIdsForWindow(windowKey: string): string[] {
    const items = this.queue.get(windowKey);
    return items?.map(p => p.paymentId) ?? [];
  }

  private usdToBaseUnits(usdAmount: string): string {
    if (!usdAmount || typeof usdAmount !== 'string') {
      throw new Error('Amount must be a non-empty string');
    }
    if (!/^\d+\.?\d*$/.test(usdAmount)) {
      throw new Error(`Invalid USD amount: ${usdAmount}`);
    }
    const parts = usdAmount.split('.');
    const whole = parts[0] && parts[0].length > 0 ? parts[0] : '0';
    const rawFraction = parts[1] ?? '';
    // USDC has 6 decimals. Silently truncating extra precision (the old
    // .padEnd(6,'0').slice(0,6)) made the payer underpay vs. what they asked
    // for (CodeRabbit #7). Reject any amount finer than 6 decimals — ignoring
    // trailing zeros, which carry no value (e.g. "0.0010000000" is fine;
    // "0.0000009" is not).
    if (rawFraction.replace(/0+$/, '').length > 6) {
      throw new Error(`USD amount exceeds USDC precision (6 decimals): ${usdAmount}`);
    }
    const fraction = rawFraction.padEnd(6, '0').slice(0, 6);
    return `${whole}${fraction}`.replace(/^0+/, '') || '0';
  }

  private generateNonce(): `0x${string}` {
    const buf = new Uint8Array(32);
    webcrypto.getRandomValues(buf);
    const hex = Array.from(buf)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `0x${hex}`;
  }
}