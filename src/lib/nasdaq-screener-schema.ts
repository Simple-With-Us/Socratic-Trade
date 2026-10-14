import { z } from "zod";

/**
 * Nasdaq delayed-screener JSON at the HTTP boundary.
 *
 * `.strip()` rather than `.strict()`: the live table adds provider keys
 * (`url`, `country`, `ipoyear`, header metadata) that this scan never reads.
 * Stripping still guarantees those keys are not cached or indexed.  A missing
 * `data.table.rows` object fails the parse so a drifted envelope cannot be
 * stored as an empty screener.
 */
const ScreenerText = z.string().nullish();
const ScreenerNumberLike = z.union([z.string(), z.number()]).nullish();

export const NasdaqScreenerRowSchema = z
  .object({
    symbol: ScreenerText,
    name: ScreenerText,
    lastsale: ScreenerNumberLike,
    netchange: ScreenerNumberLike,
    pctchange: ScreenerNumberLike,
    volume: ScreenerNumberLike,
    marketCap: ScreenerNumberLike,
    sector: ScreenerText,
    industry: ScreenerText
  })
  .strip();

export const NasdaqScreenerPayloadSchema = z
  .object({
    data: z
      .object({
        asof: ScreenerText,
        table: z
          .object({
            rows: z.array(NasdaqScreenerRowSchema)
          })
          .strip()
      })
      .strip()
  })
  .strip();

export type NasdaqScreenerRow = z.infer<typeof NasdaqScreenerRowSchema>;
export type NasdaqScreenerPayload = z.infer<typeof NasdaqScreenerPayloadSchema>;

export function parseNasdaqScreenerPayload(raw: unknown): NasdaqScreenerPayload {
  return NasdaqScreenerPayloadSchema.parse(raw);
}
