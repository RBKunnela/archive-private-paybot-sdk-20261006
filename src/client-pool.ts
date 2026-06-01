import { PayBotClient } from './client.js';
import type {
  PayBotConfig,
  PaymentRequest,
  PaymentResult,
  TrustLevel,
} from './types.js';
import type { TelemetryConfig } from './telemetry.js';

/**
 * Operator-/transport-level configuration shared by every bot in a pool.
 *
 * These are the settings that legitimately belong to the operator process
 * rather than to any individual bot — the API key, the facilitator endpoint,
 * timeouts, retry policy and telemetry. Per-bot identity (`botId`,
 * `walletPrivateKey`, `trustLevel`) is intentionally NOT here: it is supplied
 * per bot via {@link PayBotClientPool.addBot} so that each bot keeps its own
 * signing context and never cross-signs another bot's payments.
 *
 * @see PayBotClientPool
 */
export interface PayBotClientPoolConfig {
  /** PayBot API key shared by all bots in this pool. */
  apiKey: string;
  /** Operator identifier shared by all bots (default: 'default-operator'). */
  operatorId?: string;
  /** PayBot facilitator URL (default: https://api.paybotcore.com). */
  facilitatorUrl?: string;
  /** Request timeout in milliseconds, applied to every bot (default: 30000). */
  timeout?: number;
  /** Max retries on network errors / 5xx, applied to every bot (default: 1). */
  maxRetries?: number;
  /**
   * Optional, opt-in OpenTelemetry tracing shared by all bots. When omitted,
   * telemetry is a complete no-op (zero overhead, no OTel runtime dependency).
   */
  telemetry?: TelemetryConfig;
  /**
   * Optional shared spend envelope. When set, the pool tracks cumulative spend
   * across ALL bots for the current UTC day and refuses (via
   * {@link PayBotClientPool.canSpend} / {@link PayBotClientPool.payAs}) any
   * spend that would push the running total over this limit. When omitted, the
   * treasury is unbounded and {@link PayBotClientPool.remainingTreasuryUsd}
   * returns `null`.
   */
  sharedDailyLimitUsd?: number;
}

/** Per-bot identity supplied when adding a bot to the pool. */
export interface PoolBotOptions {
  /** Unique bot identifier within this pool. */
  botId: string;
  /** Bot wallet private key for EIP-3009 signing (hex with 0x prefix). */
  walletPrivateKey?: string;
  /** Initial trust level for this bot. */
  trustLevel?: TrustLevel;
}

/**
 * Lightweight, local per-bot bookkeeping for the current UTC day.
 *
 * This is a convenience projection only — it is NOT a replacement for the
 * facilitator's authoritative spend/rate limits, which are still enforced
 * server-side on every `pay()`. Use it for cheap, in-process introspection
 * (dashboards, fast pre-checks), not as a security boundary.
 */
export interface PoolBotStats {
  /** Total USD this bot has spent today (UTC), per local accounting. */
  dailySpentUsd: number;
  /** Number of successful transactions this bot made today (UTC). */
  dailyTxCount: number;
}

/** Internal per-bot record held by the pool. */
interface PoolEntry {
  client: PayBotClient;
  dailySpentUsd: number;
  dailyTxCount: number;
}

/**
 * Current UTC date as a `YYYY-MM-DD` string, used as the day-rollover key.
 *
 * @returns The UTC calendar date (e.g. `'2026-06-01'`).
 */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * PayBotClientPool — manage many bots from one operator process while sharing
 * operator-/transport-level config and an optional shared spend treasury.
 *
 * One operator running N bots should not pay the cost of N fully-independent
 * clients: the pool holds a single shared config (API key, facilitator URL,
 * timeout, retries, telemetry) and constructs one {@link PayBotClient} per bot
 * that merges that shared config with the bot's own identity. Each bot keeps
 * its OWN signing context (its own `walletPrivateKey`) and never cross-signs.
 *
 * HTTP connection reuse across bots is provided automatically by the runtime's
 * global `fetch` agent (Node's undici keep-alive pool / the browser fetch
 * stack). The pool deliberately does not manage sockets manually — it reuses
 * {@link PayBotClient}'s HTTP logic rather than duplicating it, and the
 * underlying fetch implementation pools connections per origin.
 *
 * The optional shared treasury tracks cumulative spend across ALL bots for the
 * current UTC day in memory. Local per-bot counters ({@link botStats}) are a
 * convenience projection only and do NOT replace the facilitator's
 * authoritative limits.
 *
 * @example
 * ```typescript
 * const pool = new PayBotClientPool({
 *   apiKey: 'pb_test_...',
 *   sharedDailyLimitUsd: 100,
 * });
 * pool.addBot({ botId: 'bot-a', walletPrivateKey: '0x...' });
 * pool.addBot({ botId: 'bot-b', walletPrivateKey: '0x...' });
 * const result = await pool.payAs('bot-a', { resource, amount: '5', payTo });
 * ```
 */
