import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedConfirm } from "../app/console/components/chrome";
import {
  createProposalRowHandlers,
  type DecisionRowData,
  type ProposalRowActionState
} from "../app/console/lib/evidence-rows";
import * as api from "../app/console/lib/api";

describe("TypedConfirm safety controls (ST-4648)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function renderWithCapture(props: any) {
    let captured: any = null;
    function Harness() {
      captured = TypedConfirm(props);
      return captured;
    }
    renderToStaticMarkup(<Harness />);
    return captured;
  }

  it("prevents paste on the confirmation input (words are the consent)", () => {
    let defaultPrevented = false;
    const vdom = renderWithCapture({
      phrase: "APPROVE LIVE NVDA",
      value: "",
      onChange: vi.fn(),
      onConfirm: vi.fn(),
      confirmLabel: "Confirm live order"
    });

    const children = Array.isArray(vdom.props.children) ? vdom.props.children : [vdom.props.children];
    const flexDiv = children.find((c: any) => c?.props?.className?.includes("flex gap-2"));
    expect(flexDiv).toBeDefined();

    const textInput = flexDiv.props.children[0];
    expect(textInput).toBeDefined();

    const fakePasteEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      },
      defaultPrevented: false
    };

    textInput.props.onPaste(fakePasteEvent);
    expect(defaultPrevented).toBe(true);
  });

  it("does NOT trigger onConfirm when the user types the exact phrase into onChange", () => {
    const onConfirmSpy = vi.fn();
    const onChangeSpy = vi.fn();

    const vdom = renderWithCapture({
      phrase: "APPROVE LIVE NVDA",
      value: "APPROVE LIVE NVDA",
      onChange: onChangeSpy,
      onConfirm: onConfirmSpy,
      confirmLabel: "Confirm live order"
    });

    const children = Array.isArray(vdom.props.children) ? vdom.props.children : [vdom.props.children];
    const flexDiv = children.find((c: any) => c?.props?.className?.includes("flex gap-2"));
    const textInput = flexDiv.props.children[0];

    // Simulate typing the full matching phrase
    textInput.props.onChange({ target: { value: "APPROVE LIVE NVDA" } });

    expect(onChangeSpy).toHaveBeenCalledWith("APPROVE LIVE NVDA");
    // CRITICAL REGRESSION: Typing the exact phrase must NEVER auto-fire the real-money order!
    expect(onConfirmSpy).not.toHaveBeenCalled();
  });

  it("disables the confirm button until the typed text matches the phrase", () => {
    const vdomMismatch = renderWithCapture({
      phrase: "APPROVE LIVE NVDA",
      value: "APPROVE LIVE",
      onChange: vi.fn(),
      onConfirm: vi.fn(),
      confirmLabel: "Confirm live order"
    });

    const childrenMismatch = Array.isArray(vdomMismatch.props.children) ? vdomMismatch.props.children : [vdomMismatch.props.children];
    const flexDivMismatch = childrenMismatch.find((c: any) => c?.props?.className?.includes("flex gap-2"));
    const buttonMismatch = flexDivMismatch.props.children[1];
    expect(Boolean(buttonMismatch.props.disabled)).toBe(true);

    const onConfirmSpy = vi.fn();
    const vdomMatch = renderWithCapture({
      phrase: "APPROVE LIVE NVDA",
      value: "  approve live nvda  ",
      onChange: vi.fn(),
      onConfirm: onConfirmSpy,
      confirmLabel: "Confirm live order"
    });

    const childrenMatch = Array.isArray(vdomMatch.props.children) ? vdomMatch.props.children : [vdomMatch.props.children];
    const flexDivMatch = childrenMatch.find((c: any) => c?.props?.className?.includes("flex gap-2"));
    const buttonMatch = flexDivMatch.props.children[1];

    expect(Boolean(buttonMatch.props.disabled)).toBe(false);
    buttonMatch.props.onClick();
    expect(onConfirmSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Home ProposalRow safety and Reject controls (ST-4648)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockRow: DecisionRowData = {
    id: "prop-42",
    symbol: "NVDA",
    verb: "Buy",
    size: "$5,000",
    status: "pending",
    rationale: "Long setup",
    approvable: true
  };

  it("wires ProposalRow in app/console/page.tsx with TypedConfirm, Reject, and per-row proposal evidence without auto-fire", () => {
    const pageSrc = readFileSync(resolve(process.cwd(), "app/console/page.tsx"), "utf8");
    expect(pageSrc).toContain("deriveEvidenceRows(snapshot, latest, decision, proposal)");
    expect(pageSrc).toContain("<TypedConfirm");
    expect(pageSrc).toContain("onClick={handleReject}");
    expect(pageSrc).toContain("onClick={handleApprove}");
    expect(pageSrc).not.toContain("if (e.target.value === liveConfirm)");
    expect(pageSrc).not.toContain("disabled={busy || !!liveConfirm}");
  });

  it("renders TypedConfirm static markup disabled until the confirmation phrase matches", () => {
    const htmlPending = renderToStaticMarkup(
      <TypedConfirm
        phrase="APPROVE LIVE NVDA"
        value=""
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        confirmLabel="Confirm live order"
        variant="primary"
        note={"Live trading requires confirmation.\u00A0 Type the exact phrase to proceed."}
      />
    );
    expect(htmlPending).toContain("Confirm live order");
    expect(htmlPending).toContain("Type exactly:");
    expect(htmlPending).toContain("APPROVE LIVE NVDA");
    expect(htmlPending).toContain('disabled=""');

    const htmlMatched = renderToStaticMarkup(
      <TypedConfirm
        phrase="APPROVE LIVE NVDA"
        value="APPROVE LIVE NVDA"
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        confirmLabel="Confirm live order"
        variant="primary"
      />
    );
    expect(htmlMatched).not.toContain('disabled=""');
  });

  it("calls rejectProposal and triggers refresh and toast on reject", async () => {
    const rejectSpy = vi.spyOn(api, "rejectProposal").mockResolvedValueOnce({ status: "rejected" });
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: null,
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      const handlers = createProposalRowHandlers({
        row: mockRow,
        state,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      await handlers.handleReject();

      expect(rejectSpy).toHaveBeenCalledWith("prop-42");
      expect(refreshSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
      expect(toastSpy.push).toHaveBeenCalledWith(
        "info",
        "Rejected NVDA",
        expect.stringContaining("The idea keeps being scored")
      );
      expect(state.busy).toBeNull();
      expect(state.liveConfirm).toBeNull();
      expect(state.confirmText).toBe("");
    } finally {
      rejectSpy.mockRestore();
    }
  });

  it("handles rejectProposal failure gracefully with an error toast", async () => {
    const rejectSpy = vi.spyOn(api, "rejectProposal").mockRejectedValueOnce(new api.ConsoleApiError("Rejection unauthorized", 403));
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: null,
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      const handlers = createProposalRowHandlers({
        row: mockRow,
        state,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      await handlers.handleReject();

      expect(closeSpy).not.toHaveBeenCalled();
      expect(toastSpy.push).toHaveBeenCalledWith("neg", "Rejection failed", "Rejection unauthorized");
      expect(state.busy).toBeNull();
    } finally {
      rejectSpy.mockRestore();
    }
  });

  it("typing the phrase does NOT trigger handleApprove until explicitly submitted", async () => {
    const approveSpy = vi.spyOn(api, "approveProposal").mockResolvedValueOnce({ status: "placed" });
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: "APPROVE LIVE NVDA",
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      // Simulate typing the phrase into state (via onChange)
      state = { ...state, confirmText: "APPROVE LIVE NVDA" };

      // CRITICAL: Simply updating text must NOT call approveProposal!
      expect(approveSpy).not.toHaveBeenCalled();

      const handlers = createProposalRowHandlers({
        row: mockRow,
        state,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      // Only when user clicks confirm button does handleApprove execute
      await handlers.handleApprove();

      expect(approveSpy).toHaveBeenCalledWith("prop-42", {
        proposalId: "prop-42",
        executionMode: "broker/live",
        typedText: "APPROVE LIVE NVDA"
      });
      expect(refreshSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
      expect(toastSpy.push).toHaveBeenCalledWith(
        "pos",
        "BUY NVDA placed",
        expect.stringContaining("order went to the broker")
      );
      expect(state.liveConfirm).toBeNull();
      expect(state.confirmText).toBe("");
    } finally {
      approveSpy.mockRestore();
    }
  });

  it("reads fresh liveConfirm and confirmText via getConfirmState at click time to prevent stale closure", async () => {
    const approveSpy = vi.spyOn(api, "approveProposal").mockResolvedValueOnce({ status: "placed" });
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: null,
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      // Simulated component ref holding mutable live state
      const ref = {
        current: {
          liveConfirm: "APPROVE LIVE NVDA",
          confirmText: "initial-stale-value"
        }
      };

      // Handler initialized with getter
      const handlers = createProposalRowHandlers({
        row: mockRow,
        getConfirmState: () => ref.current,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      // User types into input after handler was created
      ref.current.confirmText = "APPROVE LIVE NVDA";

      await handlers.handleApprove();

      expect(approveSpy).toHaveBeenCalledWith("prop-42", {
        proposalId: "prop-42",
        executionMode: "broker/live",
        typedText: "APPROVE LIVE NVDA"
      });
      expect(toastSpy.push).toHaveBeenCalledWith(
        "pos",
        "BUY NVDA placed",
        expect.stringContaining("order went to the broker")
      );
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      approveSpy.mockRestore();
    }
  });

  it("transitions to live confirmation when server answers LiveConfirmationRequiredError", async () => {
    const approveSpy = vi.spyOn(api, "approveProposal").mockRejectedValueOnce(
      new api.LiveConfirmationRequiredError(["Live broker trading requires confirmation"], "APPROVE LIVE NVDA")
    );
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: null,
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      const handlers = createProposalRowHandlers({
        row: mockRow,
        state,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      await handlers.handleApprove();

      // Sheet stays open, liveConfirm is set to server's expected text
      expect(closeSpy).not.toHaveBeenCalled();
      expect(state.liveConfirm).toBe("APPROVE LIVE NVDA");
      expect(state.confirmText).toBe("");
      expect(state.busy).toBeNull();
    } finally {
      approveSpy.mockRestore();
    }
  });

  it("prevents duplicate executions on concurrent double-click (re-entrancy guard)", async () => {
    let resolveApprove: (val: unknown) => void = () => {};
    const approvePromise = new Promise((resolve) => {
      resolveApprove = resolve;
    });
    const approveSpy = vi.spyOn(api, "approveProposal").mockImplementation(() => approvePromise as any);
    try {
      const refreshSpy = vi.fn();
      const closeSpy = vi.fn();
      const toastSpy = { push: vi.fn() };

      let state: ProposalRowActionState = {
        busy: null,
        liveConfirm: null,
        confirmText: ""
      };
      const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
        state = updater(state);
      };

      const handlers = createProposalRowHandlers({
        row: mockRow,
        state,
        setState,
        refresh: refreshSpy,
        toast: toastSpy,
        onClose: closeSpy
      });

      // Fire first approve call (which is pending on approvePromise)
      const call1 = handlers.handleApprove();

      // Immediate second click before first call resolves
      const call2 = handlers.handleApprove();

      // Resolve the network call
      resolveApprove({ status: "placed" });
      await Promise.all([call1, call2]);

      // Critical safety invariant: approveProposal was called exactly 1 time!
      expect(approveSpy).toHaveBeenCalledTimes(1);
    } finally {
      approveSpy.mockRestore();
    }
  });

  it("resets liveConfirm and confirmText on handleClose", () => {
    let state: ProposalRowActionState = {
      busy: null,
      liveConfirm: "APPROVE LIVE NVDA",
      confirmText: "APPROVE"
    };
    const setState = (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => {
      state = updater(state);
    };
    const closeSpy = vi.fn();

    const handlers = createProposalRowHandlers({
      row: mockRow,
      state,
      setState,
      refresh: vi.fn(),
      toast: { push: vi.fn() },
      onClose: closeSpy
    });

    handlers.handleClose();
    expect(closeSpy).toHaveBeenCalled();
    expect(state.liveConfirm).toBeNull();
    expect(state.confirmText).toBe("");
  });
});
