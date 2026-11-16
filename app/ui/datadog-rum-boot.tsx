"use client";

import { useEffect } from "react";
import { type PublicRumConfig } from "@/lib/datadog-env";
import { startDatadogRum } from "@/lib/datadog-rum";

/** Invisible runtime RUM boot so Coolify Infisical tokens work without a rebuild. */
export function DatadogRumBoot({ config }: { config: PublicRumConfig | null }) {
  useEffect(() => {
    void startDatadogRum(config);
  }, [config]);
  return null;
}
