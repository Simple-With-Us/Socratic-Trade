import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER,
  remoteLogoSources,
  sourceOrderFor
} from "@/lib/ticker-logo-policy";
import {
  logoDevTickerUrl,
  normalizeTickerLogoSymbol,
  tickerLogoCandidates,
  tickerLogoRawUrl
} from "@/lib/ticker-logos";

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
const FETCH_TIMEOUT_MS = 5_000;

const LOGO_CACHE_DIR = path.join(process.cwd(), "data", "logos");

async function readDiskCache(symbol: string, theme: string, source: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(LOGO_CACHE_DIR, `${symbol}-${theme}-${source}.png`));
  } catch {
    return null;
  }
}

async function writeDiskCache(
  symbol: string | null | undefined,
  theme: string,
  source: string,
  buf: ArrayBuffer
): Promise<void> {
  if (!symbol) return;
  try {
    await fs.mkdir(LOGO_CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(LOGO_CACHE_DIR, `${symbol}-${theme}-${source}.png`), Buffer.from(buf));
  } catch { /* ignore write failures — cache is best-effort */ }
}

async function fetchImage(
  url: string,
  revalidate: number,
  extraHeaders?: Record<string, string>
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      next: { revalidate },
      headers: extraHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) return null;
  return { buf: await res.arrayBuffer(), contentType: "image/png" };
}

export async function GET(request: Request) {
  const { searchParams, protocol, host } = new URL(request.url);
  const rawSymbol = searchParams.get("symbol");
  const candidates = tickerLogoCandidates(rawSymbol);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  const baseSymbol = normalizeTickerLogoSymbol(rawSymbol);
  const rawTheme = searchParams.get("theme");
  const theme = rawTheme === "light" || rawTheme === "dark" ? rawTheme : "dark";
  const cacheKey = baseSymbol ?? null;
  const order = cacheKey
    ? remoteLogoSources(sourceOrderFor(cacheKey, theme, undefined, SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER))
    : ["github", "logodev"] as const;

  async function tryGitHub() {
    for (const sym of candidates) {
      const r = await fetchImage(tickerLogoRawUrl(sym), ONE_WEEK_SECONDS);
      if (r) {
        if (cacheKey) writeDiskCache(cacheKey, theme, "github", r.buf);
        return new NextResponse(r.buf, {
          headers: {
            "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
            "content-type": r.contentType,
            "x-logo-source": "github:davidepalazzo/ticker-logos"
          }
        });
      }
    }
    return null;
  }

  async function tryLogoDev() {
    if (!logoDevToken || !cacheKey) return null;
    const logoUrl = logoDevTickerUrl(cacheKey, logoDevToken, { theme, fallback: "monogram" });
    const referer = `${protocol}//${host}/`;
    const r = await fetchImage(logoUrl, ONE_WEEK_SECONDS, { Referer: referer });
    if (!r) return null;
    writeDiskCache(cacheKey, theme, "logodev", r.buf);
    return new NextResponse(r.buf, {
      headers: {
        "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
        "content-type": r.contentType,
        "x-logo-source": `logo.dev:ticker:${theme}`
      }
    });
  }

  for (const source of order) {
    if (cacheKey) {
      const cached = await readDiskCache(cacheKey, theme, source);
      if (cached) {
        return new NextResponse(new Uint8Array(cached), {
          headers: {
            "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
            "content-type": "image/png",
            "x-logo-source": `disk-cache:${source}`
          }
        });
      }
    }
    const hit = source === "github" ? await tryGitHub() : await tryLogoDev();
    if (hit) return hit;
  }

  return new NextResponse(null, {
    status: 404,
    headers: { "cache-control": `public, max-age=${ONE_DAY_SECONDS}` }
  });
}
