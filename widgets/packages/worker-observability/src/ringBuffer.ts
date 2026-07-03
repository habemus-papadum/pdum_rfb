// A tiny fixed-capacity ring buffer. Holds the last N items (oldest evicted first) so a
// bounded, allocation-stable window of log lines is always readable from `window.__<ns>.logs`
// without a live console attached. Pure + dependency-free → unit-tested in Node.

export class RingBuffer<T> {
  private buf: T[] = [];
  /** Index of the oldest element within `buf` once the buffer has wrapped. */
  private head = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    // A non-positive capacity would make push() a no-op forever; clamp to at least 1.
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Append an item, evicting the oldest once at capacity. */
  push(item: T): void {
    if (this.count < this.capacity) {
      this.buf.push(item);
      this.count += 1;
      return;
    }
    // Full: overwrite the current head and advance it (circular).
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Number of items currently held (≤ capacity). */
  get size(): number {
    return this.count;
  }

  /** Snapshot oldest → newest. */
  toArray(): T[] {
    if (this.count < this.capacity) return this.buf.slice();
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  clear(): void {
    this.buf = [];
    this.head = 0;
    this.count = 0;
  }
}
