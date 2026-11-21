import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { BenchmarkChart } from "../app/console/components/benchmark-chart";
import * as display from "../app/console/lib/cash-flow-display";
import * as format from "../app/console/lib/format";

const require = createRequire(import.meta.url);
const results = readFileSync(new URL("../app/console/results/page.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../app/console/page.tsx", import.meta.url), "utf8");
const noop = () => null;
const pass = ({ children }: any) => React.createElement("div", null, children);
const Stat = ({ label, value, sub, title }: any) => React.createElement("div", { title }, label, value, sub);
const Card = ({ title, children }: any) => React.createElement("section", null, title, children);
function render(fragment: string, scope: Record<string, unknown>) {
  const input = `export function Fixture() { return (${fragment}); }`;
  const output = ts.transpileModule(input, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  const bindings = { ...display, ...format, Stat, Card, SignedText: pass, Chip: pass, Dash: noop, BenchmarkChart: noop, Link: pass, TrendingUp: noop, ArrowRight: noop, cx: (...args: any[]) => args.filter(Boolean).join(" "), ...scope };
  new Function("require", "exports", ...Object.keys(bindings), output)(require, exports, ...Object.values(bindings));
  return renderToStaticMarkup(React.createElement(exports.Fixture));
}
function benchmark(source?: "broker" | "inferred") {
  return { cashFlowSource: source, benchmarkSymbol: "SPY", accountReturnPct: -0.14, benchmarkReturnPct: 0.2, excessReturnPct: -0.34,
    startDate: "2026-11-18", endDate: "2026-11-20", points: 3, shadowValue: 101200, dollarExcess: -337.55,
    cashFlowAdjusted: true, netExternalFlows: 1000, accountEquitySeries: [], shadowBenchmarkSeries: [],
    subPeriods: [1,2].map((i) => ({startDate: `2026-11-${17+i}`,endDate:`2026-11-${18+i}`,startEquity:100000,endEquity:101000,externalFlow:1000,accountReturnPct:-0.14,benchmarkReturnPct:0.2})) };
}
const benchmarkStart = results.indexOf('      <Card title={externalFlowDisplayAvailable(perf?.benchmark)');
const benchmarkEnd = results.indexOf('        ) : perf?.benchmarkUnavailable ?', benchmarkStart);
const resultsFragment = results.slice(benchmarkStart, benchmarkEnd) + ' ) : null}</Card>';
const dayStart = home.indexOf('              <div>\n                <div className="con-card-title">Day P&amp;L');
const dayEnd = home.indexOf('\n              <Stat label="Cash"', dayStart);
const dayFragment = home.slice(dayStart, dayEnd);
const vsStart = home.indexOf('    <Card', home.indexOf('function VsMarketCard'));
const vsEnd = home.indexOf('\n    </Card>', vsStart) + '\n    </Card>'.length;
const vsFragment = home.slice(vsStart, vsEnd);

describe("actual page JSX wiring and timing copy", () => {
  it("renders the shared chart with neutral hover copy and unchanged dollar gap", () => {
    const dates = ["2026-11-19", "2026-11-20"];
    const html = renderToStaticMarkup(React.createElement(BenchmarkChart, {
      account: dates.map((date, i) => ({ date, value: 100000 - i * 100 })),
      shadow: dates.map((date, i) => ({ date, value: 100000 + i * 100 })),
      accountLabel: "Account", benchmarkLabel: "SPY"
    }));
    expect(html).toContain("existing SPY comparison model");
    expect(html).toContain("inferred adjustments with unverified cash-flow timing");
    expect(html).not.toContain("same-cash");
    expect(html).toContain("-$200.00");
  });
  for (const source of [undefined, "inferred"] as const) it(`withholds inferred or legacy Results amounts and qualifies every tooltip (${source})`, () => {
    const html = render(resultsFragment, { perf: { benchmark: benchmark(source) } });
    expect(html).toContain("External cash flow unavailable");
    expect(html).toContain("Snapshot Comparison Windows");
    expect(html.match(/>Unavailable</g)?.length).toBe(2);
    expect(html).not.toContain("deposit $1,000.00");
    expect(html).not.toContain("Net applied broker-ledger flow");
    expect(html).not.toContain("same deposits and withdrawals");
    expect(html).not.toContain("Same-Cash S&amp;P");
    expect(html.match(/title="Existing comparison model/g)?.length).toBe(5);
    expect(html).toContain("-0.14%"); // Numerical return stays, with caveat, not repaired.
  });
  it("preserves broker amounts and distinguishes convention from actual timing", () => {
    const html = render(resultsFragment, { perf: { benchmark: benchmark("broker") } });
    expect(html).toContain("deposit $1,000.00");
    expect(html).toContain("+$1,000.00");
    expect(html).toContain("rather than verified intraday timing");
    expect(html).not.toContain("External cash flow unavailable");
  });
  for (const source of [undefined, "inferred", "broker"] as const) it(`wires console Day P&L and benchmark explanation (${source})`, () => {
    const dayPnl = { pnl:-137.55,pct:-0.14,baselineAt:"2026-11-19T20:00:00Z",baselineEquity:100000,isStaleBaseline:false,cashFlowSource:source };
    const dayPnlAvailable = display.dayPnlDisplayAvailable(dayPnl, source === "broker" ? { todayBrokerFlow: 0 } : undefined);
    const html = render(dayFragment, { dayPnl, dayPnlAvailable });
    expect(html.includes("Unavailable")).toBe(source !== "broker");
    expect(html.includes("-$137.55")).toBe(source === "broker");
    const b = benchmark(source);
    const vs = render(vsFragment, { benchmark:b, symbol:"SPY" });
    expect(vs).not.toContain("Same deposits and withdrawals as this account");
    expect(vs.includes("Cash-flow timing is not verified")).toBe(source !== "broker");
  });
  it("keeps the raw equity chart note neutral rather than promising corrected transfers", () => {
    expect(results).not.toContain("The market comparison below adjusts for detected transfers");
    expect(results).toContain("a balance change alone does not establish a transfer");
  });
});
