import type { Result } from "./Result.js";
import { Results } from "./Result.js";
import type { TranslationEntry } from "./TranslationEntry.js";
import type { TranslationPackage, TranslationPackageEntry } from "./TranslationPackage.js";

export interface TranslationPackageBuildResult {
    readonly packageData: TranslationPackage;
    readonly inputRowCount: number;
    readonly packageEntryCount: number;
}

export class TranslationPackageBuilder {
    public build(entries: readonly TranslationEntry[]): Result<TranslationPackageBuildResult> {
        const packageEntries: TranslationPackageEntry[] = [];
        const seenSources: Set<string> = new Set<string>();

        for (const entry of entries) {
            const sourceText: string = entry.sourceText.trim();
            const translatedText: string = entry.translatedText.trim();

            if (sourceText.length === 0 || translatedText.length === 0) {
                continue;
            }

            if (seenSources.has(sourceText)) {
                return Results.failure(`Duplicate source text at CSV row ${entry.rowNumber}.`);
            }

            seenSources.add(sourceText);
            packageEntries.push({
                sourceText: entry.sourceText,
                translatedText: entry.translatedText
            });
        }

        return Results.success({
            packageData: {
                formatVersion: 1,
                entries: packageEntries
            },
            inputRowCount: entries.length,
            packageEntryCount: packageEntries.length
        });
    }
}

