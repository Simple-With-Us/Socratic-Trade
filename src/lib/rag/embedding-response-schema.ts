import { z } from "zod";

/**
 * OpenRouter/SiliconFlow embeddings JSON at the HTTP boundary (rule 22: strip, no passthrough).
 *
 * `.strip()` rather than `.strict()` on purpose: both providers return extra per-item keys
 * (OpenRouter `id`, SiliconFlow `object`), so failing closed on unknown keys would reject every
 * live embed response.  Stripping still guarantees unknown keys are never retained or consumed.
 */
export const EmbeddingVectorItemSchema = z
  .object({
    embedding: z.array(z.number()),
    index: z.number().int().nonnegative().optional()
  })
  .strip();

export const ProviderEmbeddingResponseSchema = z
  .object({
    data: z.array(EmbeddingVectorItemSchema).optional(),
    id: z.string().optional()
  })
  .strip();

export type ProviderEmbeddingResponse = z.infer<typeof ProviderEmbeddingResponseSchema>;

export function parseProviderEmbeddingResponse(raw: unknown): ProviderEmbeddingResponse {
  return ProviderEmbeddingResponseSchema.parse(raw);
}
