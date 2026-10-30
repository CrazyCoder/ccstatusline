import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { computeDailyBudget } from '../utils/jbcentral';

import { renderJbCentralField } from './shared/jbcentral-field';

export class JbCentralDailyBudgetWidget implements Widget {
    getDefaultColor(): string { return 'green'; }
    getDescription(): string { return 'Shows what\'s left of the JetBrains Central quota per day left in the period (e.g. $6.53)'; }
    getDisplayName(): string { return 'Daily Budget'; }
    getCategory(): string { return 'JetBrains Central'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        return renderJbCentralField(item, context, 'Daily Budget: ', '$6.53', computeDailyBudget);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
