import { ConBtn } from "socratic-trade-dashboard";

// Console primitives are styled by `con-*` classes whose tokens live under
// `.console-root` — every preview must render inside that wrapper.
export const Variants = () => (
  <div className="console-root" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: 4 }}>
    <ConBtn variant="primary">Approve</ConBtn>
    <ConBtn variant="pos">Buy</ConBtn>
    <ConBtn variant="outline">Details</ConBtn>
    <ConBtn variant="ghost">Dismiss</ConBtn>
    <ConBtn variant="danger">Liquidate</ConBtn>
    <ConBtn variant="dangerOutline">Cancel order</ConBtn>
  </div>
);

export const Small = () => (
  <div className="console-root" style={{ display: "flex", gap: 12, alignItems: "center", padding: 4 }}>
    <ConBtn variant="primary" size="sm">Approve</ConBtn>
    <ConBtn variant="outline" size="sm">Skip</ConBtn>
  </div>
);
