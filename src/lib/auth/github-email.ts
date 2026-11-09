import { isEmailAllowed } from "./identity";

export type GitHubEmail = { email?: string; primary?: boolean; verified?: boolean };

export function normalizeAuthEmail(email: string | null | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : undefined;
}

export function selectVerifiedGitHubEmail(emails: GitHubEmail[], fallbackEmail?: string | null): string | undefined {
  const fallback = normalizeAuthEmail(fallbackEmail);
  const verified = emails
    .filter((entry) => entry.verified && normalizeAuthEmail(entry.email))
    .map((entry) => ({ ...entry, email: normalizeAuthEmail(entry.email)! }));

  return (
    verified.find((entry) => isEmailAllowed(entry.email))?.email ??
    verified.find((entry) => fallback && entry.email === fallback)?.email ??
    verified.find((entry) => entry.primary)?.email ??
    verified[0]?.email
  );
}
