"use client";

import { useMemo, type ReactNode } from "react";
import { dayKey, fmtDay } from "../lib/format";
import { Card, Empty } from "../ui/primitives";

export function DayGroups<T>({
  items,
  timestamp,
  renderItem,
  emptyText
}: {
  items: T[];
  timestamp: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  emptyText: string;
}) {
  const groups = useMemo(() => {
    const byDay = new Map<string, T[]>();
    for (const item of items) {
      const key = dayKey(timestamp(item));
      const list = byDay.get(key) ?? [];
      list.push(item);
      byDay.set(key, list);
    }
    return [...byDay.entries()];
  }, [items, timestamp]);

  if (items.length === 0) {
    return (
      <Card>
        <Empty>{emptyText}</Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([key, list]) => (
        <div key={key}>
          <div className="con-card-title mb-2 pl-1">{fmtDay(timestamp(list[0]))}</div>
          <div className="flex flex-col gap-3">{list.map(renderItem)}</div>
        </div>
      ))}
    </div>
  );
}
