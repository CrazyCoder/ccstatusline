import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

import { renderJbCentralField } from './shared/jbcentral-field';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// Whole days while a day or more is left ("29d"), then hours and minutes in
// the compact style of the usage reset timers ("15h3m"). Their formatter in
// usage-windows.ts is not reused because that module closes an import cycle
// through the widget manifest.
function formatResetIn(resetInMs: number): string {
    if (resetInMs >= MS_PER_DAY) {
        return `${Math.floor(resetInMs / MS_PER_DAY)}d`;
    }

    const hours = Math.floor(resetInMs / MS_PER_HOUR);
    const minutes = Math.floor((resetInMs % MS_PER_HOUR) / MS_PER_MINUTE);
    const parts = [hours > 0 && `${hours}h`, minutes > 0 && `${minutes}m`].filter(Boolean);
    return parts.length > 0 ? parts.join('') : '0m';
}

export class JbCentralResetDaysWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows days until the JetBrains Central quota resets (e.g. 29d), then hours and minutes on the last day'; }
    getDisplayName(): string { return 'Days Until Reset'; }
    getCategory(): string { return 'JetBrains Central'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        return renderJbCentralField(
            item,
            context,
            'Resets in: ',
            '29d',
            data => (data.resetInMs === undefined ? undefined : formatResetIn(data.resetInMs))
        );
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
