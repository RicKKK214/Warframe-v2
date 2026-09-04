/** Token-bucket + FIFO queue limiter. Shared, server-side only. */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(private rps = 3, private burst = 3) {
    this.tokens = burst;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rps);
  }

  private pump() {
    this.refill();
    while (this.tokens >= 1 && this.queue.length) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.ceil(1000 / this.rps));
    }
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  get pending() {
    return this.queue.length;
  }
}
