import { z } from "zod";

/**
 * Nasdaq delayed-screener JSON at the HTTP boundary.
 *
 * Every object is `.strict()`.  A live `tableonly=true` row is `symbol`, `name`,
 * `lastsale`, `netchange`, `pctchange`, `marketCap`, and `url`.  The envelope
 * also carries `message`, `status`, `filters`, `totalrecords`, and table
 * `asOf` / `headers`.  Those keys are declared so today's response parses.
 * Any other key fails the parse and is not cached.  `volume`, `sector`,
 * `industry`, `country`, and `ipoyear` stay optional because fixtures and
 * `toMarketQuote` still read them when a row includes them.  A missing
 * `data.table.rows` array fails the parse so a drifted envelope cannot be
 * stored as an empty screener.
 */
const ScreenerText = z.string().nullish();
const ScreenerNumberLike = z.union([z.string(), z.number()]).nullish();
const ScreenerHeaders = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.string())
]).nullish();

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
    industry: ScreenerText,
    url: ScreenerText,
    country: ScreenerText,
    ipoyear: ScreenerText
  })
  .strict();

const NasdaqScreenerStatusSchema = z
  .object({
    rCode: z.number().nullish(),
    bCodeMessage: z.unknown().nullish(),
    developerMessage: z.unknown().nullish()
  })
  .strict();

export const NasdaqScreenerPayloadSchema = z
  .object({
    data: z
      .object({
        asof: ScreenerText,
        filters: z.unknown().nullish(),
        totalrecords: z.union([z.number(), z.string()]).nullish(),
        headers: ScreenerHeaders,
        table: z
          .object({
            asOf: ScreenerText,
            headers: ScreenerHeaders,
            rows: z.array(NasdaqScreenerRowSchema)
          })
          .strict()
      })
      .strict(),
    message: z.unknown().nullish(),
    status: NasdaqScreenerStatusSchema.nullish()
  })
  .strict();

export type NasdaqScreenerRow = z.infer<typeof NasdaqScreenerRowSchema>;
export type NasdaqScreenerPayload = z.infer<typeof NasdaqScreenerPayloadSchema>;

export function parseNasdaqScreenerPayload(raw: unknown): NasdaqScreenerPayload {
  return NasdaqScreenerPayloadSchema.parse(raw);
}
