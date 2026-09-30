import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    JbCentralData,
    RenderContext
} from '../../types/RenderContext';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type {
    Widget,
    WidgetItem
} from '../../types/Widget';
import { JbCentralAccountWidget } from '../JbCentralAccount';
import { JbCentralPeriodStartWidget } from '../JbCentralPeriodStart';
import { JbCentralPlanWidget } from '../JbCentralPlan';
import { JbCentralQuotaWidget } from '../JbCentralQuota';
import { JbCentralRemainingWidget } from '../JbCentralRemaining';
import { JbCentralResetDateWidget } from '../JbCentralResetDate';
import { JbCentralResetDaysWidget } from '../JbCentralResetDays';
import { JbCentralUsageWidget } from '../JbCentralUsage';
import { JbCentralUsagePercentWidget } from '../JbCentralUsagePercent';

const SAMPLE: JbCentralData = {
    account: 'you@jetbrains.com',
    plan: 'JetBrains AI Ultimate',
    usage: '$3.96',
    quota: '$200.00',
    usagePercent: '2.0%',
    remaining: '$196.04',
    periodStart: 'Jun 1, 2026',
    resetDate: 'Jun 30, 2026',
    resetDays: 29
};

interface WidgetCase {
    name: string;
    widget: Widget;
    labeled: string;
    raw: string;
}

const CASES: WidgetCase[] = [
    { name: 'account', widget: new JbCentralAccountWidget(), labeled: 'Account: you@jetbrains.com', raw: 'you@jetbrains.com' },
    { name: 'plan', widget: new JbCentralPlanWidget(), labeled: 'Plan: JetBrains AI Ultimate', raw: 'JetBrains AI Ultimate' },
    { name: 'usage', widget: new JbCentralUsageWidget(), labeled: 'Usage: $3.96', raw: '$3.96' },
    { name: 'quota', widget: new JbCentralQuotaWidget(), labeled: 'Quota: $200.00', raw: '$200.00' },
    { name: 'usage-percent', widget: new JbCentralUsagePercentWidget(), labeled: 'Usage: 2.0%', raw: '2.0%' },
    { name: 'remaining', widget: new JbCentralRemainingWidget(), labeled: 'Remaining: $196.04', raw: '$196.04' },
    { name: 'period-start', widget: new JbCentralPeriodStartWidget(), labeled: 'Period start: Jun 1, 2026', raw: 'Jun 1, 2026' },
    { name: 'reset-date', widget: new JbCentralResetDateWidget(), labeled: 'Resets: Jun 30, 2026', raw: 'Jun 30, 2026' },
    { name: 'reset-days', widget: new JbCentralResetDaysWidget(), labeled: 'Resets in: 29d', raw: '29d' }
];

function item(rawValue = false): WidgetItem {
    return { id: 'jbc', type: 'jbcentral', rawValue };
}

describe('JetBrains Central widgets', () => {
    it.each(CASES)('renders $name with a label from prefetched data', ({ widget, labeled }) => {
        const context: RenderContext = { jbCentralData: SAMPLE };
        expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe(labeled);
    });

    it.each(CASES)('renders $name as a raw value when rawValue is enabled', ({ widget, raw }) => {
        const context: RenderContext = { jbCentralData: SAMPLE };
        expect(widget.render(item(true), context, DEFAULT_SETTINGS)).toBe(raw);
    });

    it.each(CASES)('renders $name preview text in preview mode', ({ widget, labeled }) => {
        expect(widget.render(item(), { isPreview: true }, DEFAULT_SETTINGS)).toBe(labeled);
    });

    it.each(CASES)('renders $name as null when data is absent', ({ widget }) => {
        expect(widget.render(item(), { jbCentralData: null }, DEFAULT_SETTINGS)).toBeNull();
    });

    it.each(CASES)('renders $name as a bare diagnostic when the fetch errored', ({ widget }) => {
        const context: RenderContext = { jbCentralData: { error: 'timeout' } };
        expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('[Timeout]');
    });

    it.each(CASES)('shows the diagnostic for $name even with rawValue enabled', ({ widget }) => {
        const context: RenderContext = { jbCentralData: { error: 'not-found' } };
        expect(widget.render(item(true), context, DEFAULT_SETTINGS)).toBe('[central not found]');
    });

    it('all widgets report the JetBrains Central category', () => {
        for (const { widget } of CASES) {
            expect(widget.getCategory()).toBe('JetBrains Central');
        }
    });

    it('renders nothing for reset-days when the reset date was unparseable', () => {
        const widget = new JbCentralResetDaysWidget();
        const context: RenderContext = { jbCentralData: { resetDate: 'garbage', resetDays: undefined } };
        expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBeNull();
    });
});

