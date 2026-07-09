import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
    JbCentralData,
    JbCentralError
} from '../types/RenderContext';
import type { WidgetItem } from '../types/Widget';

import { getVisibleText } from './ansi';

// Cache configuration
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'jbcentral.json');
const LOCK_FILE = path.join(CACHE_DIR, 'jbcentral.lock');
const CACHE_MAX_AGE = 180; // seconds
const LOCK_MAX_AGE = 30;   // only spawn the CLI at most once per 30 seconds
const CLI_TIMEOUT_MS = 5000;
const MS_PER_DAY = 86_400_000;

// All widget types that depend on `central quota` output. If none of these
// appear in the configured lines, the CLI is never invoked.
const JB_CENTRAL_WIDGET_TYPES = new Set<string>([
    'jbcentral-account',
    'jbcentral-plan',
    'jbcentral-usage',
    'jbcentral-quota',
    'jbcentral-usage-percent',
    'jbcentral-remaining',
    'jbcentral-period-start',
    'jbcentral-reset-date',
    'jbcentral-reset-days'
]);

// The persisted fields are the raw strings parsed from the CLI. `resetDays` is
// intentionally NOT cached — it is recomputed from `resetDate` on every read so
// the countdown stays accurate even when served from a stale cache. A cache
// entry may instead hold only `{ error }` — a short-lived diagnostic marker
// written when a fetch fails, so the widget keeps showing why between renders.
export type JbCentralCachedFields = Omit<JbCentralData, 'resetDays'>;

// The string fields a successful `central quota` parse produces. Used to tell
// real cached data apart from an `{ error }` marker.
const REAL_DATA_FIELDS: (keyof JbCentralCachedFields)[] = [
    'account', 'plan', 'usage', 'quota', 'usagePercent', 'remaining', 'periodStart', 'resetDate'
];

function hasGoodData(data: JbCentralCachedFields): boolean {
    return !data.error && REAL_DATA_FIELDS.some(field => data[field] !== undefined);
}

// Map a thrown `execFileSync` failure to a diagnostic error code so the widget
// can show *why* it has no data instead of silently rendering nothing. A 5s
// timeout (slow `central quota`, e.g. a firewalled telemetry call) surfaces
// as `killed`/SIGTERM; a missing binary as ENOENT; anything else (non-zero
// exit, auth failure) as a generic CLI error.
export function classifyQuotaError(err: unknown): JbCentralError {
    const e = err as { code?: string; killed?: boolean; signal?: string };
    if (e.code === 'ENOENT') {
        return 'not-found';
    }
    if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return 'timeout';
    }
    return 'cli-error';
}

export function getJbCentralErrorMessage(error: JbCentralError): string {
    switch (error) {
        case 'not-found': return '[central not found]';
        case 'timeout': return '[Timeout]';
        case 'cli-error': return '[CLI error]';
        case 'parse-error': return '[Parse Error]';
    }
}

export function hasJbCentralWidgets(lines: WidgetItem[][]): boolean {
    return lines.some(line => line.some(item => JB_CENTRAL_WIDGET_TYPES.has(item.type)));
}

function ensureCacheDirExists(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function isEmptyData(data: JbCentralCachedFields): boolean {
    // parseJbCentralOutput only assigns fields it actually matched, so an
    // unparsed result has no keys at all.
    return Object.keys(data).length === 0;
}

export function computeResetDays(resetDate: string | undefined, now: number = Date.now()): number | undefined {
    if (!resetDate) {
        return undefined;
    }

    const resetMs = Date.parse(resetDate);
    if (Number.isNaN(resetMs)) {
        return undefined;
    }

    return Math.max(0, Math.ceil((resetMs - now) / MS_PER_DAY));
}

function withResetDays(data: JbCentralCachedFields): JbCentralData {
    return { ...data, resetDays: computeResetDays(data.resetDate) };
}

export function parseJbCentralOutput(rawOutput: string): JbCentralCachedFields {
    const text = getVisibleText(rawOutput);
    const result: JbCentralCachedFields = {};

    // First non-empty line: "<account> · <plan>"
    const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
    if (firstLine) {
        const parts = firstLine.split(/\s*[·•]\s*/);
        if (parts.length >= 2 && parts[0] && parts[1]) {
            result.account = parts[0].trim();
            result.plan = parts.slice(1).join(' · ').trim();
        }
    }

    // "Usage: $3.96 / $200.00 (2.0%)"
    const usageMatch = /Usage:\s*(\$[\d.,]+)\s*\/\s*(\$[\d.,]+)\s*\(([\d.]+%)\)/.exec(text);
    if (usageMatch) {
        result.usage = usageMatch[1];
        result.quota = usageMatch[2];
        result.usagePercent = usageMatch[3];
    }

    // "Remaining: $196.04"
    const remainingMatch = /Remaining:\s*(\$[\d.,]+)/.exec(text);
    if (remainingMatch) {
        result.remaining = remainingMatch[1];
    }

    // Legacy (jbcentral < 0.4.1): "Resets: Jun 30, 2026"
    const resetsMatch = /Resets:\s*(.+)/.exec(text);
    if (resetsMatch?.[1]) {
        result.resetDate = resetsMatch[1].trim();
    }

    // Current (jbcentral >= 0.4.1): "Quota period: Jun 1, 2026 - Jun 30, 2026".
    // The period *end* is the reset date (kept under `resetDate` so the Reset
    // Date / Days Until Reset widgets work unchanged across CLI versions); the
    // *start* is surfaced separately. The date format is "MMM D, YYYY" — no
    // internal hyphen — so the first " - " is an unambiguous start/end split.
    const periodMatch = /Quota period:\s*(.+?)\s+-\s+(.+)/.exec(text);
    if (periodMatch?.[1] && periodMatch[2]) {
        result.periodStart = periodMatch[1].trim();
        result.resetDate = periodMatch[2].trim();
    }

    return result;
}

export interface ReadCacheResult {
    data: JbCentralCachedFields;
    ageSeconds: number;
}

function readCache(now: number): ReadCacheResult | null {
    try {
        const stat = fs.statSync(CACHE_FILE);
        const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as JbCentralCachedFields;
        return {
            data: parsed,
            ageSeconds: now - Math.floor(stat.mtimeMs / 1000)
        };
    } catch {
        return null;
    }
}

function writeCache(data: JbCentralCachedFields): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch {
        // Ignore cache write errors — a failed write just means we re-fetch sooner.
    }
}

