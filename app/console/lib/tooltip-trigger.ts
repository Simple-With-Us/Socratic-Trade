import { Children, isValidElement, type ReactNode } from "react";

const INTERACTIVE_TOOLTIP_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);

/** True when the tooltip wraps a single native control that is already in the tab order.
 *  Non-interactive triggers (Chip, Stat, Ago) need tabIndex + aria-describedby so the
 *  explanation is reachable from the keyboard and announced (#2561). */
export function isInteractiveTooltipTrigger(children: ReactNode): boolean {
  const list = Children.toArray(children);
  if (list.length !== 1) return false;
  const child = list[0];
  if (!isValidElement(child)) return false;
  return typeof child.type === "string" && INTERACTIVE_TOOLTIP_TAGS.has(child.type);
}
