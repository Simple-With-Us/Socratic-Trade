"use client";

/**
 * Inline SVG diagrams for the /framework page. All node labels arrive as
 * props from the gated content API — nothing framework-descriptive is
 * hardcoded here, so the client bundle carries structure, not prose.
 * Colors come from CSS custom properties (see app/globals.css) so the
 * diagrams theme with light/dark automatically. Follows the layout pattern
 * of app/how-it-works/decision-loop-diagram.tsx: a horizontal loop for wide
 * viewports and a vertical stack for narrow ones.
 */

export type DiagramNode = { lines: [string, string]; tone?: "pos" | "neg" };

function toneStroke(tone: DiagramNode["tone"]): string {
  if (tone === "pos") return "var(--pos)";
  if (tone === "neg") return "var(--neg)";
  return "var(--line-strong)";
}

function toneText(tone: DiagramNode["tone"]): string {
  if (tone === "pos") return "var(--pos)";
  if (tone === "neg") return "var(--neg)";
  return "var(--fg)";
}

/** Closed-loop pipeline: N boxes with forward arrows and a dashed return arrow. */
export function PipelineLoopDiagram({ nodes, label }: { nodes: DiagramNode[]; label: string }) {
  return (
    <div className="max-w-full">
      <HorizontalLoop nodes={nodes} label={label} />
      <VerticalLoop nodes={nodes} label={label} />
    </div>
  );
}

