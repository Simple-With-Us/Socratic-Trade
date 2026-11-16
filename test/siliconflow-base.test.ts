import { afterEach, describe, expect, it } from "vitest";
import { siliconflowBaseUrl } from "../src/lib/siliconflow-base";

const ORIGINAL = process.env.SILICONFLOW_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SILICONFLOW_BASE_URL;
  else process.env.SILICONFLOW_BASE_URL = ORIGINAL;
});

describe("siliconflowBaseUrl", () => {
  it("defaults to the international platform (the fleet's key is a .com key; .cn rejects it with 401)", () => {
    delete process.env.SILICONFLOW_BASE_URL;
    expect(siliconflowBaseUrl()).toBe("https://api.siliconflow.com");
  });

  it("honors SILICONFLOW_BASE_URL for a China-platform key", () => {
    process.env.SILICONFLOW_BASE_URL = "https://api.siliconflow.cn";
    expect(siliconflowBaseUrl()).toBe("https://api.siliconflow.cn");
  });

  it("strips trailing slashes so callers can append /v1 paths", () => {
    process.env.SILICONFLOW_BASE_URL = "https://api.siliconflow.com///";
    expect(siliconflowBaseUrl()).toBe("https://api.siliconflow.com");
  });

  it("ignores a blank override", () => {
    process.env.SILICONFLOW_BASE_URL = "   ";
    expect(siliconflowBaseUrl()).toBe("https://api.siliconflow.com");
  });
});
