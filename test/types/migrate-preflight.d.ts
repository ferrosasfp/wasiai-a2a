/**
 * Type shim for `scripts/migrate-preflight.mjs` so vitest tests can import
 * the script without `@ts-expect-error`. The script itself is `.mjs` with
 * JSDoc types; this shim mirrors only the surface the tests consume.
 *
 * Introduced in WKH-86 (AC-7) replacing `// @ts-expect-error` in
 * `test/migrate-preflight.test.ts`.
 *
 * Keep in sync with the `export` set of `scripts/migrate-preflight.mjs`.
 */
declare module '*/scripts/migrate-preflight.mjs' {
  export type RiskLevel = 'HIGH' | 'MEDIUM' | 'INFO';

  export interface Finding {
    line: number;
    level: RiskLevel;
    op: string;
    snippet: string;
  }

  export interface Statement {
    line: number;
    text: string;
  }

  export interface DryRunResult {
    skipped: boolean;
    reason?: string;
    ok?: boolean;
    ms?: number;
    error?: string;
  }

  export interface PostApplyResult {
    ok: boolean;
    errors: string[];
    details: string[];
  }

  export interface PsqlConnection {
    args: string[];
    env: Record<string, string>;
  }

  // biome-ignore lint/suspicious/noExplicitAny: spawn mock injection
  type SpawnLike = (...args: any[]) => any;

  export function analyze(sql: string): Finding[];
  export function hasHighRisk(findings: Finding[]): boolean;
  export function stripComments(sql: string): string;
  export function stripStringLiterals(sql: string): string;
  export function splitStatements(sql: string): Statement[];
  export function buildDryRunPayload(sql: string): string;
  export function buildPsqlConnectionEnv(url: string): PsqlConnection;
  export function isIdempotentDropTriggerOrFunction(stmt: string): boolean;
  export function dedupeByLineAndLevel(findings: Finding[]): Finding[];
  export function findDeleteWithoutWhere(
    sql: string,
  ): Array<{ line: number; snippet: string }>;
  export function runShadowDryRun(
    sql: string,
    opts?: {
      shadowUrl?: string;
      spawn?: SpawnLike;
      nowMs?: () => number;
    },
  ): DryRunResult;
  export function runPostApplyCheck(opts?: {
    databaseUrl?: string;
    spawn?: SpawnLike;
    minA2aTables?: number;
    expectedA2aTables?: string[];
  }): PostApplyResult;
  export function decide(
    findings: Finding[],
    dryRun: DryRunResult,
    opts?: { slowMs?: number },
  ): { pass: boolean; exitCode: number; summary: string };
  export function formatFindings(findings: Finding[]): string;

  export const POST_APPLY_QUERIES: {
    a2aTables: string;
    invalidFks: string;
    a2aIndexes: string;
  };
  export const EXPECTED_A2A_TABLES: string[];

  export function main(deps: {
    argv: string[];
    readFile?: (path: string) => string;
    exit?: (code: number) => void;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    shadowDryRun?: SpawnLike;
    postApply?: SpawnLike;
  }): void;
}