function HorizontalLoop({ nodes, label }: { nodes: DiagramNode[]; label: string }) {
  const boxW = 150;
  const boxH = 78;
  const gap = 26;
  const y = 60;
  const xs = nodes.map((_, i) => 30 + i * (boxW + gap));
  const last = xs[xs.length - 1];
  const first = xs[0];
  const width = last + boxW + 30;

  return (
    <svg
      viewBox={`0 0 ${width} 250`}
      className="hidden w-full sm:block"
      role="img"
      aria-label={label}
    >
      <defs>
        <marker id="fw-arrow-h" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {xs.slice(0, -1).map((x, i) => (
        <line
          key={`arrow-${i}`}
          x1={x + boxW}
          y1={y + boxH / 2}
          x2={xs[i + 1] - 6}
          y2={y + boxH / 2}
          stroke="var(--accent)"
          strokeWidth={2}
          markerEnd="url(#fw-arrow-h)"
        />
      ))}

      {/* Return arrow: last node feeds the first again */}
      <path
        d={`M${last + boxW / 2},${y + boxH} C${last + boxW / 2},${y + boxH + 66} ${first + boxW / 2},${y + boxH + 66} ${first + boxW / 2},${y + boxH + 6}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeDasharray="6 5"
        markerEnd="url(#fw-arrow-h)"
      />

      {nodes.map((node, i) => {
        const x = xs[i];
        return (
          <g key={node.lines.join(" ")}>
            <rect x={x} y={y} width={boxW} height={boxH} rx={16} fill="var(--surface)" stroke={toneStroke(node.tone)} strokeWidth={2} />
            <text x={x + boxW / 2} y={y + boxH / 2 - 6} textAnchor="middle" fontSize={15} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[0]}
            </text>
            <text x={x + boxW / 2} y={y + boxH / 2 + 15} textAnchor="middle" fontSize={15} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[1]}
            </text>
            <circle cx={x} cy={y} r={13} fill="var(--accent)" stroke="var(--bg)" strokeWidth={3} />
            <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={12} fontWeight={700} fill="var(--accent-fg)">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function VerticalLoop({ nodes, label }: { nodes: DiagramNode[]; label: string }) {
  const boxW = 280;
  const boxH = 66;
  const gap = 24;
  const x = 20;
  const ys = nodes.map((_, i) => 20 + i * (boxH + gap));
  const last = ys[ys.length - 1];
  const first = ys[0];
  const returnX = x + boxW + 96;
  const height = last + boxH + 20;

  return (
    <svg
      viewBox={`0 0 430 ${height}`}
      className="mx-auto block w-full max-w-xs sm:hidden"
      role="img"
      aria-label={label}
    >
      <defs>
        <marker id="fw-arrow-v" markerWidth="8" markerHeight="8" refX="4" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,0 L4,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {ys.slice(0, -1).map((yy, i) => (
        <line
          key={`arrow-${i}`}
          x1={x + boxW / 2}
          y1={yy + boxH}
          x2={x + boxW / 2}
          y2={ys[i + 1] - 6}
          stroke="var(--accent)"
          strokeWidth={2}
          markerEnd="url(#fw-arrow-v)"
        />
      ))}

      <path
        d={`M${x + boxW},${last + boxH / 2} C${returnX},${last + boxH / 2} ${returnX},${first + boxH / 2} ${x + boxW + 6},${first + boxH / 2}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeDasharray="6 5"
        markerEnd="url(#fw-arrow-v)"
      />

      {nodes.map((node, i) => {
        const yy = ys[i];
        return (
          <g key={node.lines.join(" ")}>
            <rect x={x} y={yy} width={boxW} height={boxH} rx={16} fill="var(--surface)" stroke={toneStroke(node.tone)} strokeWidth={2} />
            <text x={x + boxW / 2} y={yy + boxH / 2 - 6} textAnchor="middle" fontSize={15} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[0]}
            </text>
            <text x={x + boxW / 2} y={yy + boxH / 2 + 15} textAnchor="middle" fontSize={15} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[1]}
            </text>
            <circle cx={x} cy={yy} r={13} fill="var(--accent)" stroke="var(--bg)" strokeWidth={3} />
            <text x={x} y={yy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={12} fontWeight={700} fill="var(--accent-fg)">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Vertical layer stack with a dashed feedback arrow from the bottom layer to the top. */
export function LayerStackDiagram({ layers, label }: { layers: { name: string }[]; label: string }) {
  const boxW = 300;
  const boxH = 52;
  const gap = 18;
  const x = 24;
  const ys = layers.map((_, i) => 18 + i * (boxH + gap));
  const last = ys[ys.length - 1];
  const first = ys[0];
  const returnX = x + boxW + 76;
  const height = last + boxH + 18;

  return (
    <svg
      viewBox={`0 0 430 ${height}`}
      className="mx-auto block w-full max-w-sm"
      role="img"
      aria-label={label}
    >
      <defs>
        <marker id="fw-arrow-s" markerWidth="8" markerHeight="8" refX="4" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,0 L4,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {ys.slice(0, -1).map((yy, i) => (
        <line
          key={`arrow-${i}`}
          x1={x + boxW / 2}
          y1={yy + boxH}
          x2={x + boxW / 2}
          y2={ys[i + 1] - 6}
          stroke="var(--accent)"
          strokeWidth={2}
          markerEnd="url(#fw-arrow-s)"
        />
      ))}

      {/* Feedback: the learning layer feeds evidence back to the top */}
      <path
        d={`M${x + boxW},${last + boxH / 2} C${returnX},${last + boxH / 2} ${returnX},${first + boxH / 2} ${x + boxW + 6},${first + boxH / 2}`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeDasharray="6 5"
        markerEnd="url(#fw-arrow-s)"
      />

      {layers.map((layer, i) => {
        const yy = ys[i];
        return (
          <g key={layer.name}>
            <rect x={x} y={yy} width={boxW} height={boxH} rx={12} fill="var(--surface)" stroke="var(--line-strong)" strokeWidth={2} />
            <text x={x + boxW / 2} y={yy + boxH / 2 + 1} textAnchor="middle" dominantBaseline="middle" fontSize={15} fontWeight={600} fill="var(--fg)">
              {layer.name}
            </text>
            <circle cx={x} cy={yy} r={12} fill="var(--accent)" stroke="var(--bg)" strokeWidth={3} />
            <text x={x} y={yy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight={700} fill="var(--accent-fg)">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Circular flywheel: nodes around a labeled hub, arrows running clockwise. */
export function FlywheelDiagram({ nodes, center, label }: { nodes: DiagramNode[]; center: [string, string]; label: string }) {
  const size = 460;
  const cx = size / 2;
  const cy = size / 2;
  const r = 158;
  const boxW = 128;
  const boxH = 52;
  const n = nodes.length;

  const positions = nodes.map((_, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block w-full max-w-md" role="img" aria-label={label}>
      <defs>
        <marker id="fw-arrow-f" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* Clockwise arc arrows between consecutive nodes */}
      {positions.map((p, i) => {
        const next = positions[(i + 1) % n];
        const a1 = Math.atan2(p.y - cy, p.x - cx);
        const a2raw = Math.atan2(next.y - cy, next.x - cx);
        const a2 = a2raw < a1 ? a2raw + 2 * Math.PI : a2raw;
        const pad = 0.42; // radians of clearance around each box
        const start = a1 + pad;
        const end = a2 - pad;
        if (end <= start) return null;
        const sx = cx + r * Math.cos(start);
        const sy = cy + r * Math.sin(start);
        const ex = cx + r * Math.cos(end);
        const ey = cy + r * Math.sin(end);
        return (
          <path
            key={`arc-${i}`}
            d={`M${sx},${sy} A${r},${r} 0 0 1 ${ex},${ey}`}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            markerEnd="url(#fw-arrow-f)"
          />
        );
      })}

      {/* Hub */}
      <circle cx={cx} cy={cy} r={64} fill="var(--surface)" stroke="var(--line-strong)" strokeWidth={2} />
      <text x={cx} y={cy - 7} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--muted)">
        {center[0]}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--muted)">
        {center[1]}
      </text>

      {positions.map((p, i) => {
        const node = nodes[i];
        return (
          <g key={node.lines.join(" ")}>
            <rect x={p.x - boxW / 2} y={p.y - boxH / 2} width={boxW} height={boxH} rx={12} fill="var(--surface)" stroke={toneStroke(node.tone)} strokeWidth={2} />
            <text x={p.x} y={p.y - 4} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[0]}
            </text>
            <text x={p.x} y={p.y + 13} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={toneText(node.tone)}>
              {node.lines[1]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
