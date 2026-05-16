import type { TranslationEntry } from "./TranslationEntry.js";

export interface TranslationCsvValidationResult {
    readonly totalRows: number;
    readonly translatedRows: number;
    readonly emptyTranslationRows: number;
    readonly sameAsSourceRows: number;
    readonly emptySourceRows: number;
    readonly duplicateSourceRows: number;
    readonly hasErrors: boolean;
}

export class TranslationCsvValidator {
    public validate(entries: readonly TranslationEntry[]): TranslationCsvValidationResult {
        const seenSources: Set<string> = new Set<string>();
        let translatedRows: number = 0;
        let emptyTranslationRows: number = 0;
        let sameAsSourceRows: number = 0;
        let emptySourceRows: number = 0;
        let duplicateSourceRows: number = 0;

        for (const entry of entries) {
            const sourceText: string = entry.sourceText.trim();
            const translatedText: string = entry.translatedText.trim();

            if (sourceText.length === 0) {
                emptySourceRows++;
            }

            if (seenSources.has(sourceText)) {
                duplicateSourceRows++;
            } else {
                seenSources.add(sourceText);
            }

            if (translatedText.length === 0) {
                emptyTranslationRows++;
                continue;
            }

            translatedRows++;

            if (sourceText === translatedText) {
                sameAsSourceRows++;
            }
        }

        return {
            totalRows: entries.length,
            translatedRows: translatedRows,
            emptyTranslationRows: emptyTranslationRows,
            sameAsSourceRows: sameAsSourceRows,
            emptySourceRows: emptySourceRows,
            duplicateSourceRows: duplicateSourceRows,
            hasErrors: emptySourceRows > 0 || duplicateSourceRows > 0
        };
    }
}

