import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

import { renderJbCentralField } from './shared/jbcentral-field';

export class JbCentralRemainingWidget implements Widget {
    getDefaultColor(): string { return 'green'; }
    getDescription(): string { return 'Shows the remaining JetBrains Central quota (e.g. $196.04)'; }
    getDisplayName(): string { return 'Remaining'; }
    getCategory(): string { return 'JetBrains Central'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        return renderJbCentralField(item, context, 'Remaining: ', '$196.04', data => data.remaining);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
