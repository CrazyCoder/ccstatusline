import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

import { renderJbCentralField } from './shared/jbcentral-field';

export class JbCentralUsagePercentWidget implements Widget {
    getDefaultColor(): string { return 'yellow'; }
    getDescription(): string { return 'Shows JetBrains Central usage as a percentage of quota (e.g. 2.0%)'; }
    getDisplayName(): string { return 'Usage %'; }
    getCategory(): string { return 'JetBrains Central'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        return renderJbCentralField(item, context, 'Usage: ', '2.0%', data => data.usagePercent);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
