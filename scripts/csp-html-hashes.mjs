import { createHash } from "node:crypto";

/** HTML parser decoding for the bytes a browser hashes. */
export function decodeHtmlText(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match) => {
    const body = match.slice(1, -1);
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return "\"";
    if (body === "apos") return "'";
    const codePoint = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(codePoint)) return match;
    return String.fromCodePoint(codePoint);
  });
}

/** sha256 CSP sources for every inline script, in document order. */
export function inlineScriptHashes(html) {
  const hashes = [];
  const seen = new Set();
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[1] ?? "";
    const raw = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) && raw.trim() === "") continue;
    if (raw.length === 0) continue;
    const hash = `sha256-${createHash("sha256").update(decodeHtmlText(raw)).digest("base64")}`;
    if (seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}
