import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolve } from "node:path";

export function dataPath(filename: string): string {
  return resolve(process.env.PHOTON_DATA_DIR ?? "data", filename);
}

export class SerialQueue {
  private tail = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const fileQueues = new Map<string, SerialQueue>();

function queueFor(path: string): SerialQueue {
  let queue = fileQueues.get(path);
  if (!queue) {
    queue = new SerialQueue();
    fileQueues.set(path, queue);
  }
  return queue;
}

export function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  return queueFor(path).run(operation);
}

export async function atomicWriteText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

interface TransactionResult<T> {
  result: T;
  changed: boolean;
}

export class JsonFileStore<T> {
  constructor(
    private readonly filename: string,
    private readonly fallback: () => T,
    private readonly parse: (value: unknown) => T,
  ) {}

  private path(): string {
    return dataPath(this.filename);
  }

  private async readUnlocked(path: string): Promise<T> {
    try {
      return this.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.fallback();
      throw error;
    }
  }

  async read(): Promise<T> {
    const path = this.path();
    return withFileLock(path, () => this.readUnlocked(path));
  }

  async update<R>(mutator: (value: T) => TransactionResult<R> | Promise<TransactionResult<R>>): Promise<R> {
    const path = this.path();
    return withFileLock(path, async () => {
      const value = await this.readUnlocked(path);
      const outcome = await mutator(value);
      if (outcome.changed) await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
      return outcome.result;
    });
  }
}
