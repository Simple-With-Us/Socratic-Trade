import { Card } from "socratic-trade-dashboard";

const badgeStyle = (color: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
  color,
  background: `color-mix(in oklab, ${color} 15%, transparent)`
});

export const PositionCard = () => (
  <Card style={{ width: 320, padding: 16 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>NVDA — NVIDIA Corp</div>
      <span style={badgeStyle("var(--pos)")}>+4.2%</span>
    </div>
    <div style={{ marginTop: 8, fontSize: 22, fontWeight: 600 }}>$118.42</div>
    <div style={{ marginTop: 4, fontSize: 12, color: "var(--faint)" }}>142 shares · cost basis $102.10</div>
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ display: "inline-flex", height: 8, width: 8, borderRadius: "50%", background: "var(--pos)" }} />
      <span style={{ fontSize: 12, color: "var(--muted)" }}>Live · updated 2s ago</span>
    </div>
  </Card>
);

export const ThesisCard = () => (
  <Card style={{ width: 340, padding: 16 }}>
    <div style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em", color: "var(--muted)" }}>
      Trade thesis
    </div>
    <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: "var(--fg)" }}>
      AAPL earnings beat plus services revenue acceleration supports a swing long into the
      post-print drift window.
    </p>
    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
      <span style={badgeStyle("var(--accent)")}>Momentum</span>
      <span style={badgeStyle("var(--info)")}>Earnings drift</span>
    </div>
  </Card>
);

export const NestedCards = () => (
  <div style={{ display: "flex", gap: 12 }}>
    <Card style={{ width: 160, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--muted)" }}>
        Day P/L
      </div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 600, color: "var(--up)" }}>+$2,140</div>
    </Card>
    <Card style={{ width: 160, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--muted)" }}>
        Buying power
      </div>
      <div style={{ marginTop: 6, fontSize: 20, fontWeight: 600 }}>$41,905</div>
    </Card>
  </div>
);
