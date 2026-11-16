import { afterEach, describe, expect, it } from "vitest";
import {
  hasBlockingFocusTrap,
  isTopmostFocusTrap,
  nextTrapFocusTarget,
  pushFocusTrap,
  releaseFocusTrap,
  type FocusTrapHandle
} from "../app/console/ui/focus-trap";

// The stack is module-level state shared by every trap on the page, so a test that leaves a
// handle behind would poison the next one exactly the way a leaked trap poisons the app.
const pushed: FocusTrapHandle[] = [];
function push(blocking: boolean): FocusTrapHandle {
  const handle = pushFocusTrap({ blocking });
  pushed.push(handle);
  return handle;
}
afterEach(() => {
  while (pushed.length) releaseFocusTrap(pushed.pop() as FocusTrapHandle);
});

describe("console focus trap — Tab target", () => {
  const container = { id: "container" };
  const close = { id: "close" };
  const input = { id: "input" };
  const action = { id: "action" };
  const focusables = [close, input, action];

  it("advances and reverses through the focusables", () => {
    expect(nextTrapFocusTarget(focusables, close, container, false)).toBe(input);
    expect(nextTrapFocusTarget(focusables, input, container, false)).toBe(action);
    expect(nextTrapFocusTarget(focusables, action, container, true)).toBe(input);
  });

  it("wraps at both ends instead of leaking focus to the page behind", () => {
    expect(nextTrapFocusTarget(focusables, action, container, false)).toBe(close);
    expect(nextTrapFocusTarget(focusables, close, container, true)).toBe(action);
  });

  it("pulls focus in from outside the dialog, respecting direction", () => {
    // `active === null` is focus that started outside the container — the first Tab after
    // opening, or a stray focus another surface's sentry handed us.
    expect(nextTrapFocusTarget(focusables, null, container, false)).toBe(close);
    expect(nextTrapFocusTarget(focusables, null, container, true)).toBe(action);
    // The container itself (tabIndex={-1}) is not in the focusable list, so it reads as
    // "outside" and Tab still enters the list rather than doing nothing.
    expect(nextTrapFocusTarget(focusables, container, container, false)).toBe(close);
  });

  it("falls back to the dialog itself when it holds nothing focusable", () => {
    expect(nextTrapFocusTarget([], null, container, false)).toBe(container);
    expect(nextTrapFocusTarget([], container, container, true)).toBe(container);
  });

  it("never returns null, so a stacked dialog can always move focus itself", () => {
    // A Sheet underneath has already called preventDefault() by the time our handler runs,
    // so "return null and let the browser Tab" would leave focus frozen.
    for (const from of [null, close, input, action, container]) {
      for (const shift of [false, true]) {
        expect(nextTrapFocusTarget(focusables, from, container, shift)).not.toBeNull();
      }
    }
  });
});

describe("console focus trap — stack arbitration", () => {
  it("gives ownership to the most recently opened surface", () => {
    const sheet = push(false);
    expect(isTopmostFocusTrap(sheet)).toBe(true);

    const drawer = push(false);
    expect(isTopmostFocusTrap(drawer)).toBe(true);
    // The surface underneath must go quiet, or the two traps fight over every Tab and the
    // one on top ends up unreachable by keyboard.
    expect(isTopmostFocusTrap(sheet)).toBe(false);

    releaseFocusTrap(drawer);
    expect(isTopmostFocusTrap(sheet)).toBe(true);
  });

  it("hands ownership back correctly when traps close out of order", () => {
    const gate = push(true);
    const drawer = push(false);
    const palette = push(false);

    releaseFocusTrap(drawer);
    expect(isTopmostFocusTrap(palette)).toBe(true);
    releaseFocusTrap(palette);
    expect(isTopmostFocusTrap(gate)).toBe(true);
  });

  it("releasing a handle that is not on the stack changes nothing", () => {
    const drawer = push(false);
    releaseFocusTrap({ blocking: false });
    expect(isTopmostFocusTrap(drawer)).toBe(true);
  });

  it("reports a blocking surface from anywhere in the stack", () => {
    expect(hasBlockingFocusTrap()).toBe(false);

    const gate = push(true);
    expect(hasBlockingFocusTrap()).toBe(true);
    // Still blocking with a dismissible surface stacked above it — otherwise the consent
    // gate's "blocks all interaction beneath" claim would lapse the moment anything opened.
    push(false);
    expect(hasBlockingFocusTrap()).toBe(true);

    releaseFocusTrap(gate);
    expect(hasBlockingFocusTrap()).toBe(false);
  });
});
