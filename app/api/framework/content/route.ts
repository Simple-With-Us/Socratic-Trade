// Gated content API for the /framework page.
//
// The framework prose deliberately never appears in the page HTML or in any
// client JS chunk — this route is the only way it leaves the server, and it
// answers only to requests that look like a same-origin fetch from a real
// browser. Layered with: the Cloudflare WAF UA rule at the edge, the page's
// own UA gate, robots/noai directives, and no-store caching.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isBlockedFrameworkClient } from "../../../framework/ua-gate";
import { FRAMEWORK_CONTENT } from "../../../framework/content";

export const dynamic = "force-dynamic";

const PROOF_HEADER = "x-framework-viewer";

export async function GET(request: NextRequest) {
  const ua = request.headers.get("user-agent");
  if (isBlockedFrameworkClient(ua)) {
    return new NextResponse(null, { status: 404 });
  }

  // Requires JavaScript executing on the page: plain document fetches and
  // HTTP-library scrapers don't send this custom header.
  if (request.headers.get(PROOF_HEADER) !== "1") {
    return new NextResponse(null, { status: 404 });
  }

  // Real browsers attach fetch metadata; when present it must be same-origin.
  // (Absent is tolerated for older browsers — the custom header still applies.)
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.json(
    { content: FRAMEWORK_CONTENT },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noai, noimageai",
        "tdm-reservation": "1"
      }
    }
  );
}
