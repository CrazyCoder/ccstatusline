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
