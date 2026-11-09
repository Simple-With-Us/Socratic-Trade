import { expect, test, type Page } from "@playwright/test";
import { installPlaywrightAdminSession } from "./playwright-session";

async function setupDeterministicPage(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
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

test("admin enrichment coverage retired lanes footnote", async ({ page, context }) => {
  await installPlaywrightAdminSession(context);
  await setupDeterministicPage(page);
  await page.route("**/api/admin/enrichment-coverage**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        available: true,
        history: [],
        report: {
          asOf: "2026-10-15T12:00:00.000Z",
          symbolCount: 2,
          retiredLaneFields: [
            "congressTradesQuiver",
            "insiderTradesQuiver",
            "govContractsQuiver",
            "lobbyingQuiver",
            "patentsQuiver"
          ],
          fields: [
            {
              field: "peRatio",
              filledCount: 2,
              totalSymbols: 2,
              fillRate: 1,
              winningSources: { "yahoo-finance": 2 },
              mostFrequentSource: "yahoo-finance",
              missingSymbols: []
            }
          ],
          missingFields: ["eps"],
          partialFields: [],
          sourceWinTotals: { "yahoo-finance": 2 },
          providerFailures: [],
          contributingSources: ["yahoo-finance"],
          headlines: {
            field: "headlines",
            filledCount: 1,
            totalSymbols: 2,
            fillRate: 0.5,
            winningSources: { "alpaca-news": 1 },
            mostFrequentSource: "alpaca-news",
            missingSymbols: ["MSFT"]
          }
        }
      })
    });
  });

  await page.goto("/admin/enrichment-coverage", { waitUntil: "domcontentloaded" });
  const footnote = page.getByTestId("enrichment-coverage-retired-lanes");
  await expect(footnote).toBeVisible({ timeout: 30_000 });
  await expect(footnote).toContainText("congressTradesQuiver");
  await freezeMotion(page);
  await expect(footnote).toHaveScreenshot("enrichment-coverage-retired-lanes-footnote.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01
  });
});
