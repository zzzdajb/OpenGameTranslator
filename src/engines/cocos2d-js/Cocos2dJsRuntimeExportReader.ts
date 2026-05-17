import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtractedTextEntry } from "../../core/ExtractedTextEntry.js";
import type { Result } from "../../core/Result.js";
import { Results } from "../../core/Result.js";

export interface Cocos2dJsRuntimeExportReadResult {
    readonly inputPath: string;
    readonly entries: readonly ExtractedTextEntry[];
    readonly rawTextCount: number;
    readonly uniqueTextCount: number;
}

interface RuntimeTextItem {
    readonly text: string;
    readonly source: string;
    readonly path: string;
}

export class Cocos2dJsRuntimeExportReader {
    public async read(inputPath: string): Promise<Result<Cocos2dJsRuntimeExportReadResult>> {
        const resolvedInputPath: string = path.resolve(inputPath);
        let parsedJson: unknown;

        try {
            const fileText: string = await readFile(resolvedInputPath, "utf8");
            parsedJson = JSON.parse(fileText) as unknown;
        } catch (error: unknown) {
            if (error instanceof Error) {
                return Results.failure(`Failed to read Cocos2d-JS runtime export: ${error.message}`);
            }

            return Results.failure("Failed to read Cocos2d-JS runtime export.");
        }

        const textItemsResult: Result<readonly RuntimeTextItem[]> = this.readTextItems(parsedJson);

        if (!textItemsResult.isSuccess) {
            return Results.failure(textItemsResult.errorMessage);
        }

        const entries: ExtractedTextEntry[] = this.createEntries(textItemsResult.value);

        return Results.success({
            inputPath: resolvedInputPath,
            entries: entries,
            rawTextCount: textItemsResult.value.length,
            uniqueTextCount: entries.length
        });
    }

    private readTextItems(value: unknown): Result<readonly RuntimeTextItem[]> {
        if (typeof value !== "object" || value === null) {
            return Results.failure("Invalid Cocos2d-JS runtime export: root value is not an object.");
        }

        const root: Record<string, unknown> = value as Record<string, unknown>;
        const candidateTexts: unknown = root["candidateTexts"];
        const extractedTexts: unknown = root["extractedTexts"];
        const textItems: unknown = Array.isArray(extractedTexts) ? extractedTexts : candidateTexts;

        if (!Array.isArray(textItems)) {
            return Results.failure("Invalid Cocos2d-JS runtime export: no text array was found.");
        }

        const result: RuntimeTextItem[] = [];

        for (const item of textItems) {
            if (!this.isRuntimeTextItem(item)) {
                continue;
            }

            result.push(item);
        }

        return Results.success(result);
    }

    private isRuntimeTextItem(value: unknown): value is RuntimeTextItem {
        if (typeof value !== "object" || value === null) {
            return false;
        }

        const item: Record<string, unknown> = value as Record<string, unknown>;

        return typeof item["text"] === "string"
            && typeof item["source"] === "string"
            && typeof item["path"] === "string";
    }

    private createEntries(textItems: readonly RuntimeTextItem[]): ExtractedTextEntry[] {
        const entries: ExtractedTextEntry[] = [];
        const seenTexts: Set<string> = new Set<string>();

        for (const item of textItems) {
            const sourceText: string = item.text.trim();

            if (sourceText.length === 0 || seenTexts.has(sourceText)) {
                continue;
            }

            seenTexts.add(sourceText);
            entries.push({
                id: `cocos2d-js:${entries.length + 1}`,
                engineId: "cocos2d-js",
                sourceText: sourceText,
                kind: "dialogue",
                location: {
                    filePath: item.source,
                    relativePath: item.path,
                    lineNumber: 0
                }
            });
        }

        return entries;
    }
}
