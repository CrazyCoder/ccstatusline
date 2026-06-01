import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

import { renderJbCentralField } from './shared/jbcentral-field';

export class JbCentralResetDaysWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows days until the JetBrains Central quota resets (e.g. 29d)'; }
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
            data => (data.resetDays === undefined ? undefined : `${data.resetDays}d`)
        );
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
