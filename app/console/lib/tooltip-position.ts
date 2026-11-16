/** Viewport-relative positioning for a body-portal tooltip. */
export function tooltipPosition(
  trigger: { top: number; bottom: number; left: number; right: number; width: number },
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "center" | "left" | "right"
): { top: number; left: number } {
  const pad = 12;
  const gap = 8;
  const above = trigger.top - content.height - gap;
  const below = trigger.bottom + gap;
  const preferredTop = above >= pad ? above : below;
  const preferredLeft = align === "left" ? trigger.left
    : align === "right" ? trigger.right - content.width
      : trigger.left + (trigger.width - content.width) / 2;
  return {
    top: Math.max(pad, Math.min(preferredTop, viewport.height - content.height - pad)),
    left: Math.max(pad, Math.min(preferredLeft, viewport.width - content.width - pad))
  };
}
