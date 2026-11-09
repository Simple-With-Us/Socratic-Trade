"use client";

import { useEffect } from "react";
import { toast } from "sonner";

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "message" in value && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message.trim();
  }
  return "An unexpected browser-side error occurred.";
}

function shorten(message: string): string {
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

export function GlobalErrorToasts() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      toast.error("App error", { description: shorten(errorMessage(event.error ?? event.message)) });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      toast.error("App error", { description: shorten(errorMessage(event.reason)) });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
