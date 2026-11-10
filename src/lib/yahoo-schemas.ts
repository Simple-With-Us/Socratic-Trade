import { z } from "zod";

const looseNumber = z.union([z.number(), z.string()]);

export const YahooChartMetaSchema = z
  .object({
    regularMarketPrice: looseNumber.optional(),
    longName: z.string().optional(),
    shortName: z.string().optional(),
    chartPreviousClose: looseNumber.optional(),
    regularMarketVolume: looseNumber.optional(),
    regularMarketTime: looseNumber.optional(),
    trailingPE: looseNumber.optional(),
    epsTrailingTwelveMonths: looseNumber.optional(),
    beta: looseNumber.optional(),
    fiftyTwoWeekHigh: looseNumber.optional(),
    fiftyTwoWeekLow: looseNumber.optional()
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
    regularMarketPrice: z.number().optional(),
    bid: z.number().optional(),
    ask: z.number().optional(),
    regularMarketPreviousClose: z.number().optional(),
    regularMarketOpen: z.number().optional(),
    regularMarketDayHigh: z.number().optional(),
    regularMarketDayLow: z.number().optional(),
    regularMarketVolume: z.number().optional(),
    regularMarketTime: z.number().optional(),
    regularMarketChange: z.number().optional(),
    regularMarketChangePercent: z.number().optional(),
    shortName: z.string().optional(),
    longName: z.string().optional(),
    trailingPE: z.number().optional(),
    fiftyTwoWeekHigh: z.number().optional(),
    fiftyTwoWeekLow: z.number().optional()
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
