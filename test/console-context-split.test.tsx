/** ST-4642 — the console's data layer must not re-render a consumer that reads
 *  only the snapshot when ONLY the stream health changed.
 *
 *  The bug: one `ConsoleDataContext` value bundled the snapshot, the stream
 *  health, the freshness flags and the actions. Every SSE push minted a fresh
 *  stream object, so the bundled value's identity changed and every one of
 *  the console's ~30 consumer files re-rendered — including the ones that
 *  only ever read `snapshot`. During an active scan (`market-data` events
 *  arriving continuously) that re-rendered the whole tree several times a
 *  minute.
 *
 *  The fix: the provider publishes a store, and each consumer subscribes to
 *  the ONE slice it reads (`useConsoleSnapshot` / `useConsoleStatus` /
 *  `useConsoleStream` / `useConsoleActions`).
 *
 *  WHY THIS TEST IS NOT A jsdom RENDER: this repo's vitest setup is node-only
 *  — no jsdom, no testing-library (see app/console/lib/console-load-state.ts
 *  for the same constraint biting the codebase once already). React's
 *  `useSyncExternalStore` decides whether to re-render by ONE rule: the value
 *  its selector returns must change identity. `ConsoleSliceReader` is that
 *  rule written out, and the React hook drives a reader like it — so the
 *  contract asserted below IS the contract React applies. The second test
 *  renders a real consumer with `renderToStaticMarkup` to prove the wiring
 *  (provider -> context -> hook -> consumer) delivers the snapshot slice. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../app/dashboard-types";
import {
  ConsoleSliceReader,
  ConsoleStore,
  UNSUPPORTED_STREAM,
  initialConsoleState,
  selectConsoleSnapshot,
  selectConsoleStatus,
  selectConsoleStream
} from "../app/console/lib/console-store";
import { ConsoleStoreContext, useConsoleSnapshot } from "../app/console/lib/useConsoleData";

const fixtureSnapshot = {
  policy: { maxDailyOrders: 6, systemState: "active" },
  pendingProposals: [],
  notifications: []
} as unknown as DashboardSnapshot;

function storeWithSnapshot(): ConsoleStore {
  return new ConsoleStore({ ...initialConsoleState(), snapshot: fixtureSnapshot });
}

describe("console data layer — slice subscriptions (ST-4642)", () => {
  it("does not re-render a snapshot-scoped consumer when only the stream changes", () => {
    const store = storeWithSnapshot();
    // The reader a snapshot-scoped consumer uses.
    const snapshotReader = new ConsoleSliceReader(() => selectConsoleSnapshot(store.getState()));
    const streamReader = new ConsoleSliceReader(() => selectConsoleStream(store.getState()));

    const snapshotBefore = snapshotReader.value();
    const streamBefore = streamReader.value();
    expect(snapshotBefore).toBe(fixtureSnapshot);

    // A stream-only push — exactly what an SSE `market-data` event does.
    const notifications: number[] = [];
    const unsubscribe = store.subscribe(() => notifications.push(1));
    store.setState({
      stream: {
        ...UNSUPPORTED_STREAM,
        status: "live",
        connectedAt: new Date("2026-11-23T00:00:00.000Z"),
        lastEventAt: new Date("2026-11-23T00:00:01.000Z"),
        lastEventType: "market-data",
        lastErrorAt: null
      }
    });
    unsubscribe();

    // The store DID notify — the stream slice changed.
    expect(notifications.length).toBe(1);
    // ...and the stream-scoped consumer's selected value changed identity, so
    // React re-renders it.
    expect(streamReader.value()).not.toBe(streamBefore);
    // ...but the snapshot-scoped consumer's selected value is the SAME
    // reference, so React does NOT re-render it. This is the regression.
    expect(snapshotReader.value()).toBe(snapshotBefore);
  });

  it("does re-render a snapshot-scoped consumer when the snapshot itself changes", () => {
    const store = storeWithSnapshot();
    const snapshotReader = new ConsoleSliceReader(() => selectConsoleSnapshot(store.getState()));
    const before = snapshotReader.value();

    const next = { ...fixtureSnapshot, pendingProposals: [{ id: "p1" }] } as unknown as DashboardSnapshot;
    store.setState({ snapshot: next });

    expect(snapshotReader.value()).not.toBe(before);
    expect(snapshotReader.value()).toBe(next);
  });

  it("keeps the status slice stable across a stream-only change", () => {
    const store = storeWithSnapshot();
    const statusReader = new ConsoleSliceReader(() => selectConsoleStatus(store.getState()));
    const before = statusReader.value();

    store.setState({
      stream: { ...UNSUPPORTED_STREAM, status: "live", connectedAt: new Date(), lastEventAt: new Date(), lastEventType: "order" }
    });

    // The status slice (freshness, error, online) did not change, so a status
    // consumer keeps the same object and does not re-render.
    expect(statusReader.value()).toBe(before);
  });

  it("does not notify subscribers when a patch changes nothing", () => {
    const store = storeWithSnapshot();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.setState({ snapshot: fixtureSnapshot });
    expect(notified).toBe(0);
    store.setState({ error: "boom" });
    expect(notified).toBe(1);
    unsubscribe();
  });

  it("renders a consumer of the snapshot slice from the published store", () => {
    const store = storeWithSnapshot();
    function SnapshotConsumer() {
      const snapshot = useConsoleSnapshot();
      return <span>{String(snapshot?.policy?.maxDailyOrders ?? "none")}</span>;
    }
    const html = renderToStaticMarkup(
      <ConsoleStoreContext.Provider value={store}>
        <SnapshotConsumer />
      </ConsoleStoreContext.Provider>
    );
    expect(html).toContain("6");
  });
});
