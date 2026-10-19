"use client";

/**
 * Client-side renderer for the /framework page. The page's server HTML
 * contains only a shell — this component fetches the actual content from the
 * gated API after confirming it is running in a real, non-automated browser,
 * so the framework prose never appears in the document payload served to
 * crawlers and HTTP clients.
 *
 * Only chrome lives in this file: section headings, the table of contents,
 * and the section ids it links to.  Every piece of framework prose comes from
 * the server-only content module and arrives as a prop.
 */

import { useEffect, useState } from "react";
import { Card } from "../ui/primitives";
import type { FrameworkContent } from "./content";
import { PipelineLoopDiagram, LayerStackDiagram, FlywheelDiagram } from "./framework-diagrams";
import { DecisionLoopDiagram } from "./decision-loop-diagram";

type LoadState =
  | { phase: "loading" }
  | { phase: "unavailable" }
  | { phase: "ready"; content: FrameworkContent };

/** In-page table of contents. Keep in step with the section ids below. */
const PAGE_SECTIONS: { id: string; label: string }[] = [
  { id: "questions", label: "The Questions This Framework Answers" },
  { id: "plain-loop", label: "The Plain-Language Loop" },
  { id: "pipeline", label: "The Pipeline, End to End" },
  { id: "principles", label: "Design Principles" },
  { id: "layers", label: "The Layered Architecture" },
  { id: "decision-core", label: "The Decision Core" },
  { id: "case-file", label: "The Decision Case File" },
  { id: "authority", label: "Authority and Overrides" },
  { id: "learning", label: "The Learning Flywheel" },
  { id: "outcome-review", label: "Outcome Review Lenses" },
  { id: "autonomy", label: "Autonomy and Safety Rails" },
  { id: "resilience", label: "Operational Resilience" },
  { id: "invariants", label: "The Laws of The System" },
  { id: "limits", label: "Honest Limits" },
  { id: "disclosures", label: "Important Disclosures" }
];

function passesBrowserChecks(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  // Automation frameworks (Selenium/Puppeteer/Playwright) flag themselves here.
  if (navigator.webdriver) return false;
  if (!navigator.userAgent) return false;
  return true;
}

let cachedFrameworkContent: FrameworkContent | null = null;

