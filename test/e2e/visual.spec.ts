import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Visual regression — full-page screenshot assertions with committed baselines
 * (test/e2e/visual.spec.ts-snapshots/). Chromium-desktop only; the mobile-chrome
 * project skips these (skip in a fixture-free beforeEach, so no browser launches).
 *
 * Deterministic controls:
 * - `reducedMotion: "reduce"` + a style tag that kills CSS animations/transitions
 *   and hides the text caret, so renders settle before the screenshot.
 * - `toHaveScreenshot({ animations: "disabled" })` fast-forwards anything left.
 * - Network is hermetic: any request leaving 127.0.0.1 is aborted, so no
 *   third-party resource can shift pixels or hang the run.
 * - Live regions are masked: equity/benchmark chart figures (SVG paths drawn
 *   from live data), countdown clocks ("Next …"), and the day-PnL baseline
 *   date label. Everything else asserts pixel-stable across runs.
 * - ConsentGate is accepted before screenshotting, exactly like the smoke spec.
 */

test.describe("visual regression", () => {
  // Skip is here (not in the test bodies): the hook takes NO fixtures, so a
  // skipped mobile-chrome run never launches a browser. (Destructuring `page`
  // anywhere before the skip — in a hook signature or a test signature —
  // forces the browser to launch first.)
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "visual baselines are chromium-desktop only",
    );
  });

  async function setupDeterministicPage(page: Page): Promise<void> {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Hermetic network: the app must render from 127.0.0.1 only.
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  }

  async function acceptConsentIfShown(
    page: Page,
    visibleTimeoutMs = 30_000,
  ): Promise<void> {
    // The gate renders only after its /api/legal-notice + /api/consent fetches
    // resolve ("loading" -> "needed"/"done"), which a slow dev compile can
    // delay past a short wait — so the default budget is generous. Callers do
    // a final short sweep right before the screenshot: by then the gate has
    // resolved, so a late-appearing modal can't slip into the baseline.
    const consent = page.getByRole("dialog", {
      name: "Terms, Privacy, and Shared Data",
    });
    try {
      await consent.waitFor({ state: "visible", timeout: visibleTimeoutMs });
    } catch {
      return;
    }
    await consent.getByRole("button", { name: /Accept & Continue/ }).click();
    await expect(consent).toBeHidden({ timeout: 15_000 });
  }

  async function freezeMotion(page: Page): Promise<void> {
    await page.addStyleTag({
      content: [
        "*, *::before, *::after {",
        "  animation: none !important;",
        "  transition: none !important;",
        "  caret-color: transparent !important;",
        "}",
        "html { scroll-behavior: auto !important; }",
      ].join("\n"),
    });
  }

  /** Locators for regions whose pixels legitimately change between runs. */
  function liveMasks(page: Page): Locator[] {
    return [
      // Equity + benchmark charts: SVG paths drawn from live data, plus
      // captions carrying live money/time values.
      page.locator("figure:has(svg[role='img'])"),
      // Countdown clocks: "Next 4m 12s · 15m cadence" / "Next scheduled run …".
      page.locator("span", { hasText: /^Next( scheduled run)? / }),
      // Day-PnL baseline label carries a calendar date ("comparing to Sep 26").
      page.locator("div", { hasText: /^No recent baseline — comparing to/ }),
      // Desktop freshness strip: "Data as of 3:27:23 PM", stream state,
      // relative push/scan times, and the market session ("Market: closed"
      // flips with the time of day). The whole strip is time-dependent.
      page.locator('div.hidden[class*="lg:block"]', {
        has: page.locator('span[title^="When this console last fetched data"]'),
      }),
      // Live macro board: Regime / Market Breadth / VIX come from the
      // server-side macro feed and vary between runs (and between "Unknown
      // (no macro feed)" and a populated board).
      page.locator(
        "section.con-card",
        { has: page.locator("h2.con-card-title", { hasText: "Market Analysis" }) },
      ),
    ];
  }

  async function assertStableScreenshot(
    page: Page,
    name: string,
    masks: Locator[] = [],
  ): Promise<void> {
    await freezeMotion(page);
    // In dev the Next compile-status pill ("Compiling …") is a fixed overlay;
    // it never exists in the production build CI screenshots, so settle it
    // out before asserting. Resolves immediately when absent.
    await page
      .getByText("Compiling", { exact: false })
      .first()
      .waitFor({ state: "hidden", timeout: 60_000 })
      .catch(() => {});
    await expect(page).toHaveScreenshot(name, {
      fullPage: true,
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
      mask: masks,
      timeout: 30_000,
    });
  }

  test("console autonomy desk", async ({ page }) => {
    await setupDeterministicPage(page);
    await page.goto("/console", { waitUntil: "domcontentloaded" });

    // Same readiness gate as the smoke spec: the intro shell renders no text
    // until /api/dashboard returns (upstreams deadline-bounded 4-8s each,
    // awaited sequentially — 30s budget is legitimate, not an SLA).
    await expect(page.getByText("Socratic Trade").first()).toBeVisible({
      timeout: 30_000,
    });
    await acceptConsentIfShown(page);
    await expect(page.getByText("Portfolio").first()).toBeVisible();
    await expect(page.getByText("Decision").first()).toBeVisible();
    // Final sweep: the gate has resolved by now; fail loudly instead of
    // screenshotting a late-appearing modal into the baseline.
    await acceptConsentIfShown(page, 5_000);

    await assertStableScreenshot(page, "console-autonomy-desk.png", liveMasks(page));
  });

  test("login page", async ({ page }) => {
    await setupDeterministicPage(page);
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });

    await assertStableScreenshot(page, "login.png");
  });
});
