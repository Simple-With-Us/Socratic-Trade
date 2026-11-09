import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const loginPage = readFileSync(resolve("app/login/page.tsx"), "utf8");
const globals = readFileSync(resolve("app/globals.css"), "utf8");

describe("website login provider buttons", () => {
  it("does not put the color Google G on the brand accent fill", () => {
    expect(loginPage).not.toMatch(/bg-accent[^"]*text-accent-fg/);
    expect(loginPage).toContain('className="login-provider-btn"');
  });

  it("uses one shared chrome class for Google, GitHub, and Apple", () => {
    const google = loginPage.match(/Sign in with Google[\s\S]{0,200}login-provider-btn|login-provider-btn[\s\S]{0,200}Sign in with Google/);
    const github = loginPage.match(/login-provider-btn[\s\S]{0,240}Sign in with GitHub/);
    const apple = loginPage.match(/login-provider-btn login-provider-btn--apple[\s\S]{0,240}Sign in with Apple/);
    expect(google).not.toBeNull();
    expect(github).not.toBeNull();
    expect(apple).not.toBeNull();
  });

  it("ships Google's Light/Dark colour table and the official Invertocat", () => {
    expect(globals).toContain("--login-provider-bg: #ffffff");
    expect(globals).toContain("--login-provider-stroke: #747775");
    expect(globals).toContain("--login-provider-ink: #1f1f1f");
    expect(globals).toContain("--login-provider-bg: #131314");
    expect(loginPage).toContain('viewBox="0 0 98 96"');
    expect(loginPage).toContain("M48.854 0C21.839 0 0 22 0 49.217");
  });
});
