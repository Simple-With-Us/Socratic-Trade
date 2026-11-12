import { describe, expect, it } from "vitest";
import {
  applyDocumentTheme,
  readThemeChoice,
  resolveTheme,
  syncDocumentTheme,
  themeInitScript,
  type ResolvedTheme,
  type ThemeChoice
} from "../app/ui/theme";

/**
 * `.dark` and `data-theme` are two readers of one resolved theme.
 * Every writer (the setter, the boot script, and a system-preference change)
 * has to leave them equal. A split pair is what paints some surfaces light
 * and others dark.
 */

type FakeElement = {
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
};

function fakeDocument(options?: { stored?: string | null; throwOnRead?: boolean; systemDark?: boolean; seedSplit?: boolean }) {
  const rootClass = { dark: options?.seedSplit === true };
  const root: FakeElement & {
    classList: { toggle: (name: string, force: boolean) => void; remove: (name: string) => void; contains: (name: string) => boolean };
    dataset: { theme?: string };
  } = {
    classList: {
      toggle(name: string, force: boolean) {
        if (name === "dark") rootClass.dark = force;
      },
      remove(name: string) {
        if (name === "dark") rootClass.dark = false;
      },
      contains(name: string) {
        return name === "dark" && rootClass.dark;
      }
    },
    dataset: { theme: options?.seedSplit ? "light" : undefined },
    setAttribute(name: string, value: string) {
      if (name === "data-theme") this.dataset.theme = value;
    },
    removeAttribute(name: string) {
      if (name === "data-theme") this.dataset.theme = undefined;
    },
    getAttribute(name: string) {
      if (name === "data-theme") return this.dataset.theme ?? null;
      return null;
    }
  };
  const consoleRoot: FakeElement = {
    theme: "stale",
    setAttribute(name: string, value: string) {
      if (name === "data-theme") this.theme = value;
    },
    removeAttribute(name: string) {
      if (name === "data-theme") this.theme = "";
    },
    getAttribute(name: string) {
      return name === "data-theme" ? this.theme : null;
    }
  } as FakeElement & { theme: string };
  const meta: FakeElement = {
    content: "#ffffff",
    media: "(prefers-color-scheme: dark)",
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
    removeAttribute(name: string) {
      if (name === "media") this.media = "";
    },
    getAttribute(name: string) {
      if (name === "content") return this.content;
      if (name === "media") return this.media || null;
      return null;
    }
  } as FakeElement & { content: string; media: string };

  const doc = {
    documentElement: root,
    querySelectorAll(selector: string) {
      if (selector === ".console-root") return [consoleRoot];
      if (selector === 'meta[name="theme-color"]') return [meta];
      return [];
    }
  };

  return { doc, root, consoleRoot: consoleRoot as FakeElement & { theme: string }, meta: meta as FakeElement & { content: string; media: string }, options };
}

function expectSignalsMatch(root: { classList: { contains: (name: string) => boolean }; dataset: { theme?: string } }, resolved: ResolvedTheme) {
  expect(root.dataset.theme).toBe(resolved);
  expect(root.classList.contains("dark")).toBe(resolved === "dark");
}

describe("applyDocumentTheme", () => {
  it("sets the class and the attribute to the same resolved value", () => {
    for (const resolved of ["light", "dark"] as const) {
      const { doc, root, consoleRoot } = fakeDocument({ seedSplit: true });
      applyDocumentTheme(doc as unknown as Document, resolved);
      expectSignalsMatch(root, resolved);
      expect(consoleRoot.getAttribute("data-theme")).toBe(resolved);
    }
  });

  it("clears a pre-existing split so the two signals cannot disagree", () => {
    const { doc, root } = fakeDocument({ seedSplit: true });
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.theme).toBe("light");
    applyDocumentTheme(doc as unknown as Document, "dark");
    expectSignalsMatch(root, "dark");
    applyDocumentTheme(doc as unknown as Document, "light");
    expectSignalsMatch(root, "light");
  });
});

describe("resolveTheme", () => {
  const cases: Array<[ThemeChoice, boolean, ResolvedTheme]> = [
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
    ["system", true, "dark"],
    ["system", false, "light"]
  ];

  it("maps the stored choice and the system preference onto one resolved theme", () => {
    for (const [choice, systemDark, resolved] of cases) {
      expect(resolveTheme(choice, systemDark)).toBe(resolved);
      const { doc, root, consoleRoot } = fakeDocument();
      applyDocumentTheme(doc as unknown as Document, resolveTheme(choice, systemDark));
      expectSignalsMatch(root, resolved);
      expect(consoleRoot.getAttribute("data-theme")).toBe(resolved);
    }
  });

  it("treats a missing or unknown stored value as light", () => {
    expect(readThemeChoice(null)).toBe("light");
    expect(readThemeChoice("")).toBe("light");
    expect(readThemeChoice("nope")).toBe("light");
    expect(readThemeChoice("dark")).toBe("dark");
    expect(readThemeChoice("system")).toBe("system");
  });
});

describe("themeInitScript", () => {
  function runBoot(stored: string | null | "throw", systemDark: boolean) {
    const { doc, root, consoleRoot } = fakeDocument();
    const localStorage = {
      getItem(key: string) {
        if (stored === "throw") throw new Error("denied");
        return key === "theme" ? stored : null;
      }
    };
    const windowStub = {
      matchMedia(query: string) {
        return { matches: query === "(prefers-color-scheme: dark)" && systemDark };
      }
    };
    const boot = new Function("document", "localStorage", "window", themeInitScript);
    boot(doc, localStorage, windowStub);
    return { root, consoleRoot };
  }

  it("matches syncDocumentTheme for light, dark, and system, including a denied store", () => {
    const storedValues: Array<string | null | "throw"> = ["light", "dark", "system", null, "nope", "throw"];
    for (const stored of storedValues) {
      for (const systemDark of [false, true]) {
        const { doc, root, consoleRoot } = fakeDocument();
        const fromSetter = syncDocumentTheme(
          doc as unknown as Document,
          () => {
            if (stored === "throw") throw new Error("denied");
            return stored;
          },
          systemDark
        );
        expectSignalsMatch(root, fromSetter.resolved);
        expect(consoleRoot.getAttribute("data-theme")).toBe(fromSetter.resolved);

        const booted = runBoot(stored, systemDark);
        expectSignalsMatch(booted.root, fromSetter.resolved);
        expect(booted.consoleRoot.getAttribute("data-theme")).toBe(fromSetter.resolved);
        expect(booted.root.classList.contains("dark")).toBe(booted.root.dataset.theme === "dark");
      }
    }
  });
});