export class PayBotClientPool {
  private readonly config: PayBotClientPoolConfig;
  private readonly bots = new Map<string, PoolEntry>();
  /** Cumulative shared spend (USD) for {@link treasuryDay}. */
  private treasurySpentUsd = 0;
  /** UTC day key the current treasury/per-bot counters belong to. */
  private treasuryDay = utcDayKey();

  /**
   * @param config - Shared operator-/transport-level config (see
   *   {@link PayBotClientPoolConfig}). At minimum an `apiKey` is required.
   * @throws {Error} when `apiKey` is missing or not a non-empty string.
   * @throws {Error} when `sharedDailyLimitUsd` is provided but not a finite,
   *   non-negative number.
   */
  constructor(config: PayBotClientPoolConfig) {
    if (!config.apiKey || typeof config.apiKey !== 'string') {
      throw new Error('PayBotClientPool: apiKey is required and must be a non-empty string');
    }
    if (
      config.sharedDailyLimitUsd !== undefined &&
      (typeof config.sharedDailyLimitUsd !== 'number' ||
        !Number.isFinite(config.sharedDailyLimitUsd) ||
        config.sharedDailyLimitUsd < 0)
    ) {
      throw new Error('PayBotClientPool: sharedDailyLimitUsd must be a finite, non-negative number');
    }
    this.config = config;
  }

  /**
   * Roll over the shared treasury and per-bot counters when the UTC day
   * changes. Cheap to call; a no-op within the same UTC day.
   */
  private rolloverIfNeeded(): void {
    const today = utcDayKey();
    if (today === this.treasuryDay) return;
    this.treasuryDay = today;
    this.treasurySpentUsd = 0;
    for (const entry of this.bots.values()) {
      entry.dailySpentUsd = 0;
      entry.dailyTxCount = 0;
    }
  }

  /**
   * Construct a {@link PayBotClient} for a bot, merging the pool's shared
   * config with the bot's identity, store it keyed by `botId`, and return it.
   *
   * Each bot's `walletPrivateKey` stays bound to its own client, so bots never
   * cross-sign one another's payments.
   *
   * @param opts - The bot's identity (see {@link PoolBotOptions}).
   * @returns The newly constructed client for this bot.
   * @throws {Error} when `botId` is already present in the pool.
   *
   * @example
   * const client = pool.addBot({ botId: 'bot-a', walletPrivateKey: '0x...' });
   */
  addBot(opts: PoolBotOptions): PayBotClient {
    if (this.bots.has(opts.botId)) {
      throw new Error(`PayBotClientPool: bot already added: ${opts.botId}`);
    }
    const clientConfig: PayBotConfig = {
      apiKey: this.config.apiKey,
      operatorId: this.config.operatorId,
      facilitatorUrl: this.config.facilitatorUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      telemetry: this.config.telemetry,
      botId: opts.botId,
      walletPrivateKey: opts.walletPrivateKey,
    };
    const client = new PayBotClient(clientConfig);
    this.bots.set(opts.botId, { client, dailySpentUsd: 0, dailyTxCount: 0 });
    return client;
  }

  /**
   * Look up a bot's client.
   *
   * @param botId - The bot identifier.
   * @returns The client previously registered via {@link addBot}.
   * @throws {Error} when `botId` is not in the pool.
   */
  getBot(botId: string): PayBotClient {
    const entry = this.bots.get(botId);
    if (!entry) {
      throw new Error(`PayBotClientPool: unknown bot: ${botId}`);
    }
    return entry.client;
  }

  /**
   * Remove a bot from the pool.
   *
   * @param botId - The bot identifier.
   * @returns `true` if a bot was removed, `false` if it was not present.
   */
  removeBot(botId: string): boolean {
    return this.bots.delete(botId);
  }

  /**
   * Whether a bot with this id is in the pool.
   *
   * @param botId - The bot identifier.
   * @returns `true` if present.
   */
  hasBot(botId: string): boolean {
    return this.bots.has(botId);
  }

  /**
   * All bot ids currently in the pool, in insertion order.
   *
   * @returns An array of bot identifiers.
   */
  botIds(): string[] {
    return [...this.bots.keys()];
  }

