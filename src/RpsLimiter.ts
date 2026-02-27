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

  // Take count tokens (usually 1 request = 1 token).
  // If not enough tokens — wait and try again.
  async take(count = 1): Promise<void> {
    if (!this.rps || this.rps <= 0) return;

    while (true) {
      const now = Date.now();

      // Before attempting — refill tokens
      this.refill(now);

      // If enough tokens — "pay" for the request and exit
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }

      // Not enough tokens: calculate how long to wait
      const need = count - this.tokens;

      // How many ms needed to accumulate need tokens:
      // need / rps = seconds, *1000 = ms
      const waitMs = Math.ceil((need / this.rps) * 1000);

      // Wait in chunks (not all waitMs at once), to:
      // - not sleep too long if time/state changed
      // - be more resilient to timer drift
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 250)));
    }
  }
}
