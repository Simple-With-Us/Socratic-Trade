/**
 * Rolling-24h Pinecone write-fuse selection.
 *
 * The daily fuse must never deadlock: if used=0 and the first document's estimate
 * exceeds the remaining cap, accepting nothing leaves used at 0 forever and every
 * later document is skipped.  That is the "used 0 of 15 WUs, attempted 28, skipped 1"
 * card.  Allow that first document; Pinecone itself 429s if the plan is actually out.
 */

export interface WriteBudgetSelection<T> {
  kept: T[];
  skipped: number;
  requested: number;
  allowed: number;
}

export function selectItemsWithinWriteBudget<T>(
  items: T[],
  estimate: (item: T) => number,
  used: number,
  limit: number
): WriteBudgetSelection<T> {
  let remaining = Math.max(0, limit - used);
  let requested = 0;
  let accepting = true;
  const kept: T[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const estimated = estimate(item);
    requested += estimated;
    if (accepting && remaining >= estimated) {
      remaining -= estimated;
      kept.push(item);
      continue;
    }
    if (accepting && used === 0 && kept.length === 0 && i === 0 && estimated > 0) {
      remaining = 0;
      kept.push(item);
      continue;
    }
    accepting = false;
  }

  return {
    kept,
    skipped: items.length - kept.length,
    requested,
    allowed: Math.max(0, limit - used)
  };
}
