/**
 * Inline SVG diagram of the decision loop: Market scan -> Green Team proposes ->
 * Red Team challenges -> Policy gate decides -> Broker executes -> Outcomes feed
 * learning -> back to scan. Colors come from CSS custom properties (see
 * app/globals.css) so the diagram themes with light/dark automatically. Two
 * layouts share the same node data — a horizontal loop for wider viewports and a
 * vertical stack for narrow ones (readable down to 360px).
 */

type LoopNode = {
  lines: [string, string];
  tone?: "pos" | "neg";
};

const LOOP_NODES: LoopNode[] = [
  { lines: ["Market", "scan"] },
  { lines: ["Green Team", "proposes"], tone: "pos" },
  { lines: ["Red Team", "challenges"], tone: "neg" },
  { lines: ["Policy gate", "decides"] },
  { lines: ["Broker", "executes"] },
  { lines: ["Outcomes feed", "learning"] }
];

function toneStroke(tone: LoopNode["tone"]): string {
  if (tone === "pos") return "var(--pos)";
  if (tone === "neg") return "var(--neg)";
  return "var(--line-strong)";
}

function toneText(tone: LoopNode["tone"]): string {
  if (tone === "pos") return "var(--pos)";
  if (tone === "neg") return "var(--neg)";
  return "var(--fg)";
}

/** Horizontal loop layout — six boxes left to right with a return arrow underneath. */
function HorizontalLoop() {
  const boxW = 160;
  const boxH = 80;
  const gap = 32;
  const y = 100;
  const xs = LOOP_NODES.map((_, i) => 40 + i * (boxW + gap));
  const last = xs[xs.length - 1];
  const first = xs[0];

  return (
    <svg
      viewBox="0 0 1200 300"
      className="hidden w-full sm:block"
      role="img"
      aria-label="Decision loop: market scan, green team proposes, red team challenges, policy gate decides, broker executes, outcomes feed learning, then back to market scan."
    >
      <defs>
        <marker id="how-it-works-arrow-h" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* Forward arrows between consecutive nodes */}
      {xs.slice(0, -1).map((x, i) => (
        <line
          key={`arrow-${i}`}
          x1={x + boxW}
          y1={y + boxH / 2}
          x2={xs[i + 1] - 6}
          y2={y + boxH / 2}
          stroke="var(--accent)"
          strokeWidth={2}
          markerEnd="url(#how-it-works-arrow-h)"
        />
      ))}

      {/* Return arrow: outcomes feed learning -> back to market scan */}
      <path
        d={`M${last + boxW / 2},${y + boxH} C${last + boxW / 2},${y + boxH + 70} ${first + boxW / 2},${y + boxH + 70} ${first + boxW / 2},${y + boxH + 6}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeDasharray="6 5"
        markerEnd="url(#how-it-works-arrow-h)"
      />

      {LOOP_NODES.map((node, i) => {
        const x = xs[i];
        return (
          <g key={node.lines.join(" ")}>
            <rect
              x={x}
              y={y}
              width={boxW}
              height={boxH}
              rx={16}
              fill="var(--surface)"
              stroke={toneStroke(node.tone)}
              strokeWidth={2}
            />
            <text x={x + boxW / 2} y={y + boxH / 2 - 6} textAnchor="middle" fontSize={16} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[0]}
            </text>
            <text x={x + boxW / 2} y={y + boxH / 2 + 16} textAnchor="middle" fontSize={16} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[1]}
            </text>
            <circle cx={x} cy={y} r={14} fill="var(--accent)" stroke="var(--bg)" strokeWidth={3} />
            <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight={700} fill="var(--accent-fg)">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Vertical loop layout for narrow viewports — six boxes stacked with a return arrow on the right. */
function VerticalLoop() {
  const boxW = 280;
  const boxH = 70;
  const gap = 26;
  const x = 20;
  const ys = LOOP_NODES.map((_, i) => 20 + i * (boxH + gap));
  const last = ys[ys.length - 1];
  const first = ys[0];
  const returnX = x + boxW + 100;

  return (
    <svg
      viewBox="0 0 430 610"
      className="mx-auto block w-full max-w-xs sm:hidden"
      role="img"
      aria-label="Decision loop: market scan, green team proposes, red team challenges, policy gate decides, broker executes, outcomes feed learning, then back to market scan."
    >
      <defs>
        <marker id="how-it-works-arrow-v" markerWidth="8" markerHeight="8" refX="4" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,0 L4,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* Forward arrows between consecutive nodes */}
      {ys.slice(0, -1).map((yy, i) => (
        <line
          key={`arrow-${i}`}
          x1={x + boxW / 2}
          y1={yy + boxH}
          x2={x + boxW / 2}
          y2={ys[i + 1] - 6}
          stroke="var(--accent)"
          strokeWidth={2}
          markerEnd="url(#how-it-works-arrow-v)"
        />
      ))}

      {/* Return arrow: outcomes feed learning -> back to market scan */}
      <path
        d={`M${x + boxW},${last + boxH / 2} C${returnX},${last + boxH / 2} ${returnX},${first + boxH / 2} ${x + boxW + 6},${first + boxH / 2}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeDasharray="6 5"
        markerEnd="url(#how-it-works-arrow-v)"
      />

      {LOOP_NODES.map((node, i) => {
        const yy = ys[i];
        return (
          <g key={node.lines.join(" ")}>
            <rect
              x={x}
              y={yy}
              width={boxW}
              height={boxH}
              rx={16}
              fill="var(--surface)"
              stroke={toneStroke(node.tone)}
              strokeWidth={2}
            />
            <text x={x + boxW / 2} y={yy + boxH / 2 - 6} textAnchor="middle" fontSize={16} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[0]}
            </text>
            <text x={x + boxW / 2} y={yy + boxH / 2 + 16} textAnchor="middle" fontSize={16} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[1]}
            </text>
            <circle cx={x} cy={yy} r={14} fill="var(--accent)" stroke="var(--bg)" strokeWidth={3} />
            <text x={x} y={yy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight={700} fill="var(--accent-fg)">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function DecisionLoopDiagram() {
  return (
    <div className="max-w-full">
      <HorizontalLoop />
      <VerticalLoop />
    </div>
  );
}
