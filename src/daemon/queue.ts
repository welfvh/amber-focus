/**
 * Async operation queue — serializes writes to system resources.
 *
 * pf and /etc/hosts writes must not interleave. This queue ensures
 * that only one operation runs at a time, preventing race conditions
 * when multiple RPC calls arrive concurrently.
 */

type QueuedFn<T> = () => Promise<T>;

export class OperationQueue {
  private queue: Array<{ fn: QueuedFn<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private running = false;

  async enqueue<T>(fn: QueuedFn<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (v: unknown) => void, reject });
      if (!this.running) this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (e) {
        item.reject(e);
      }
    }
    this.running = false;
  }

  get pending(): number {
    return this.queue.length;
  }
}
