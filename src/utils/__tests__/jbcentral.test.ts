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
    parseJbCentralJson,
    parseJbCentralOutput,
    prefetchJbCentralDataIfNeeded,
    resolveJbCentralData,
    runQuotaCli
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

// Rebranded `central quota` output: amounts are unit-less credits ("11.98 /
// 5000.00 credits") instead of dollar figures.
const SAMPLE_OUTPUT_CREDITS = `you@jetbrains.com · JetBrains AI Ultimate

Usage: 11.98 / 5000.00 credits (0.2%)
Remaining: 4988.02 credits

Quota:  11.98 / 5000.00 credits used (4988.02 remaining)

[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]

Quota period: Jul 1, 2026 - Jul 31, 2026
`;

// `central quota --json` output (central v1.0.1+).
const SAMPLE_OUTPUT_JSON = `{
  "email": "you@jetbrains.com",
  "licenseName": "JetBrains AI Ultimate",
  "managed": false,
  "usedDollars": "11.98",
  "maxDollars": "5000.00",
  "tariffQuota": {
    "current": "11.98",
    "maximum": "5000.00",
    "available": "4988.02"
  },
  "topUpQuota": {
    "current": "0.00",
    "maximum": "0.00",
    "available": "0.00"
  },
  "refillLast": 1782864000000,
  "refillNext": 1785542399999
}`;

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

    it('parses the credits-based output of the rebranded `central` CLI', () => {
        expect(parseJbCentralOutput(SAMPLE_OUTPUT_CREDITS)).toEqual({
            account: 'you@jetbrains.com',
            plan: 'JetBrains AI Ultimate',
            usage: '11.98',
            quota: '5000.00',
            usagePercent: '0.2%',
            remaining: '4988.02',
            periodStart: 'Jul 1, 2026',
            resetDate: 'Jul 31, 2026'
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
        expect(getJbCentralErrorMessage('not-found')).toBe('[central not found]');
        expect(getJbCentralErrorMessage('timeout')).toBe('[Timeout]');
        expect(getJbCentralErrorMessage('cli-error')).toBe('[CLI error]');
        expect(getJbCentralErrorMessage('parse-error')).toBe('[Parse Error]');
    });
});

describe('parseJbCentralJson', () => {
    it('maps every field from `central quota --json` output', () => {
        expect(parseJbCentralJson(SAMPLE_OUTPUT_JSON)).toEqual({
            account: 'you@jetbrains.com',
            plan: 'JetBrains AI Ultimate',
            usage: '11.98',
            quota: '5000.00',
            usagePercent: '0.2%',
            remaining: '4988.02',
            periodStart: 'Jul 1, 2026',
            resetDate: 'Jul 31, 2026'
        });
    });

    it('formats refill timestamps in UTC so the period end does not roll into the next day', () => {
        // 2026-07-31T23:59:59.999Z — local-TZ formatting east of UTC would say Aug 1.
        const parsed = parseJbCentralJson('{"refillNext": 1785542399999}');
        expect(parsed.resetDate).toBe('Jul 31, 2026');
    });

    it('computes remaining from used/max when tariffQuota is absent', () => {
        const parsed = parseJbCentralJson('{"usedDollars": "11.98", "maxDollars": "5000.00"}');
        expect(parsed.remaining).toBe('4988.02');
    });

    it('omits the percentage when the quota is zero', () => {
        const parsed = parseJbCentralJson('{"usedDollars": "0.00", "maxDollars": "0.00"}');
        expect(parsed.usagePercent).toBeUndefined();
    });

    it('returns an empty object for invalid JSON or non-object payloads', () => {
        expect(parseJbCentralJson('unknown flag: --json')).toEqual({});
        expect(parseJbCentralJson('null')).toEqual({});
        expect(parseJbCentralJson('[1,2]')).toEqual({});
    });

    it('tolerates numeric amounts', () => {
        const parsed = parseJbCentralJson('{"usedDollars": 11.98, "maxDollars": 5000}');
        expect(parsed.usage).toBe('11.98');
        expect(parsed.quota).toBe('5000');
        expect(parsed.usagePercent).toBe('0.2%');
    });
});

