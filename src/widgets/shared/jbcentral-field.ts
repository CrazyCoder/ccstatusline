import type {
    JbCentralData,
    RenderContext
} from '../../types/RenderContext';
import type { WidgetItem } from '../../types/Widget';
import { getJbCentralErrorMessage } from '../../utils/jbcentral';

import { formatRawOrLabeledValue } from './raw-or-labeled';

// Shared render path for every JetBrains Central widget: handle preview mode,
// surface a bare diagnostic when the `central quota` fetch failed (timeout,
// missing binary, …), pull the widget's field out of the prefetched data,
// render nothing when the field is absent, and honor the raw/labeled toggle.
export function renderJbCentralField(
    item: WidgetItem,
    context: RenderContext,
    labelPrefix: string,
    previewValue: string,
    getValue: (data: JbCentralData) => string | undefined
): string | null {
    if (context.isPreview) {
        return formatRawOrLabeledValue(item, labelPrefix, previewValue);
    }

    const data = context.jbCentralData ?? {};
    if (data.error) {
        return getJbCentralErrorMessage(data.error);
    }

    const value = getValue(data);
    if (value === undefined || value === '') {
        return null;
    }

    return formatRawOrLabeledValue(item, labelPrefix, value);
}