  /** Number of bots in the pool. */
  get size(): number {
    return this.bots.size;
  }

  /**
   * Record a successful spend against the shared treasury and the bot's local
   * counters. Rolls the counters over first if the UTC day has changed.
   *
   * Negative amounts and non-finite amounts are ignored (treated as 0) so a
   * bad call can never credit the treasury. An unknown `botId` updates the
   * shared treasury but records no per-bot stat (there is nothing to record).
   *
   * @param botId - The spending bot's identifier.
   * @param amountUsd - The amount spent, in USD.
   */
  recordSpend(botId: string, amountUsd: number): void {
    this.rolloverIfNeeded();
    const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
    this.treasurySpentUsd += amount;
    const entry = this.bots.get(botId);
    if (entry) {
      entry.dailySpentUsd += amount;
      entry.dailyTxCount += 1;
    }
  }

  /**
   * Remaining shared-treasury budget for the current UTC day.
   *
   * @returns The remaining USD (never below 0), or `null` when no shared limit
   *   is configured (unbounded treasury).
   */
  remainingTreasuryUsd(): number | null {
    if (this.config.sharedDailyLimitUsd === undefined) return null;
    this.rolloverIfNeeded();
    return Math.max(0, this.config.sharedDailyLimitUsd - this.treasurySpentUsd);
  }

  /**
   * Whether a spend of `amountUsd` fits within the remaining shared treasury.
   *
   * Always `true` when no shared limit is configured. A non-finite or negative
   * `amountUsd` is treated as 0 (it consumes nothing, so it always fits).
   *
   * @param amountUsd - The prospective spend, in USD.
   * @returns `true` if the spend is allowed by the shared treasury.
   */
  canSpend(amountUsd: number): boolean {
    const remaining = this.remainingTreasuryUsd();
    if (remaining === null) return true;
    const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
    return amount <= remaining;
  }

  /**
   * Per-bot local spend/tx bookkeeping for the current UTC day.
   *
   * This is a convenience projection only — NOT a replacement for the
   * facilitator's authoritative spend/rate limits, which are enforced
   * server-side on every `pay()`. Rolls the counters over if the UTC day has
   * changed before reading.
   *
   * @param botId - The bot identifier.
   * @returns The bot's local daily spend and transaction count.
   * @throws {Error} when `botId` is not in the pool.
   */
  botStats(botId: string): PoolBotStats {
    this.rolloverIfNeeded();
    const entry = this.bots.get(botId);
    if (!entry) {
      throw new Error(`PayBotClientPool: unknown bot: ${botId}`);
    }
    return { dailySpentUsd: entry.dailySpentUsd, dailyTxCount: entry.dailyTxCount };
  }

  /**
   * Pay on behalf of a bot, gated by the shared treasury.
   *
   * When a shared limit is configured, the prospective spend (parsed from
   * `request.amount`) is checked against the remaining treasury FIRST. If it
   * would exceed the budget, a `PaymentResult`-shaped failure with
   * `errorCode: 'TREASURY_EXCEEDED'` is returned immediately and NO network
   * call is made. Otherwise the bot's own `pay()` runs, and on
   * `success: true` the spend is recorded against both the shared treasury and
   * the bot's local counters.
   *
   * The amount parsed for the treasury check uses `parseFloat(request.amount)`;
   * a non-numeric amount parses to `NaN`, which {@link canSpend} treats as a
   * zero-cost (always-allowed) spend and {@link recordSpend} treats as 0 — the
   * facilitator remains the source of truth for amount validation.
   *
   * @param botId - The bot to pay as.
   * @param request - The payment request (see {@link PaymentRequest}).
   * @returns The bot's `PaymentResult`, or a `TREASURY_EXCEEDED` failure.
   * @throws {Error} when `botId` is not in the pool.
   */
  async payAs(botId: string, request: PaymentRequest): Promise<PaymentResult> {
    const client = this.getBot(botId);
    const amountUsd = parseFloat(request.amount);

    if (this.config.sharedDailyLimitUsd !== undefined && !this.canSpend(amountUsd)) {
      return {
        success: false,
        grossAmount: '0',
        netAmount: '0',
        commissionAmount: '0',
        commissionRate: 0,
        error: `Shared treasury exceeded: remaining ${this.remainingTreasuryUsd()} USD, requested ${request.amount} USD`,
        errorCode: 'TREASURY_EXCEEDED',
      };
    }

    const result = await client.pay(request);
    if (result.success) {
      this.recordSpend(botId, amountUsd);
    }
    return result;
  }
}
