export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}

interface PendingBatch<T> {
  items: T[];
  timer: ReturnType<typeof setTimeout>;
  resolve: Array<() => void>;
  reject: Array<(error: unknown) => void>;
}

export class KeyedBatchQueue<T> {
  private readonly batches = new Map<string, PendingBatch<T>>();
  private readonly tasks = new KeyedTaskQueue();

  constructor(
    private readonly delayMs: number,
    private readonly handle: (key: string, items: readonly T[]) => Promise<void>,
  ) {}

  push(key: string, item: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.batches.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.items.push(item);
        existing.resolve.push(resolve);
        existing.reject.push(reject);
        existing.timer = this.schedule(key);
        return;
      }
      this.batches.set(key, {
        items: [item],
        timer: this.schedule(key),
        resolve: [resolve],
        reject: [reject],
      });
    });
  }

  async drain(): Promise<void> {
    const keys = [...this.batches.keys()];
    for (const key of keys) {
      const batch = this.batches.get(key);
      if (batch) clearTimeout(batch.timer);
    }
    await Promise.allSettled(keys.map((key) => this.flush(key)));
    await this.tasks.drain();
  }

  private schedule(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flush(key).catch(() => undefined);
    }, this.delayMs);
  }

  private flush(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) return Promise.resolve();
    this.batches.delete(key);
    const result = this.tasks.enqueue(key, () => this.handle(key, batch.items));
    void result.then(
      () => batch.resolve.forEach((resolve) => resolve()),
      (error) => batch.reject.forEach((reject) => reject(error)),
    );
    return result;
  }
}
