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

/**
 * SiliconFlow `/v1/embeddings` body for the OpenRouter query-embed rescue.
 *
 * `.passthrough()` is explicit on both objects.  The live envelope always includes
 * top-level `object` / `model` / `usage` and per-item `index` / `object`.  Implicit
 * `.strip()` would drop those keys with no signal; `.strict()` would reject every
 * real response.  `embedding` is still required to be an array of numbers so a
 * malformed vector cannot reach Qdrant.
 */
export const SiliconFlowEmbedSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            embedding: z.array(z.number())
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();
