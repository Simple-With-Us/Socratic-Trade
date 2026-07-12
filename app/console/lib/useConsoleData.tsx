"use client";

/** The console's single data layer: one polled GET /api/dashboard snapshot
 *  shared by every screen via context, refreshed on an interval, after every
 *  mutation, and when the tab becomes visible again. Errors never blank the
 *  screen — the last good snapshot stays up and a visible staleness notice is
 *  derived from `error` + `fetchedAt`. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleApiError, fetchDashboard } from "./api";

const POLL_MS = 15_000;
const EVENT_REFRESH_DEBOUNCE_MS = 200;

export type ConsoleStreamStatus = "unsupported" | "connecting" | "live" | "reconnecting";

export interface ConsoleStreamHealth {
  status: ConsoleStreamStatus;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  lastErrorAt: Date | null;
}

export interface ConsoleData {
  snapshot: DashboardSnapshot | null;
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** True only before the very first snapshot arrives. */
  loading: boolean;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** Health of the SSE stream used for push refreshes. */
  stream: ConsoleStreamHealth;
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
}

const ConsoleDataContext = createContext<ConsoleData | null>(null);

const UNSUPPORTED_STREAM: ConsoleStreamHealth = {
  status: "unsupported",
  connectedAt: null,
  lastEventAt: null,
  lastEventType: null,
  lastErrorAt: null
};

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<ConsoleStreamHealth>(UNSUPPORTED_STREAM);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const queuedRefresh = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await fetchDashboard<DashboardSnapshot>(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setSnapshot(data);
      setFetchedAt(new Date());
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      setError(err instanceof ConsoleApiError ? err.message : "Could not refresh data.");
    }
  }, []);

  const queueRefresh = useCallback(() => {
    if (typeof window === "undefined") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (queuedRefresh.current) window.clearTimeout(queuedRefresh.current);
    queuedRefresh.current = window.setTimeout(() => {
      queuedRefresh.current = null;
      void refresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (queuedRefresh.current) clearTimeout(queuedRefresh.current);
      inFlight.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setStream(UNSUPPORTED_STREAM);
      return;
    }
    setStream((prev) => ({ ...prev, status: "connecting" }));
    const events = new EventSource("/api/events/stream");

    const markConnected = () => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: now,
        lastErrorAt: null
      }));
    };

    const markEvent = (type: string, raw?: string) => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: prev.connectedAt ?? now,
        lastEventAt: now,
        lastEventType: type,
        lastErrorAt: null
      }));
      if (type === "market-data") {
        let detail: unknown = undefined;
        if (raw) {
          try {
            detail = JSON.parse(raw);
          } catch {
            detail = raw;
          }
        }
        window.dispatchEvent(new CustomEvent("market-data-filled", { detail }));
      }
      queueRefresh();
    };

    const refreshTypes = ["ready", "run-complete", "order", "proposal", "dirty", "market-data", "pending-learned-change"] as const;
    const handlers = refreshTypes.map((type) => {
      const handler = (event: MessageEvent) => markEvent(type, event.data);
      events.addEventListener(type, handler);
      return { type, handler };
    });

    events.onopen = markConnected;
    events.onerror = () => {
      if (!mounted.current) return;
      setStream((prev) => ({
        ...prev,
        status: prev.status === "unsupported" ? "unsupported" : "reconnecting",
        lastErrorAt: new Date()
      }));
    };

    return () => {
      for (const { type, handler } of handlers) events.removeEventListener(type, handler);
      events.close();
    };
  }, [queueRefresh]);

  const value = useMemo<ConsoleData>(
    () => ({ snapshot, fetchedAt, loading: snapshot === null && error === null, error, stream, refresh }),
    [snapshot, fetchedAt, error, stream, refresh]
  );

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(ConsoleDataContext);
  if (!ctx) throw new Error("useConsoleData must be used inside ConsoleDataProvider");
  return ctx;
}
