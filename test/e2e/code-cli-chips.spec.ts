import { expect, test } from "@playwright/test";

// Uses the real Connections page/ApiKeysCard. Only status-only API data is a fixture.
// No provider key, broker request or production write is made.
test("integrated API-key route chips show API, ready CLI and unavailable CLI", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const base = { category: "LLM", configured: true, source: "user", unlocks: "Text generation", docsUrl: "", routeToggle: true };
  await page.route("**/api/keys", route => route.fulfill({ json: { keys: [
    { ...base, service: "openrouter", label: "OpenRouter", route: "openrouter", routeToggle: false },
    { ...base, service: "meta", label: "Meta", route: "code-cli", codeCliAvailable: true },
    { ...base, service: "minimax", label: "MiniMax", route: "code-cli", codeCliAvailable: false }
  ] } }));
  await page.route("**/api/consent", route => route.fulfill({ json: { ok: true, accepted: true, needed: false } }));
  await page.goto("/console/connections");
  const consent = page.getByRole("dialog", { name: "Terms, Privacy, and Shared Data" });
  if (await consent.isVisible()) await consent.getByRole("button", { name: /Accept & Continue/ }).click();
  await page.addStyleTag({ content: "canvas { visibility: hidden !important; }" }); // Decorative animated candles, not the card.
  const card = page.locator("section.con-card").filter({ has: page.getByRole("heading", { name: "API keys", exact: true }) });
  await expect(card.getByText("your key", { exact: true })).toBeVisible();
  await expect(card.getByText("server CLI selected", { exact: true })).toBeVisible();
  await expect(card.getByText("server CLI unavailable", { exact: true })).toBeVisible();
  await expect(card.getByLabel("Meta route", { exact: true })).toHaveValue("code-cli");
  await expect(card.getByLabel("MiniMax route", { exact: true })).toHaveValue("code-cli");
  await expect(card.getByLabel("MiniMax route", { exact: true }).locator('option[value="code-cli"]')).toHaveAttribute("disabled", "");
  // Actual pixels are retained as an artifact. Committed CI baselines belong to visual.spec.ts.
  await card.screenshot({ path: test.info().outputPath("api-key-code-cli-chips.png"), animations: "disabled" });
  await test.info().attach("integrated-api-key-chips", { path: test.info().outputPath("api-key-code-cli-chips.png"), contentType: "image/png" });
});
