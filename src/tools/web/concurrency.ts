import { throwIfAborted } from "./errors.js";

/** Map with bounded parallelism while preserving input order and aborting before new work. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const count = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (true) {
        throwIfAborted(signal);
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}
