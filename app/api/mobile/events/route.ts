import { subscribeDashboardEvents, type DashboardEvent } from "@/lib/events";
import { subscribeMobileCommandEvents } from "@/lib/mobile-api";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const subscriberId = resolveRequestUserId(request);
  const encoder = new TextEncoder();
  let unsubscribeMobile: (() => void) | null = null;
  let unsubscribeDashboard: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // already closed
        }
      };
      const sendEvent = (name: string, data: unknown) => {
        send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send(": connected\n\n");
      sendEvent("ready", {});

      unsubscribeMobile = subscribeMobileCommandEvents((event) => {
        if (event.userId !== subscriberId) return;
        sendEvent("mobile.command", event);
      });

      unsubscribeDashboard = subscribeDashboardEvents((event: DashboardEvent) => {
        if (event.userId && event.userId !== subscriberId) return;
        sendEvent(`dashboard.${event.type}`, { type: `dashboard.${event.type}`, at: event.at, detail: event.detail ?? {} });
      });

      heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      request.signal.addEventListener("abort", close);

      function close() {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (unsubscribeMobile) unsubscribeMobile();
        if (unsubscribeDashboard) unsubscribeDashboard();
        unsubscribeMobile = null;
        unsubscribeDashboard = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribeMobile) unsubscribeMobile();
      if (unsubscribeDashboard) unsubscribeDashboard();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}
