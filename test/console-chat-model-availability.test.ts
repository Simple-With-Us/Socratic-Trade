import { describe, expect, it } from "vitest";
import { chatCredentialServiceForModel, chatModelHasCredential } from "../app/console/assistant/chat";

describe("Coach model credential availability", () => {
  it("requires OpenRouter for OpenRouter-only OpenAI and Meta models", () => {
    const status = { openai: true, meta: true, openrouter: false };

    expect(chatCredentialServiceForModel("gpt-6-astra-pro", status)).toBe("openrouter");
    expect(chatModelHasCredential("gpt-6-astra-pro", status)).toBe(false);
    expect(chatCredentialServiceForModel("muse-spark-1.3", status)).toBe("openrouter");
    expect(chatModelHasCredential("muse-spark-1.3", status)).toBe(false);
  });

  it("allows MiniMax through OpenRouter before its native fallback", () => {
    const openRouterOnly = { minimax: false, openrouter: true };
    expect(chatCredentialServiceForModel("minimax-m3.1-flash", openRouterOnly)).toBe("openrouter");
    expect(chatModelHasCredential("minimax-m3.1-flash", openRouterOnly)).toBe(true);

    const nativeOnly = { minimax: true, openrouter: false };
    expect(chatCredentialServiceForModel("minimax-m3.1-flash", nativeOnly)).toBe("minimax");
    expect(chatModelHasCredential("minimax-m3.1-flash", nativeOnly)).toBe(true);

    expect(chatModelHasCredential("minimax-m3.1-flash", { minimax: false, openrouter: false })).toBe(false);
  });

  it("does not native-fallback an explicitly OpenRouter-routed MiniMax id", () => {
    const status = { minimax: true, openrouter: false };
    const model = "openrouter/minimax/minimax-m3.1-flash";

    expect(chatCredentialServiceForModel(model, status)).toBe("openrouter");
    expect(chatModelHasCredential(model, status)).toBe(false);
    expect(chatCredentialServiceForModel(" OpenRouter/minimax/minimax-m3.1-flash ", status)).toBe("openrouter");
  });

  it("fails open while provider status is unavailable", () => {
    expect(chatModelHasCredential("gpt-6-astra-pro", {})).toBe(true);
    expect(chatModelHasCredential("minimax-m3.1-flash", {})).toBe(true);
    expect(chatModelHasCredential("minimax-m3.1-flash", { minimax: false })).toBe(true);
  });
});
