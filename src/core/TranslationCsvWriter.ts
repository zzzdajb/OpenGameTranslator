import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtractedTextEntry } from "./ExtractedTextEntry.js";
import type { Result } from "./Result.js";
import { Results } from "./Result.js";

export interface TranslationCsvWriteResult {
    readonly outputPath: string;
    readonly totalEntryCount: number;
    readonly uniqueSourceCount: number;
}

export class TranslationCsvWriter {
    public async write(filePath: string, entries: readonly ExtractedTextEntry[]): Promise<Result<TranslationCsvWriteResult>> {
        const outputPath: string = path.resolve(filePath);
        const outputDirectoryPath: string = path.dirname(outputPath);

        await mkdir(outputDirectoryPath, { recursive: true });

        const uniqueSources: string[] = this.collectUniqueSources(entries);
        const lines: string[] = [];

        lines.push(`${this.escapeCsvField("原文")},${this.escapeCsvField("译文")}`);

        for (const sourceText of uniqueSources) {
            lines.push(`${this.escapeCsvField(sourceText)},${this.escapeCsvField("")}`);
        }

        await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

        return Results.success({
            outputPath: outputPath,
            totalEntryCount: entries.length,
            uniqueSourceCount: uniqueSources.length
        });
    }

    private collectUniqueSources(entries: readonly ExtractedTextEntry[]): string[] {
        const seenSources: Set<string> = new Set<string>();
        const uniqueSources: string[] = [];

        for (const entry of entries) {
            if (seenSources.has(entry.sourceText)) {
                continue;
            }

            seenSources.add(entry.sourceText);
            uniqueSources.push(entry.sourceText);
        }

        return uniqueSources;
    }

    private escapeCsvField(value: string): string {
        const escapedValue: string = value.replaceAll("\"", "\"\"");
        return `"${escapedValue}"`;
    }
}

