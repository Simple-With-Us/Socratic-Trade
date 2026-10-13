import { z } from "zod";

/** OpenRouter/SiliconFlow embeddings JSON at the HTTP boundary (rule 22: strip, no passthrough). */
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
