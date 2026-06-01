import {
    describe,
    expect,
    it
} from 'vitest';

import type { WidgetItem } from '../../types/Widget';
import {
    computeResetDays,
    hasJbCentralWidgets,
    parseJbCentralOutput,
    prefetchJbCentralDataIfNeeded
} from '../jbcentral';

const SAMPLE_OUTPUT = `serge@jetbrains.com · JetBrains AI Ultimate

Usage: $3.96 / $200.00 (2.0%)
Remaining: $196.04

Quota:  $3.96 / $200.00 used ($196.04 remaining)

[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]

Resets: Jun 30, 2026
`;

function lines(...types: string[]): WidgetItem[][] {
    return [types.map((type, index) => ({ id: String(index), type }))];
}

describe('parseJbCentralOutput', () => {
    it('parses every field from the CLI output', () => {
        expect(parseJbCentralOutput(SAMPLE_OUTPUT)).toEqual({
            account: 'serge@jetbrains.com',
            plan: 'JetBrains AI Ultimate',
            usage: '$3.96',
            quota: '$200.00',
            usagePercent: '2.0%',
            remaining: '$196.04',
            resetDate: 'Jun 30, 2026'
        });
    });

    it('strips ANSI color codes before parsing', () => {
        const colored = '\x1b[1mserge@jetbrains.com\x1b[0m · \x1b[36mJetBrains AI Ultimate\x1b[0m\n\n'
            + 'Usage: \x1b[33m$3.96\x1b[0m / $200.00 (2.0%)\nRemaining: $196.04\nResets: Jun 30, 2026\n';
        const parsed = parseJbCentralOutput(colored);
        expect(parsed.account).toBe('serge@jetbrains.com');
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