function isLockActive(now: number): boolean {
    try {
        const stat = fs.statSync(LOCK_FILE);
        return now - Math.floor(stat.mtimeMs / 1000) < LOCK_MAX_AGE;
    } catch {
        return false;
    }
}

function touchLock(): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(LOCK_FILE, '');
    } catch {
        // Ignore lock write errors — worst case we spawn the CLI again sooner.
    }
}

export type QuotaResult = { ok: true; output: string } | { ok: false; error: JbCentralError };

// The quota CLI was renamed `jbcentral` → `central`; installs migrated from the
// old name keep a `jbcentral` compat symlink but may predate the rename. Try
// the new name first and fall back to the legacy one.
const QUOTA_CLI_CANDIDATES = ['central', 'jbcentral'] as const;

export function runQuotaCli(exec: (bin: string) => string): QuotaResult {
    let error: JbCentralError = 'not-found';
    for (const bin of QUOTA_CLI_CANDIDATES) {
        try {
            return { ok: true, output: exec(bin) };
        } catch (err) {
            // Timed out (5s — e.g. a firewalled telemetry call) or non-zero
            // exit. Classify it so the widget can show why.
            error = classifyQuotaError(err);
            // Only a missing binary (ENOENT) justifies trying the older name;
            // any other failure means the CLI exists and ran.
            if (error !== 'not-found') {
                return { ok: false, error };
            }
        }
    }
    return { ok: false, error };
}

function runJbCentralQuota(): QuotaResult {
    return runQuotaCli(bin => execFileSync(bin, ['quota'], {
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    }));
}

// I/O seam for the fetch orchestration — injected so the decision logic can be
// unit-tested without touching the filesystem or spawning a process.
export interface JbCentralFetchIO {
    now: number;
    readCache: (now: number) => ReadCacheResult | null;
    writeCache: (data: JbCentralCachedFields) => void;
    isLockActive: (now: number) => boolean;
    touchLock: () => void;
    runQuota: () => QuotaResult;
}

// Prefer real stale data over surfacing an error; otherwise persist the error
// marker (short-lived, behind the lock) so the diagnostic survives between the
// per-render invocations of ccstatusline instead of flickering.
function staleDataOrError(
    cached: ReadCacheResult | null,
    error: JbCentralError,
    writeCache: (data: JbCentralCachedFields) => void
): JbCentralData {
    if (cached && hasGoodData(cached.data)) {
        return withResetDays(cached.data);
    }

    writeCache({ error });
    return { error };
}

export function resolveJbCentralData(io: JbCentralFetchIO): JbCentralData | null {
    const cached = io.readCache(io.now);

    // Fresh, real data — no CLI call.
    if (cached && hasGoodData(cached.data) && cached.ageSeconds < CACHE_MAX_AGE) {
        return withResetDays(cached.data);
    }

    // The CLI was tried recently — serve whatever we have rather than respawn.
    if (io.isLockActive(io.now)) {
        if (cached && hasGoodData(cached.data)) {
            return withResetDays(cached.data);
        }
        if (cached?.data.error) {
            return { error: cached.data.error };
        }
        return null;
    }

    io.touchLock();

    const result = io.runQuota();
    if (!result.ok) {
        return staleDataOrError(cached, result.error, io.writeCache);
    }

    const parsed = parseJbCentralOutput(result.output);
    if (isEmptyData(parsed)) {
        return staleDataOrError(cached, 'parse-error', io.writeCache);
    }

    io.writeCache(parsed);
    return withResetDays(parsed);
}

export function fetchJbCentralData(): JbCentralData | null {
    return resolveJbCentralData({
        now: Math.floor(Date.now() / 1000),
        readCache,
        writeCache,
        isLockActive,
        touchLock,
        runQuota: runJbCentralQuota
    });
}

export function prefetchJbCentralDataIfNeeded(lines: WidgetItem[][]): JbCentralData | null {
    if (!hasJbCentralWidgets(lines)) {
        return null;
    }

    return fetchJbCentralData();
}
