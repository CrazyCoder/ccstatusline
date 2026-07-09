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

    // Dollar plans: "Usage: $3.96 / $200.00 (2.0%)"
    // Credit plans (rebranded `central` CLI): "Usage: 11.98 / 5000.00 credits (0.2%)"
    const usageMatch = /Usage:\s*(\$?[\d.,]+)\s*\/\s*(\$?[\d.,]+)(?:\s+credits)?\s*\(([\d.]+%)\)/.exec(text);
    if (usageMatch) {
        result.usage = usageMatch[1];
        result.quota = usageMatch[2];
        result.usagePercent = usageMatch[3];
    }

    // "Remaining: $196.04" or "Remaining: 4988.02 credits"
    const remainingMatch = /Remaining:\s*(\$?[\d.,]+)/.exec(text);
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

// `central quota --json` payload (v1.0.1+). Amounts are strings in practice
// ("11.98"), but numbers are tolerated. `refillLast`/`refillNext` are epoch ms.
interface QuotaJson {
    email?: unknown;
    licenseName?: unknown;
    usedDollars?: unknown;
    maxDollars?: unknown;
    tariffQuota?: { available?: unknown };
    refillLast?: unknown;
    refillNext?: unknown;
}

function asAmount(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return undefined;
}

// Format an epoch-ms refill timestamp the way the text output prints dates
// ("Jul 31, 2026"), so cached data is interchangeable between formats and the
// Reset Date / Days Until Reset widgets keep working unchanged. UTC on
// purpose: `refillNext` is 23:59:59.999Z on the period's last day, which
// local-TZ formatting east of UTC would roll into the next day.
function formatEpochDate(ms: unknown): string | undefined {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        return undefined;
    }
    return new Date(ms).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

export function parseJbCentralJson(rawOutput: string): JbCentralCachedFields {
    let json: unknown;
    try {
        json = JSON.parse(rawOutput);
    } catch {
        return {};
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return {};
    }
    const quota = json as QuotaJson;
    const result: JbCentralCachedFields = {};

    // Only assign fields that are actually present, so an unusable payload
    // reads as empty (parse-error) and cache entries stay minimal, like the
    // text parser's output.
    if (typeof quota.email === 'string' && quota.email) {
        result.account = quota.email;
    }
    if (typeof quota.licenseName === 'string' && quota.licenseName) {
        result.plan = quota.licenseName;
    }

    const usage = asAmount(quota.usedDollars);
    const max = asAmount(quota.maxDollars);
    if (usage !== undefined) {
        result.usage = usage;
    }
    if (max !== undefined) {
        result.quota = max;
    }

    const usedNum = Number(usage);
    const maxNum = Number(max);
    const amountsKnown = Number.isFinite(usedNum) && Number.isFinite(maxNum);
    if (amountsKnown && maxNum > 0) {
        // One decimal, matching the text output's pre-rounded "(0.2%)".
        result.usagePercent = `${(usedNum / maxNum * 100).toFixed(1)}%`;
    }

    const remaining = asAmount(quota.tariffQuota?.available)
        ?? (amountsKnown ? (maxNum - usedNum).toFixed(2) : undefined);
    if (remaining !== undefined) {
        result.remaining = remaining;
    }

    const periodStart = formatEpochDate(quota.refillLast);
    if (periodStart !== undefined) {
        result.periodStart = periodStart;
    }
    const resetDate = formatEpochDate(quota.refillNext);
    if (resetDate !== undefined) {
        result.resetDate = resetDate;
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

export type QuotaResult
    = { ok: true; output: string; format: 'json' | 'text' }
        | { ok: false; error: JbCentralError };

export type QuotaExec = (bin: string, args: string[]) => string;

function runTextQuota(exec: QuotaExec, bin: string): QuotaResult {
    try {
        return { ok: true, output: exec(bin, ['quota']), format: 'text' };
    } catch (err) {
        // Timed out (5s — e.g. a firewalled telemetry call), missing binary
        // (ENOENT), or non-zero exit. Classify it so the widget can show why.
        return { ok: false, error: classifyQuotaError(err) };
    }
}

// The quota CLI was renamed `jbcentral` → `central` (v1.0.0; migrated installs
// keep a `jbcentral` compat symlink) and gained `quota --json` in v1.0.1.
// Prefer the format-stable JSON output; degrade per failure mode. The 30s lock
// caps the worst case (one extra spawn per fetch, v1.0.0 only).
export function runQuotaCli(exec: QuotaExec): QuotaResult {
    try {
        return { ok: true, output: exec('central', ['quota', '--json']), format: 'json' };
    } catch (err) {
        const error = classifyQuotaError(err);
        if (error === 'cli-error') {
            // `central` exists but rejects --json (v1.0.0, "unknown flag",
            // exit 1) — re-run it for the text output.
            return runTextQuota(exec, 'central');
        }
        if (error !== 'not-found') {
            // Timeout etc.: the binary exists and ran — retrying won't help.
            return { ok: false, error };
        }
    }
    // No `central` binary: a pre-rename install, where `jbcentral` is a real
    // pre-1.0 binary that never supports --json.
    return runTextQuota(exec, 'jbcentral');
}

function runJbCentralQuota(): QuotaResult {
    return runQuotaCli((bin, args) => execFileSync(bin, args, {
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

    const parse = result.format === 'json' ? parseJbCentralJson : parseJbCentralOutput;
    const parsed = parse(result.output);
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
