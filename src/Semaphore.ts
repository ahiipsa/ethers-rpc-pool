export class Semaphore {
  private inUse = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`Semaphore max must be a positive number, got: ${max}`);
    }
  }

  async acquire(): Promise<() => void> {
    if (this.inUse < this.max) {
      this.inUse++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.inUse++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      });
    });
  }

  private release() {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}
