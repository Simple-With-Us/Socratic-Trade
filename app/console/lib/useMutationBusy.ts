"use client";

import { useEffect, useState } from "react";
import { consoleMutationBusyCount, subscribeConsoleMutationBusy } from "./mutation-busy";

/** True while any console POST/PATCH/PUT/DELETE is in flight. */
export function useMutationBusy(): { busy: boolean; count: number } {
  const [count, setCount] = useState(consoleMutationBusyCount);
  useEffect(() => subscribeConsoleMutationBusy(setCount), []);
  return { busy: count > 0, count };
}