describe('runQuotaCli', () => {
    const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const unknownFlag = () => Object.assign(new Error('exited 1'), { status: 1 });

    it('prefers `central quota --json` and reports the json format', () => {
        const calls: [string, string[]][] = [];
        const result = runQuotaCli((bin, args) => {
            calls.push([bin, args]);
            return '{"email":"a@b"}';
        });
        expect(result).toEqual({ ok: true, output: '{"email":"a@b"}', format: 'json' });
        expect(calls).toEqual([['central', ['quota', '--json']]]);
    });

    it('re-runs `central quota` as text when --json is rejected (central 1.0.0)', () => {
        const calls: [string, string[]][] = [];
        const result = runQuotaCli((bin, args) => {
            calls.push([bin, args]);
            if (args.includes('--json')) {
                throw unknownFlag();
            }
            return 'text output';
        });
        expect(result).toEqual({ ok: true, output: 'text output', format: 'text' });
        expect(calls).toEqual([['central', ['quota', '--json']], ['central', ['quota']]]);
    });

    it('falls back to `jbcentral quota` (text, no --json) when `central` is not installed', () => {
        const calls: [string, string[]][] = [];
        const result = runQuotaCli((bin, args) => {
            calls.push([bin, args]);
            if (bin === 'central') {
                throw enoent();
            }
            return 'legacy output';
        });
        expect(result).toEqual({ ok: true, output: 'legacy output', format: 'text' });
        expect(calls).toEqual([['central', ['quota', '--json']], ['jbcentral', ['quota']]]);
    });

    it('does not retry when `central` times out', () => {
        const calls: string[] = [];
        const result = runQuotaCli((bin) => {
            calls.push(bin);
            throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
        });
        expect(result).toEqual({ ok: false, error: 'timeout' });
        expect(calls).toEqual(['central']);
    });

    it('reports not-found when neither binary is installed', () => {
        const result = runQuotaCli(() => { throw enoent(); });
        expect(result).toEqual({ ok: false, error: 'not-found' });
    });

    it('surfaces a legacy-binary failure after the fallback', () => {
        const result = runQuotaCli((bin) => {
            if (bin === 'central') {
                throw enoent();
            }
            throw unknownFlag();
        });
        expect(result).toEqual({ ok: false, error: 'cli-error' });
    });

    it('surfaces the text re-run failure when both central invocations fail', () => {
        const result = runQuotaCli((bin, args) => {
            if (args.includes('--json')) {
                throw unknownFlag();
            }
            throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
        });
        expect(result).toEqual({ ok: false, error: 'timeout' });
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
        const run = overrides.runQuota ?? ((): QuotaResult => ({ ok: true, output: SAMPLE_OUTPUT, format: 'text' }));
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
        const h = makeIO({ runQuota: () => ({ ok: true, output: 'totally unrelated text', format: 'text' }) });
        const result = resolveJbCentralData(h.io);
        expect(result).toEqual({ error: 'parse-error' });
        expect(h.writes).toEqual([{ error: 'parse-error' }]);
    });

    it('parses json-format results with the JSON parser', () => {
        const h = makeIO({ runQuota: () => ({ ok: true, output: SAMPLE_OUTPUT_JSON, format: 'json' }) });
        const result = resolveJbCentralData(h.io);
        expect(result?.account).toBe('you@jetbrains.com');
        expect(result?.remaining).toBe('4988.02');
        expect(h.writes[0]?.resetDate).toBe('Jul 31, 2026');
    });

    it('persists a parse-error when json-format output is not valid JSON', () => {
        const h = makeIO({ runQuota: () => ({ ok: true, output: 'not json', format: 'json' }) });
        expect(resolveJbCentralData(h.io)).toEqual({ error: 'parse-error' });
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
