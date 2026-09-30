import type { NumberFormat } from '../types/NumberFormat';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    computePeriodElapsedPercent,
    getJbCentralErrorMessage
} from '../utils/jbcentral';
import {
    formatPercent,
    resolveNumberFormat
} from '../utils/number-format';

import { renderJbCentralField } from './shared/jbcentral-field';
import { makeTimerProgressBar } from './shared/progress-bar';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';
import {
    cycleUsageDisplayMode,
    getUsageDisplayMode,
    getUsageDisplayModifierText,
    getUsagePercentCustomKeybinds,
    getUsageProgressBarWidth,
    isUsageCursorEnabled,
    isUsageInverted,
    isUsageProgressMode,
    isUsageSliderMode,
    makeSliderBar,
    toggleUsageCursor,
    toggleUsageInverted
} from './shared/usage-display';

const LABEL = 'Usage: ';
const PREVIEW_PERCENT = 2;

// Same bar and percent layout as the Usage category widgets. Their shared
// renderer in usage-percent-widget.ts is not reused because it imports the
// usage API module, which closes an import cycle through the widget manifest.
function renderPercentDisplay(
    item: WidgetItem,
    percent: number,
    format: NumberFormat,
    cursorPercent: number | undefined
): string {
    const mode = getUsageDisplayMode(item);
    const cursor = cursorPercent === undefined ? undefined : { cursorPercent };
    const text = formatPercent(percent, format);

    if (isUsageProgressMode(mode)) {
        const bar = makeTimerProgressBar(percent, getUsageProgressBarWidth(mode), cursor);
        return formatRawOrLabeledValue(item, LABEL, `[${bar}] ${text}`);
    }

    if (isUsageSliderMode(mode)) {
        const bar = makeSliderBar(percent, undefined, cursor);
        return formatRawOrLabeledValue(item, LABEL, mode === 'slider' ? `${bar} ${text}` : bar);
    }

    return formatRawOrLabeledValue(item, LABEL, text);
}

// The plain used-percent display keeps the CLI's own string ("0.2%"). The bar
// modes and the remaining-percent display need a number, so they parse it and
// format it with the widget's percent number format, like the Usage widgets.
export class JbCentralUsagePercentWidget implements Widget {
    getDefaultColor(): string { return 'yellow'; }
    getDescription(): string { return 'Shows JetBrains Central usage as a percentage of quota (e.g. 2.0%), optionally as a bar'; }
    getDisplayName(): string { return 'Usage %'; }
    getCategory(): string { return 'JetBrains Central'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: getUsageDisplayModifierText(item, { showUsageDirection: true })
        };
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === 'toggle-progress') {
            return cycleUsageDisplayMode(item, [], true, true);
        }
        if (action === 'toggle-invert') {
            return toggleUsageInverted(item);
        }
        if (action === 'toggle-cursor') {
            return toggleUsageCursor(item);
        }
        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const inverted = isUsageInverted(item);
        if (getUsageDisplayMode(item) === 'time' && !inverted) {
            return renderJbCentralField(item, context, LABEL, `${PREVIEW_PERCENT.toFixed(1)}%`, data => data.usagePercent);
        }

        const format = resolveNumberFormat('percent', item, settings);
        const showCursor = isUsageCursorEnabled(item);

        if (context.isPreview) {
            const previewPercent = inverted ? 100 - PREVIEW_PERCENT : PREVIEW_PERCENT;
            return renderPercentDisplay(item, previewPercent, format, showCursor ? 50 : undefined);
        }

        const data = context.jbCentralData ?? {};
        if (data.error) {
            return getJbCentralErrorMessage(data.error);
        }

        const used = Number.parseFloat(data.usagePercent ?? '');
        if (Number.isNaN(used)) {
            return null;
        }

        const percent = Math.max(0, Math.min(100, used));
        const cursorPercent = showCursor ? computePeriodElapsedPercent(data.periodStart, data.resetDate) : undefined;
        return renderPercentDisplay(item, inverted ? 100 - percent : percent, format, cursorPercent);
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return getUsagePercentCustomKeybinds(item);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