export function FrameworkViewer() {
  const [state, setState] = useState<LoadState>(() =>
    cachedFrameworkContent ? { phase: "ready", content: cachedFrameworkContent } : { phase: "loading" }
  );

  useEffect(() => {
    let cancelled = false;
    if (cachedFrameworkContent) return;
    if (!passesBrowserChecks()) {
      setState({ phase: "unavailable" });
      return;
    }

    const loadContent = async () => {
      try {
        const res = await fetch("/api/framework/content", {
          headers: { "x-framework-viewer": "1" },
          cache: "default"
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { content: FrameworkContent };
        cachedFrameworkContent = data.content;
        if (!cancelled) setState({ phase: "ready", content: data.content });
      } catch {
        if (!cancelled) setState({ phase: "unavailable" });
      }
    };

    void loadContent();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="py-24 text-center text-sm text-muted" role="status">
        Loading the framework&hellip;
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="py-24 text-center text-sm text-muted">
        This page is available to human readers in a standard web browser.  If you are seeing this
        message in one, please reload the page.
      </div>
    );
  }

  const c = state.content;

  return (
    <div className="space-y-14">
      <section id="overview" className="space-y-5 scroll-mt-24">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">{c.kicker}</p>
        <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">{c.title}</h1>
        {c.intro.map((p) => (
          <p key={p.slice(0, 32)} className="max-w-3xl text-lg leading-relaxed text-muted">
            {p}
          </p>
        ))}
      </section>

      <nav aria-label="On This Page" className="rounded-2xl border border-line bg-surface/80 p-5">
        <h2 className="text-sm font-semibold text-fg">On This Page</h2>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {PAGE_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="rounded-sm text-sm text-muted underline underline-offset-2 transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="questions" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Questions This Framework Answers</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          The framework is built around seven questions you can ask of any decision, and each one has a
          defined home in the pipeline below.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.questions.map((item) => (
            <Card key={item.question} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.question}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.answer}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="plain-loop" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Plain-Language Loop</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Six plain-language verbs, each one mapped to the pipeline stage that carries it out.
        </p>
        <Card className="p-5 sm:p-8">
          <DecisionLoopDiagram />
        </Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.plainLoop.map((item) => (
            <Card key={item.verb} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.verb}</h3>
              <p className="text-xs leading-relaxed text-muted">{item.stage}</p>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="pipeline" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Pipeline, End to End</h2>
        <Card className="p-5 sm:p-8">
          <PipelineLoopDiagram
            nodes={c.pipelineDiagram}
            label="The trading pipeline: observe the market, assemble evidence, Green Team proposes, code sizes the trade, Red Team challenges, policy gate decides, broker executes, account and learn — then back to observing."
          />
        </Card>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.pipeline.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="principles" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Design Principles</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.principles.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="layers" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">{c.layersHeading}</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.layersIntro}</p>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
          <Card className="p-5 sm:p-6">
            <LayerStackDiagram
              layers={c.layers}
              label="Layer stack from market observation down to learning, with learning feeding evidence back to the top."
            />
          </Card>
          <div className="space-y-3">
            {c.layers.map((layer, i) => (
              <Card key={layer.name} className="p-4">
                <p className="text-sm leading-relaxed text-muted">
                  <span className="font-semibold text-fg">
                    {i + 1}. {layer.name}.
                  </span>{" "}
                  {layer.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="decision-core" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Decision Core</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.decisionCoreIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.decisionCore.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="case-file" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Decision Case File</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.caseFileIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.caseFile.map((item) => (
            <Card key={item.name} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.name}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="authority" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Authority and Overrides</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.authorityIntro}</p>
        <Card className="p-5">
          <ul className="space-y-2">
            {c.authority.map((item) => (
              <li key={item} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section id="learning" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Learning Flywheel</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.learningIntro}</p>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
          <Card className="p-5 sm:p-6">
            <FlywheelDiagram
              nodes={c.flywheelNodes}
              center={c.flywheelCenter}
              label="Learning flywheel: decisions and fills feed event-sourced accounting, scorecards and calibration, counterfactuals and memory, validated tuning, and better evidence — cycling back into decisions, with every mutation ledgered, audited, and revertible."
            />
          </Card>
          <div className="space-y-3">
            {c.learningLanes.map((item) => (
              <Card key={item.title} className="p-4 space-y-1.5">
                <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{item.body}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="outcome-review" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Outcome Review Lenses</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.outcomeIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.outcomeLenses.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="autonomy" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Autonomy and Safety Rails</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.autonomyIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.autonomy.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="resilience" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Operational Resilience</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.resilienceIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.resilience.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="invariants" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">The Laws of The System</h2>
        <p className="text-sm leading-relaxed text-muted">{c.invariantsIntro}</p>
        <Card className="p-5">
          <ul className="space-y-2">
            {c.invariants.map((item) => (
              <li key={item} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section id="limits" className="space-y-5 scroll-mt-24">
        <h2 className="text-xl font-semibold text-fg">Honest Limits</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{c.limitsIntro}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {c.limits.map((item) => (
            <Card key={item.title} className="p-5 space-y-2">
              <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="disclosures" className="scroll-mt-24">
        <Card className="p-6 space-y-4 border-line-strong">
          <h2 className="text-base font-semibold text-fg">Important Disclosures</h2>
          {c.disclosures.map((p) => (
            <p key={p.slice(0, 32)} className="text-sm leading-relaxed text-muted">
              {p}
            </p>
          ))}
          <p className="text-xs leading-relaxed text-faint">{c.humanOnlyNote}</p>
        </Card>
      </section>
    </div>
  );
}
