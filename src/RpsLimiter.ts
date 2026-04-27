export class RpsLimiter {
  // Current number of tokens in the bucket (can be fractional)
  private tokens: number;

  // Time of last token refill, in ms
  private lastRefill = Date.now();

  constructor(
    // rps: how many tokens we add per second
    private readonly rps: number,
    // burst: maximum bucket capacity.
    // Default: >=1 and approximately equal to rps (to allow a small burst)
    private readonly burst: number = Math.max(1, Math.ceil(rps)),
  ) {
    // At start, the bucket is full: can make burst requests immediately
    this.tokens = burst;
  }

  // Refill tokens according to elapsed time
  private refill(now: number) {
    // rps<=0 means "limit is disabled"
    if (this.rps <= 0) return;

    const elapsed = now - this.lastRefill; // ms since last refill
    if (elapsed <= 0) return;

    // How many tokens to add:
    // elapsed/1000 = seconds, multiply by rps
    const add = (elapsed / 1000) * this.rps;

    // Add tokens, but don't exceed burst (bucket capacity)
    this.tokens = Math.min(this.burst, this.tokens + add);

    // Remember that we refilled tokens at time now
    this.lastRefill = now;
  }

  isAvailable(count = 1): boolean {
    if (!this.rps || this.rps <= 0) return true;

    const now = Date.now();
    this.refill(now);

    return this.tokens >= count;
  }

  // Take count tokens (usually 1 request = 1 token).
  // If not enough tokens — enqueue exactly one setTimeout for the precise wake-up time.
  // tokens may go negative (debt); each caller's wait time is derived from that debt.
  async take(count = 1): Promise<void> {
    if (!this.rps || this.rps <= 0) return;

    const now = Date.now();
    this.refill(now);
    this.tokens -= count;

    if (this.tokens >= 0) return;

    // tokens is negative: we owe (-tokens) tokens that will accumulate at rps tokens/sec
    const waitMs = Math.ceil((-this.tokens / this.rps) * 1000);
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
