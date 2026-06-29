import {
    describe,
    expect,
    it
} from 'vitest';

import type { WidgetItem } from '../../types/Widget';
import type {
    JbCentralCachedFields,
    JbCentralFetchIO,
    QuotaResult
} from '../jbcentral';
import {
    classifyQuotaError,
    computeResetDays,
    getJbCentralErrorMessage,
    hasJbCentralWidgets,
    parseJbCentralOutput,
    prefetchJbCentralDataIfNeeded,
    resolveJbCentralData
} from '../jbcentral';

// Legacy `jbcentral quota` output (< 0.4.1): the reset date is a single
// "Resets:" line.
const SAMPLE_OUTPUT = `you@jetbrains.com · JetBrains AI Ultimate

Usage: $3.96 / $200.00 (2.0%)
Remaining: $196.04

Quota:  $3.96 / $200.00 used ($196.04 remaining)

[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]

Resets: Jun 30, 2026
`;

// Current `jbcentral quota` output (>= 0.4.1): the reset date moved into a
// "Quota period: <start> - <end>" range.
const SAMPLE_OUTPUT_PERIOD = `you@jetbrains.com · JetBrains AI Ultimate

Usage: $3.96 / $200.00 (2.0%)
Remaining: $196.04

Quota:  $3.96 / $200.00 used ($196.04 remaining)

[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]

Quota period: Jun 1, 2026 - Jun 30, 2026
`;

function lines(...types: string[]): WidgetItem[][] {
    return [types.map((type, index) => ({ id: String(index), type }))];
}

describe('parseJbCentralOutput', () => {
    it('parses every field from the legacy "Resets:" CLI output', () => {
        expect(parseJbCentralOutput(SAMPLE_OUTPUT)).toEqual({
            account: 'you@jetbrains.com',
            plan: 'JetBrains AI Ultimate',
            usage: '$3.96',
            quota: '$200.00',
            usagePercent: '2.0%',
            remaining: '$196.04',
            resetDate: 'Jun 30, 2026'
        });
    });

    it('parses the "Quota period:" range, mapping the end to resetDate and the start to periodStart', () => {
        expect(parseJbCentralOutput(SAMPLE_OUTPUT_PERIOD)).toEqual({
            account: 'you@jetbrains.com',
            plan: 'JetBrains AI Ultimate',
            usage: '$3.96',
            quota: '$200.00',
            usagePercent: '2.0%',
            remaining: '$196.04',
            periodStart: 'Jun 1, 2026',
            resetDate: 'Jun 30, 2026'
        });
    });

    it('does not match the "Quota:" usage line as a period range', () => {
        // "Quota:  $3.96 / ..." must not be mistaken for "Quota period: ...".
        const parsed = parseJbCentralOutput(SAMPLE_OUTPUT_PERIOD);
        expect(parsed.periodStart).toBe('Jun 1, 2026');
        expect(parsed.resetDate).toBe('Jun 30, 2026');
    });

    it('leaves periodStart undefined on the legacy "Resets:" format', () => {
        expect(parseJbCentralOutput(SAMPLE_OUTPUT).periodStart).toBeUndefined();
    });

    it('strips ANSI color codes before parsing', () => {
        const colored = '\x1b[1myou@jetbrains.com\x1b[0m · \x1b[36mJetBrains AI Ultimate\x1b[0m\n\n'
            + 'Usage: \x1b[33m$3.96\x1b[0m / $200.00 (2.0%)\nRemaining: $196.04\nResets: Jun 30, 2026\n';
        const parsed = parseJbCentralOutput(colored);
        expect(parsed.account).toBe('you@jetbrains.com');
        expect(parsed.plan).toBe('JetBrains AI Ultimate');
        expect(parsed.usage).toBe('$3.96');
        expect(parsed.usagePercent).toBe('2.0%');
        expect(parsed.resetDate).toBe('Jun 30, 2026');
    });

    it('returns an empty object for unrelated text', () => {
        expect(parseJbCentralOutput('jbcentral: command not found')).toEqual({});
    });

    it('parses dollar amounts without an account/plan header line', () => {
        const parsed = parseJbCentralOutput('Usage: $1.00 / $10.00 (10.0%)\nRemaining: $9.00\n');
        expect(parsed.account).toBeUndefined();
        expect(parsed.plan).toBeUndefined();
        expect(parsed.usage).toBe('$1.00');
        expect(parsed.quota).toBe('$10.00');
        expect(parsed.remaining).toBe('$9.00');
    });
});

describe('classifyQuotaError', () => {
    it('classifies a missing binary (ENOENT) as not-found', () => {
        const err = Object.assign(new Error('spawn jbcentral ENOENT'), { code: 'ENOENT' });
        expect(classifyQuotaError(err)).toBe('not-found');
    });

    it('classifies a killed/SIGTERM process (execFileSync timeout) as timeout', () => {
        const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
        expect(classifyQuotaError(err)).toBe('timeout');
    });

    it('classifies an ETIMEDOUT code as timeout', () => {
        const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        expect(classifyQuotaError(err)).toBe('timeout');
    });

    it('classifies a non-zero exit status as cli-error', () => {
        const err = Object.assign(new Error('exited 1'), { status: 1 });
        expect(classifyQuotaError(err)).toBe('cli-error');
    });

    it('falls back to cli-error for an unrecognized failure', () => {
        expect(classifyQuotaError(new Error('boom'))).toBe('cli-error');
    });
});

describe('getJbCentralErrorMessage', () => {
    it('maps each error code to a bracketed status string', () => {
        expect(getJbCentralErrorMessage('not-found')).toBe('[jbcentral not found]');
        expect(getJbCentralErrorMessage('timeout')).toBe('[Timeout]');
        expect(getJbCentralErrorMessage('cli-error')).toBe('[CLI error]');
        expect(getJbCentralErrorMessage('parse-error')).toBe('[Parse Error]');
    });
});

