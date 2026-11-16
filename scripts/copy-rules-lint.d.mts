/** Type declarations for copy-rules-lint.mjs — a plain ESM Node script (no
 *  build step) imported directly by test/copy-rules-lint.test.ts and runnable
 *  standalone via `node scripts/copy-rules-lint.mjs`. See that file's header
 *  comment for the rules this lints (sentence-gap, compact-money,
 *  Central-time, and a heuristic title-case report). */

export interface SentenceGapViolation {
  offset: number;
  match: string;
  spaceCount: number;
  spaceRunOffset: number;
  spaceRunLength: number;
}

export interface OffsetMatch {
  offset: number;
  match: string;
}

export interface TitleCaseViolation extends OffsetMatch {
  kind: "title-prop" | "heading";
}

export interface FileScanResult {
  file: string;
  sentenceGap: Array<{ file: string; line: number; match: string; spaceCount: number }>;
  compactMoney: Array<{ file: string; line: number; match: string }>;
  centralTime: Array<{ file: string; line: number; match: string }>;
  titleCase: Array<{ file: string; line: number; match: string; kind: string }>;
}

export interface LintTotals {
  sentenceGap: number;
  compactMoney: number;
  centralTime: number;
  titleCase: number;
}

export interface LintResult {
  results: FileScanResult[];
  totals: LintTotals;
}

export interface FixSpan {
  start: number;
  length: number;
}

export interface FixFileResult {
  file: string;
  count: number;
  dryRun?: boolean;
  skipped?: string;
}

export interface Candidate {
  text: string;
  index: number;
}

export const DEFAULT_ROOTS: string[];
export const EXCLUDE_DIR_SEGMENTS: Set<string>;
export const PEER_LOCKED_FILES: Set<string>;

export function collectFiles(roots?: string[]): string[];
export function extractCandidates(content: string): Candidate[];

export function findSentenceGapViolations(text: string): SentenceGapViolation[];
export function findCompactMoneyViolations(content: string): OffsetMatch[];
export function findCentralTimeViolations(content: string): OffsetMatch[];
export function findTitleCaseViolations(content: string): TitleCaseViolation[];

export function scanFile(filePath: string): FileScanResult;
export function lintFiles(files: string[]): LintResult;
export function lintRepo(roots?: string[]): LintResult;

export function computeSentenceGapFixSpans(content: string): FixSpan[];
export function applySentenceGapFixes(content: string): { content: string; count: number };
export function fixFile(filePath: string, options?: { dryRun?: boolean }): FixFileResult;
