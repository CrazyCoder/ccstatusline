import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { JbCentralData } from '../types/RenderContext';
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

// All widget types that depend on `jbcentral quota` output. If none of these
// appear in the configured lines, the CLI is never invoked.
const JB_CENTRAL_WIDGET_TYPES = new Set<string>([
    'jbcentral-account',
    'jbcentral-plan',
    'jbcentral-usage',
    'jbcentral-quota',
    'jbcentral-usage-percent',
    'jbcentral-remaining',
    'jbcentral-reset-date',
    'jbcentral-reset-days'
]);

// The persisted fields are the raw strings parsed from the CLI. `resetDays` is
// intentionally NOT cached — it is recomputed from `resetDate` on every read so
// the countdown stays accurate even when served from a stale cache.
type JbCentralCachedFields = Omit<JbCentralData, 'resetDays'>;

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

export function computeResetDays(resetDate: string | undefined): number | undefined {
    if (!resetDate) {
        return undefined;
    }

    const resetMs = Date.parse(resetDate);
    if (Number.isNaN(resetMs)) {
        return undefined;
    }

    return Math.max(0, Math.ceil((resetMs - Date.now()) / MS_PER_DAY));
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

    // "Resets: Jun 30, 2026"
    const resetsMatch = /Resets:\s*(.+)/.exec(text);
    if (resetsMatch?.[1]) {
        result.resetDate = resetsMatch[1].trim();
    }

    return result;
}

interface ReadCacheResult {
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

function runJbCentralQuota(): string | null {
    try {
        return execFileSync('jbcentral', ['quota'], {
            encoding: 'utf8',
            timeout: CLI_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        });
    } catch {
        // Not installed (ENOENT), timed out, or non-zero exit — fall back to cache.
        return null;
    }
}

export function fetchJbCentralData(): JbCentralData | null {
    const now = Math.floor(Date.now() / 1000);
    const cached = readCache(now);

    // Fresh cache — no CLI call.
    if (cached && cached.ageSeconds < CACHE_MAX_AGE) {
        return withResetDays(cached.data);
    }

    // Stale cache but the CLI was tried recently — serve stale rather than respawn.
    if (isLockActive(now)) {
        return cached ? withResetDays(cached.data) : null;
    }

    touchLock();

    const rawOutput = runJbCentralQuota();
    if (rawOutput === null) {
        return cached ? withResetDays(cached.data) : null;
    }

    const parsed = parseJbCentralOutput(rawOutput);
    if (isEmptyData(parsed)) {
        return cached ? withResetDays(cached.data) : null;
    }

    writeCache(parsed);
    return withResetDays(parsed);
}

export function prefetchJbCentralDataIfNeeded(lines: WidgetItem[][]): JbCentralData | null {
    if (!hasJbCentralWidgets(lines)) {
        return null;
    }

    return fetchJbCentralData();
}
