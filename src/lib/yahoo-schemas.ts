import { z } from "zod";

const looseNumber = z.union([z.number(), z.string()]);

/** Yahoo often sends null or string-numeric optional fields — keep parse tolerant, validate in mappers. */
const looseOptionalNumber = z.union([looseNumber, z.null()]).optional();
const looseOptionalString = z.union([z.string(), z.null()]).optional();

export const YahooChartMetaSchema = z
  .object({
    regularMarketPrice: looseOptionalNumber,
    longName: looseOptionalString,
    shortName: looseOptionalString,
    chartPreviousClose: looseOptionalNumber,
    regularMarketVolume: looseOptionalNumber,
    regularMarketTime: looseOptionalNumber,
    trailingPE: looseOptionalNumber,
    epsTrailingTwelveMonths: looseOptionalNumber,
    beta: looseOptionalNumber,
    fiftyTwoWeekHigh: looseOptionalNumber,
    fiftyTwoWeekLow: looseOptionalNumber
  })
  .passthrough();

export const YahooChartResultSchema = z
  .object({
    meta: YahooChartMetaSchema.optional(),
    indicators: z
      .object({
        quote: z
          .array(
            z
              .object({
                volume: z.array(z.unknown()).optional()
              })
              .passthrough()
          )
          .optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const YahooChartResponseSchema = z
  .object({
    chart: z
      .object({
        result: z.array(YahooChartResultSchema).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const YahooV7QuoteItemSchema = z
  .object({
    symbol: z.string().optional(),
    regularMarketPrice: looseOptionalNumber,
    bid: looseOptionalNumber,
    ask: looseOptionalNumber,
    regularMarketPreviousClose: looseOptionalNumber,
    regularMarketOpen: looseOptionalNumber,
    regularMarketDayHigh: looseOptionalNumber,
    regularMarketDayLow: looseOptionalNumber,
    regularMarketVolume: looseOptionalNumber,
    regularMarketTime: looseOptionalNumber,
    regularMarketChange: looseOptionalNumber,
    regularMarketChangePercent: looseOptionalNumber,
    shortName: looseOptionalString,
    longName: looseOptionalString,
    trailingPE: looseOptionalNumber,
    fiftyTwoWeekHigh: looseOptionalNumber,
    fiftyTwoWeekLow: looseOptionalNumber
  })
  .passthrough();

export const YahooV7QuoteResponseSchema = z
  .object({
    quoteResponse: z
      .object({
        result: z.array(YahooV7QuoteItemSchema).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();