describe('JetBrains Central usage percent bar modes', () => {
    const widget = new JbCentralUsagePercentWidget();
    const context: RenderContext = { jbCentralData: { ...SAMPLE, usagePercent: '8.0%' } };

    function barItem(metadata: Record<string, string>, rawValue = true): WidgetItem {
        return { id: 'jbc', type: 'jbcentral-usage-percent', rawValue, metadata };
    }

    it('renders the short bar with the percentage', () => {
        expect(widget.render(barItem({ display: 'slider' }), context, DEFAULT_SETTINGS)).toBe('▓░░░░░░░░░ 8.0%');
    });

    it('renders the short bar alone', () => {
        expect(widget.render(barItem({ display: 'slider-only' }), context, DEFAULT_SETTINGS)).toBe('▓░░░░░░░░░');
    });

    it('renders the medium and long bars', () => {
        expect(widget.render(barItem({ display: 'progress-short' }), context, DEFAULT_SETTINGS))
            .toBe(`[${'█'.repeat(1)}${'░'.repeat(15)}] 8.0%`);
        expect(widget.render(barItem({ display: 'progress' }), context, DEFAULT_SETTINGS))
            .toBe(`[${'█'.repeat(3)}${'░'.repeat(29)}] 8.0%`);
    });

    it('honors the percent number format', () => {
        const settings = { ...DEFAULT_SETTINGS, numberFormat: { percent: { style: 'whole' as const } } };
        expect(widget.render(barItem({ display: 'slider' }), context, settings)).toBe('▓░░░░░░░░░ 8%');
    });

    it('shows the remaining percentage when inverted', () => {
        expect(widget.render(barItem({ display: 'slider', invert: 'true' }), context, DEFAULT_SETTINGS)).toBe('▓▓▓▓▓▓▓▓▓░ 92.0%');
        expect(widget.render(barItem({ invert: 'true' }, false), context, DEFAULT_SETTINGS)).toBe('Usage: 92.0%');
    });

    it('draws the period cursor at the elapsed part of the quota period', () => {
        // A period centered on the real clock, so the cursor must land mid-bar.
        const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000)
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const midPeriod: RenderContext = { jbCentralData: { usagePercent: '8.0%', periodStart: day(-15), resetDate: day(14) } };
        const rendered = widget.render(barItem({ display: 'slider-only', cursor: 'true' }), midPeriod, DEFAULT_SETTINGS) ?? '';
        expect(rendered).toHaveLength(10);
        expect(rendered.indexOf('│')).toBeGreaterThanOrEqual(3);
        expect(rendered.indexOf('│')).toBeLessThanOrEqual(6);
    });

    it('applies the percent number format to the plain display', () => {
        const settings = { ...DEFAULT_SETTINGS, numberFormat: { percent: { style: 'whole' as const } } };
        expect(widget.render(barItem({}), context, settings)).toBe('8%');
    });

    it('keeps diagnostics and absent data in bar modes', () => {
        expect(widget.render(barItem({ display: 'slider' }), { jbCentralData: { error: 'timeout' } }, DEFAULT_SETTINGS)).toBe('[Timeout]');
        expect(widget.render(barItem({ display: 'slider' }), { jbCentralData: null }, DEFAULT_SETTINGS)).toBeNull();
    });

    it('cycles through the bar modes and offers the usage keybinds', () => {
        const first = widget.handleEditorAction('toggle-progress', barItem({}));
        expect(first?.metadata?.display).toBe('progress');
        expect(widget.getCustomKeybinds(barItem({ display: 'slider' })).map(k => k.key)).toEqual(['p', 'u', 't']);
        expect(widget.getEditorDisplay(barItem({ display: 'slider' })).modifierText).toBe('(short bar, used)');
    });
});
