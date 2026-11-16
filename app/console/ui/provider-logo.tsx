"use client";

/** AI-vendor logo + model badge for the console (originally ported from the
 *  ProviderLogo in the now-retired app/ui/model-picker.tsx). Renders
 *  /model-logos/<provider>.svg on a small neutral (white) tile so
 *  dark/transparent marks stay visible in light AND dark themes; falls back to
 *  a colored-initial chip when the SVG is missing. Available assets: openai,
 *  anthropic, xai, gemini, mistral, deepseek (public/model-logos/). */

import { useEffect, useState } from "react";
import { cx } from "../lib/format";
import { Tooltip } from "./primitives";
import {
  isOpenRouterRouted,
  modelDisplayName,
  providerForModel,
  providerLabel,
  PROVIDER_META,
  type ConsoleProviderId
} from "../lib/models";

export type ProviderLogoSize = "sm" | "md" | "lg";

const SIZE_PX: Record<ProviderLogoSize, number> = { sm: 16, md: 20, lg: 28 };

export function ProviderLogo({
  provider,
  size = "sm",
  className,
  title
}: {
  provider: ConsoleProviderId;
  size?: ProviderLogoSize;
  className?: string;
  title?: string;
}) {
  const px = SIZE_PX[size];
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [provider]);
  const meta = PROVIDER_META[provider];

  if (failed) {
    return (
      <Tooltip content={title ?? providerLabel(provider)}>
        <span
          className={cx("inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white", className)}
          style={{ width: px, height: px, background: meta.color, fontSize: Math.round(px * 0.55) }}
          aria-hidden="true"
        >
          {meta.initial}
        </span>
      </Tooltip>
    );
  }

  // White tile behind every mark: several vendor SVGs are near-black and would
  // vanish on the console's dark surfaces; a white tile reads in both themes.
  return (
    <Tooltip content={title ?? providerLabel(provider)}>
      <span
        className={cx("inline-flex shrink-0 items-center justify-center rounded border border-[color:var(--con-line)] bg-white", className)}
        style={{ width: px, height: px }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/model-logos/${provider}.svg`}
          alt=""
          width={px - 4}
          height={px - 4}
          className="object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    </Tooltip>
  );
}

/** Convenience badge: vendor logo + the model's display name. Maps the model id
 *  to its provider via providerForModel. Renders nothing for a blank id —
 *  callers should pass a fallback label rather than a fabricated model. */
export function ModelBadge({
  modelId,
  size = "sm",
  className,
  showProvider = false,
  title
}: {
  modelId: string | null | undefined;
  size?: ProviderLogoSize;
  className?: string;
  /** Also show the vendor name after the model name (e.g. "· Anthropic"). */
  showProvider?: boolean;
  /** Hover explanation. Defaults to "model (id) — vendor"; pass context-specific
   *  copy (e.g. "The model that generated this proposal") where it matters. */
  title?: string;
}) {
  const id = (modelId ?? "").trim();
  if (!id) return null;
  const provider = providerForModel(id);
  // "via OpenRouter" is a TRANSPORT fact (which vendor API call actually went over the wire),
  // kept separate from the vendor brand above — an OpenRouter-routed Claude call still brands
  // as Anthropic, it just also discloses the routing.
  const viaOpenRouter = isOpenRouterRouted(id);
  const routingSuffix = viaOpenRouter ? " · via OpenRouter" : "";
  return (
    <Tooltip content={title ?? `${modelDisplayName(id)} (${id}) — ${providerLabel(provider)}${routingSuffix}`}>
      <span className={cx("inline-flex min-w-0 items-center gap-1.5 font-semibold", className)}>
        <ProviderLogo provider={provider} size={size} title={title ? `${title} (${providerLabel(provider)})` : undefined} />
        <span className="truncate">{modelDisplayName(id)}</span>
        {showProvider && (
          <span className="shrink-0 font-normal text-[color:var(--con-faint)]">
            · {providerLabel(provider)}
            {routingSuffix}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