describe('hasJbCentralWidgets', () => {
    it('returns true when a jbcentral widget is present', () => {
        expect(hasJbCentralWidgets(lines('model', 'jbcentral-usage'))).toBe(true);
    });

    it('returns false when no jbcentral widget is present', () => {
        expect(hasJbCentralWidgets(lines('model', 'git-branch'))).toBe(false);
    });
});

describe('prefetchJbCentralDataIfNeeded', () => {
    it('returns null without invoking the CLI when no jbcentral widget is configured', () => {
        expect(prefetchJbCentralDataIfNeeded(lines('model', 'git-branch'))).toBeNull();
    });
});

describe('resolveJbCentralData', () => {
    const GOOD_CACHE: JbCentralCachedFields = {
        account: 'cached@jetbrains.com',
        plan: 'JetBrains AI Ultimate',
        usage: '$1.00',
        quota: '$10.00',
        usagePercent: '10.0%',
        remaining: '$9.00',
        resetDate: 'Jun 30, 2026'
    };

    interface Harness {
        io: JbCentralFetchIO;
        writes: JbCentralCachedFields[];
        lockTouched: () => boolean;
        quotaCalls: () => number;
    }

    function makeIO(overrides: Partial<JbCentralFetchIO> = {}): Harness {
        const writes: JbCentralCachedFields[] = [];
        let lockTouched = false;
        let quotaCalls = 0;
        const run = overrides.runQuota ?? ((): QuotaResult => ({ ok: true, output: SAMPLE_OUTPUT }));
        const io: JbCentralFetchIO = {
            now: 1000,
            readCache: overrides.readCache ?? (() => null),
            writeCache: (data) => { writes.push(data); },
            isLockActive: overrides.isLockActive ?? (() => false),
            touchLock: () => { lockTouched = true; },
            runQuota: () => { quotaCalls += 1; return run(); }
        };
        return { io, writes, lockTouched: () => lockTouched, quotaCalls: () => quotaCalls };
    }

    it('returns fresh cached data without spawning the CLI', () => {
        const h = makeIO({ readCache: () => ({ data: GOOD_CACHE, ageSeconds: 10 }) });
        const result = resolveJbCentralData(h.io);
        expect(result?.account).toBe('cached@jetbrains.com');
        expect(h.quotaCalls()).toBe(0);
        expect(h.lockTouched()).toBe(false);
    });

    it('spawns, parses, and caches on a fresh successful fetch', () => {
        const h = makeIO();
        const result = resolveJbCentralData(h.io);
        expect(result?.account).toBe('you@jetbrains.com');
        expect(h.lockTouched()).toBe(true);
        expect(h.writes).toHaveLength(1);
        expect(h.writes[0]?.account).toBe('you@jetbrains.com');
    });

    it('persists and returns a timeout diagnostic when the CLI times out with no cache', () => {
        const h = makeIO({ runQuota: () => ({ ok: false, error: 'timeout' }) });
        const result = resolveJbCentralData(h.io);
        expect(result).toEqual({ error: 'timeout' });
        expect(h.writes).toEqual([{ error: 'timeout' }]);
        expect(h.lockTouched()).toBe(true);
    });

    it('prefers stale good data over an error and does not overwrite the cache', () => {
        const h = makeIO({
            readCache: () => ({ data: GOOD_CACHE, ageSeconds: 9999 }),
            runQuota: () => ({ ok: false, error: 'timeout' })
        });
        const result = resolveJbCentralData(h.io);
        expect(result?.account).toBe('cached@jetbrains.com');
        expect(result?.error).toBeUndefined();
        expect(h.writes).toHaveLength(0);
    });

    it('serves a persisted error during the lock window without respawning', () => {
        const h = makeIO({
            isLockActive: () => true,
            readCache: () => ({ data: { error: 'timeout' }, ageSeconds: 5 })
        });
        const result = resolveJbCentralData(h.io);
        expect(result).toEqual({ error: 'timeout' });
        expect(h.quotaCalls()).toBe(0);
    });

    it('serves stale good data during the lock window without respawning', () => {
        const h = makeIO({
            isLockActive: () => true,
            readCache: () => ({ data: GOOD_CACHE, ageSeconds: 9999 })
        });
        const result = resolveJbCentralData(h.io);
        expect(result?.account).toBe('cached@jetbrains.com');
        expect(h.quotaCalls()).toBe(0);
    });

    it('persists a parse-error when the CLI succeeds but output is unparseable', () => {
        const h = makeIO({ runQuota: () => ({ ok: true, output: 'totally unrelated text' }) });
        const result = resolveJbCentralData(h.io);
        expect(result).toEqual({ error: 'parse-error' });
        expect(h.writes).toEqual([{ error: 'parse-error' }]);
    });

    it('returns null during the lock window when there is no cache at all', () => {
        const h = makeIO({ isLockActive: () => true });
        expect(resolveJbCentralData(h.io)).toBeNull();
        expect(h.quotaCalls()).toBe(0);
    });
});

describe('computeResetDays', () => {
    const now = new Date(2026, 5, 1, 12, 0, 0).getTime(); // Jun 1, 2026 12:00 local

    it('returns undefined for missing or unparseable dates', () => {
        expect(computeResetDays(undefined, now)).toBeUndefined();
        expect(computeResetDays('not a date', now)).toBeUndefined();
    });

    it('counts whole days remaining until the reset date', () => {
        expect(computeResetDays('Jun 30, 2026', now)).toBe(29);
    });

    it('clamps past reset dates to zero', () => {
        expect(computeResetDays('Jan 1, 2020', now)).toBe(0);
    });
});
