import { z } from "zod";

/** Opaque PKCE S256 challenge (43-char base64url). */
const codeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid code_challenge.");

export const HANDOFF_PREPARE_MAX_BYTES = 4096;

export const HandoffPrepareBodySchema = z
  .object({
    codeChallenge: codeChallengeSchema,
  })
  .strict();

export const MobileAppleSignInBodySchema = z
  .object({
    identityToken: z.string().min(1),
    name: z.string().optional(),
    nonce: z.string().optional(),
  })
  .strict();

/** Validated claims from Apple's verified identity token (post-jwtVerify; extra JWT fields ignored). */
export const AppleIdentityTokenClaimsSchema = z.object({
  email: z.string().optional(),
  nonce: z.string().optional(),
});

export const AppleVerifiedEmailSchema = z.string().email();
