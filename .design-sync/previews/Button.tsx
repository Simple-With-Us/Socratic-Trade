import { Button } from "socratic-trade-dashboard";

export const Variants = () => (
  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
    <Button variant="primary">Place order</Button>
    <Button variant="accentSoft">Review thesis</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="subtle">Details</Button>
    <Button variant="danger">Liquidate</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <Button size="sm" variant="primary">Small</Button>
    <Button size="md" variant="primary">Medium</Button>
  </div>
);

export const Disabled = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <Button variant="primary" disabled>Submitting…</Button>
    <Button variant="ghost" disabled>Unavailable</Button>
  </div>
);
