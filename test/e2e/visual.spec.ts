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
 * - A mask hides pixels but NOT layout, and `fullPage: true` compares image
 *   dimensions before pixels — so the one region whose height tracks live
 *   server-side data (the Market Analysis card) also has its box pinned. See
 *   PINNED_LIVE_HEIGHT_PX.
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

  /**
   * Constant height for the masked live regions whose box also moves.
   *
   * A mask hides PIXELS; the element still lays out at its natural size. Under
   * `fullPage: true` Playwright compares the full-page image dimensions BEFORE
   * any pixel comparison, so a region whose height depends on data fails the
   * whole assertion no matter how high `maxDiffPixelRatio` is set. Pinning the
   * box removes that dependency; the element is masked, so its pixels are
   * painted solid magenta at any height and nothing observable changes.
   *
   * Must be >= the tallest natural height so real content is never clipped.
   */
  const PINNED_LIVE_HEIGHT_PX = 176;

  /**
   * Freeze the layout of masked regions whose HEIGHT varies run to run.
   *
   * The Market Analysis card is the known one: `app/console/page.tsx` returns
   * null when `!macroBoard`, renders "Regime" unconditionally, "Market Breadth"
   * only when `latestScan?.breadthPct != null`, and "VIX" only when
   * `macroBoard.macro?.vix`. That feed is fetched SERVER-side, so `page.route()`
   * cannot pin it — the rollout doc says so explicitly ("mask, don't assume
   * hermeticity"). Measured on the 2026-10-03 run: 171px populated vs 110px
   * empty, a 61px swing that was exactly the fullPage height delta and failed
   * 7 of 8 runs with no real pixel regression anywhere on the page.
   *
   * All three states must land on the same height: populated, partially
   * populated, and absent. When the card is present we pin it; when it is
   * absent there is nothing to pin, so we reserve the slot with a spacer in
   * the same rail. The card is a direct child of the `<aside>` immediately
   * after RiskUtilization (unconditional), so the reservation is stable — and
   * since only the rail's total height is asserted, the exact insertion index
   * does not matter.
   *
   * Only block-level regions belong here — pinning an inline element (the
   * countdown spans, the date label) to a card-sized height would wreck the
   * layout instead of stabilising it.
   */
  async function pinVariableHeightRegions(page: Page): Promise<void> {
    const rail = page
      .locator("aside")
      .filter({ has: page.locator("section.con-card") })
      .first();
    if ((await rail.count()) === 0) return;

    const card = rail.locator("section.con-card", {
      has: page.locator("h2.con-card-title", { hasText: "Market Analysis" }),
    });
    const cardCount = await card.count();
    if (cardCount > 0) {
      for (let i = 0; i < cardCount; i++) {
        await card
          .nth(i)
          .evaluate((el) => el.setAttribute("data-visual-height-pinned", "1"))
          .catch(() => {});
      }
    } else {
      await rail
        .evaluate((el, h) => {
          const spacer = document.createElement("div");
          spacer.setAttribute("data-visual-height-pinned", "1");
          spacer.style.height = `${h}px`;
          el.insertBefore(spacer, el.children[1] ?? null);
        }, PINNED_LIVE_HEIGHT_PX)
        .catch(() => {});
    }

    await page.addStyleTag({
      content: [
        `[data-visual-height-pinned] {`,
        `  height: ${PINNED_LIVE_HEIGHT_PX}px !important;`,
        `  min-height: ${PINNED_LIVE_HEIGHT_PX}px !important;`,
        `  max-height: ${PINNED_LIVE_HEIGHT_PX}px !important;`,
        `  overflow: hidden !important;`,
        `}`,
      ].join("\n"),
    });
  }

  async function assertStableScreenshot(
    page: Page,
    name: string,
    masks: Locator[] = [],
  ): Promise<void> {
    await freezeMotion(page);
    await pinVariableHeightRegions(page);
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
