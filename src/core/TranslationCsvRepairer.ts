import type { Result } from "./Result.js";
import { Results } from "./Result.js";
import type { TranslationEntry } from "./TranslationEntry.js";

export interface TranslationCsvRepairResult {
    readonly entries: readonly TranslationEntry[];
    readonly rowCount: number;
    readonly translatedRows: number;
    readonly emptyTranslationRows: number;
}

export class TranslationCsvRepairer {
    public repair(
        originalEntries: readonly TranslationEntry[],
        translatedSourceEntries: readonly TranslationEntry[]
    ): Result<TranslationCsvRepairResult> {
        if (originalEntries.length !== translatedSourceEntries.length) {
            return Results.failure(
                `CSV row count mismatch. Original rows: ${originalEntries.length}, translated rows: ${translatedSourceEntries.length}.`
            );
        }

        const entries: TranslationEntry[] = [];
        let translatedRows: number = 0;
        let emptyTranslationRows: number = 0;

        for (let index: number = 0; index < originalEntries.length; index++) {
            const originalEntry: TranslationEntry | undefined = originalEntries[index];
            const translatedSourceEntry: TranslationEntry | undefined = translatedSourceEntries[index];

            if (originalEntry === undefined || translatedSourceEntry === undefined) {
                return Results.failure(`CSV row ${index + 2} is missing.`);
            }

            // Some translation tools overwrite the first column instead of filling the second one.
            // In that case, row order is the bridge back to our normal "原文,译文" format.
            const translatedText: string = translatedSourceEntry.sourceText;

            if (translatedText.trim().length === 0) {
                emptyTranslationRows++;
            } else {
                translatedRows++;
            }

            entries.push({
                rowNumber: originalEntry.rowNumber,
                sourceText: originalEntry.sourceText,
                translatedText: translatedText
            });
        }

        return Results.success({
            entries: entries,
            rowCount: entries.length,
            translatedRows: translatedRows,
            emptyTranslationRows: emptyTranslationRows
        });
    }
}
