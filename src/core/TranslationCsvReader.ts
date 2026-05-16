import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TranslationEntry } from "./TranslationEntry.js";
import type { Result } from "./Result.js";
import { Results } from "./Result.js";

export interface TranslationCsvReadResult {
    readonly filePath: string;
    readonly entries: readonly TranslationEntry[];
}

export class TranslationCsvReader {
    public async read(filePath: string): Promise<Result<TranslationCsvReadResult>> {
        const normalizedPath: string = path.resolve(filePath);
        let csvText: string;

        try {
            csvText = await readFile(normalizedPath, "utf8");
        } catch (error: unknown) {
            if (error instanceof Error) {
                return Results.failure(`Failed to read CSV file: ${error.message}`);
            }

            return Results.failure("Failed to read CSV file.");
        }

        const parsedRowsResult: Result<readonly string[][]> = this.parseRows(csvText);

        if (!parsedRowsResult.isSuccess) {
            return Results.failure(parsedRowsResult.errorMessage);
        }

        const rows: readonly string[][] = parsedRowsResult.value;

        if (rows.length === 0) {
            return Results.failure("CSV file is empty.");
        }

        const header: readonly string[] = rows[0] ?? [];

        if (!this.isExpectedHeader(header)) {
            return Results.failure("CSV header must be: 原文,译文");
        }

        const entries: TranslationEntry[] = [];

        for (let index: number = 1; index < rows.length; index++) {
            const row: readonly string[] = rows[index] ?? [];
            const rowNumber: number = index + 1;

            if (row.length !== 2) {
                return Results.failure(`CSV row ${rowNumber} must have exactly 2 columns.`);
            }

            const sourceText: string | undefined = row[0];
            const translatedText: string | undefined = row[1];

            entries.push({
                rowNumber: rowNumber,
                sourceText: sourceText ?? "",
                translatedText: translatedText ?? ""
            });
        }

        return Results.success({
            filePath: normalizedPath,
            entries: entries
        });
    }

    private isExpectedHeader(header: readonly string[]): boolean {
        const sourceHeader: string | undefined = header[0]?.replace(/^\uFEFF/u, "");
        const translationHeader: string | undefined = header[1];

        return header.length === 2
            && sourceHeader === "原文"
            && translationHeader === "译文";
    }

    private parseRows(csvText: string): Result<readonly string[][]> {
        // CSV may contain commas or line breaks inside quoted fields, so simple split is not enough.
        const rows: string[][] = [];
        let currentRow: string[] = [];
        let currentField: string = "";
        let isInsideQuotedField: boolean = false;

        for (let index: number = 0; index < csvText.length; index++) {
            const character: string = csvText[index] ?? "";

            if (isInsideQuotedField) {
                const quotedResult: QuotedCharacterResult = this.readQuotedCharacter(csvText, index, currentField);
                currentField = quotedResult.currentField;
                isInsideQuotedField = quotedResult.isInsideQuotedField;
                index = quotedResult.index;
                continue;
            }

            if (character === "\"") {
                if (currentField.length > 0) {
                    return Results.failure(`Unexpected quote near character ${index + 1}.`);
                }

                isInsideQuotedField = true;
                continue;
            }

            if (character === ",") {
                currentRow.push(currentField);
                currentField = "";
                continue;
            }

            if (character === "\n" || character === "\r") {
                const newLineResult: NewLineResult = this.completeRowOnNewLine(
                    csvText,
                    index,
                    currentRow,
                    currentField,
                    rows
                );

                currentRow = newLineResult.currentRow;
                currentField = newLineResult.currentField;
                index = newLineResult.index;
                continue;
            }

            currentField += character;
        }

        if (isInsideQuotedField) {
            return Results.failure("CSV has an unclosed quoted field.");
        }

        this.addRowIfNeeded(rows, currentRow, currentField);

        return Results.success(rows);
    }

    private readQuotedCharacter(csvText: string, index: number, currentField: string): QuotedCharacterResult {
        const character: string = csvText[index] ?? "";

        if (character !== "\"") {
            return {
                index: index,
                currentField: currentField + character,
                isInsideQuotedField: true
            };
        }

        if (csvText[index + 1] === "\"") {
            return {
                index: index + 1,
                currentField: currentField + "\"",
                isInsideQuotedField: true
            };
        }

        return {
            index: index,
            currentField: currentField,
            isInsideQuotedField: false
        };
    }

    private completeRowOnNewLine(
        csvText: string,
        index: number,
        currentRow: string[],
        currentField: string,
        rows: string[][]
    ): NewLineResult {
        let nextIndex: number = index;

        if (csvText[index] === "\r" && csvText[index + 1] === "\n") {
            nextIndex = index + 1;
        }

        this.addRowIfNeeded(rows, currentRow, currentField);

        return {
            index: nextIndex,
            currentRow: [],
            currentField: ""
        };
    }

    private addRowIfNeeded(rows: string[][], currentRow: string[], currentField: string): void {
        if (currentRow.length === 0 && currentField.length === 0) {
            return;
        }

        currentRow.push(currentField);
        rows.push(currentRow);
    }
}

interface QuotedCharacterResult {
    readonly index: number;
    readonly currentField: string;
    readonly isInsideQuotedField: boolean;
}

interface NewLineResult {
    readonly index: number;
    readonly currentRow: string[];
    readonly currentField: string;
}
