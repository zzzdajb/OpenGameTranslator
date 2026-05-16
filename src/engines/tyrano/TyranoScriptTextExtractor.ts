import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ExtractedTextEntry, ExtractedTextKind } from "../../core/ExtractedTextEntry.js";

interface TyranoTag {
    readonly name: string;
    readonly attributes: ReadonlyMap<string, string>;
}

interface TranslatableAttribute {
    readonly tagName: string;
    readonly attributeName: string;
    readonly kind: ExtractedTextKind;
}

export class TyranoScriptTextExtractor {
    private readonly translatableAttributes: readonly TranslatableAttribute[] = [
        { tagName: "ptext", attributeName: "text", kind: "tagAttribute" },
        { tagName: "mtext", attributeName: "text", kind: "tagAttribute" },
        { tagName: "glink", attributeName: "text", kind: "tagAttribute" },
        { tagName: "button", attributeName: "hint", kind: "tagAttribute" },
        { tagName: "chara_new", attributeName: "jname", kind: "characterName" }
    ];

    public constructor(private readonly engineId: string) {
    }

    public async extractDirectory(scenarioDirectoryPath: string): Promise<readonly ExtractedTextEntry[]> {
        const scenarioFiles: readonly string[] = await this.collectScenarioFiles(scenarioDirectoryPath);
        const entries: ExtractedTextEntry[] = [];

        for (const filePath of scenarioFiles) {
            const relativePath: string = path.relative(scenarioDirectoryPath, filePath);
            const fileEntries: readonly ExtractedTextEntry[] = await this.extractFile(filePath, relativePath);

            for (const entry of fileEntries) {
                entries.push(entry);
            }
        }

        return entries;
    }

    private async collectScenarioFiles(directoryPath: string): Promise<readonly string[]> {
        const files: string[] = [];
        const directoryEntries = await readdir(directoryPath, { withFileTypes: true });

        directoryEntries.sort((left, right): number => left.name.localeCompare(right.name));

        for (const directoryEntry of directoryEntries) {
            const entryPath: string = path.join(directoryPath, directoryEntry.name);

            if (directoryEntry.isDirectory()) {
                const childFiles: readonly string[] = await this.collectScenarioFiles(entryPath);

                for (const childFile of childFiles) {
                    files.push(childFile);
                }

                continue;
            }

            if (directoryEntry.isFile() && directoryEntry.name.endsWith(".ks")) {
                files.push(entryPath);
            }
        }

        return files;
    }

    private async extractFile(filePath: string, relativePath: string): Promise<readonly ExtractedTextEntry[]> {
        const text: string = await readFile(filePath, "utf8");
        const lines: readonly string[] = text.split(/\r?\n/u);
        const entries: ExtractedTextEntry[] = [];
        let isInsideScriptBlock: boolean = false;

        for (let index: number = 0; index < lines.length; index++) {
            const line: string = lines[index] ?? "";
            const lineNumber: number = index + 1;
            const trimmedLine: string = line.trim();

            if (this.isScriptBlockStart(trimmedLine)) {
                isInsideScriptBlock = true;
                continue;
            }

            if (this.isScriptBlockEnd(trimmedLine)) {
                isInsideScriptBlock = false;
                continue;
            }

            if (isInsideScriptBlock || this.shouldSkipWholeLine(trimmedLine)) {
                continue;
            }

            this.extractCharacterNameLine(line, filePath, relativePath, lineNumber, entries);
            this.extractTagAttributes(line, filePath, relativePath, lineNumber, entries);
            this.extractDialogueLine(line, filePath, relativePath, lineNumber, entries);
        }

        return entries;
    }

    private shouldSkipWholeLine(trimmedLine: string): boolean {
        return trimmedLine.length === 0
            || trimmedLine.startsWith(";")
            || trimmedLine.startsWith("*");
    }

    private isScriptBlockStart(trimmedLine: string): boolean {
        return trimmedLine === "[iscript]" || trimmedLine === "@iscript";
    }

    private isScriptBlockEnd(trimmedLine: string): boolean {
        return trimmedLine === "[endscript]" || trimmedLine === "@endscript";
    }

    private extractCharacterNameLine(
        line: string,
        filePath: string,
        relativePath: string,
        lineNumber: number,
        entries: ExtractedTextEntry[]
    ): void {
        const trimmedLine: string = line.trim();

        if (!trimmedLine.startsWith("#")) {
            return;
        }

        const characterName: string = trimmedLine.slice(1).trim();

        if (characterName.length === 0) {
            return;
        }

        this.addTextSegments(characterName, "characterName", filePath, relativePath, lineNumber, entries);
    }

    private extractTagAttributes(
        line: string,
        filePath: string,
        relativePath: string,
        lineNumber: number,
        entries: ExtractedTextEntry[]
    ): void {
        const tags: readonly TyranoTag[] = this.parseTags(line);

        for (const tag of tags) {
            for (const attribute of this.translatableAttributes) {
                if (tag.name !== attribute.tagName) {
                    continue;
                }

                const value: string | undefined = tag.attributes.get(attribute.attributeName);

                if (value === undefined) {
                    continue;
                }

                this.addTextSegments(value, attribute.kind, filePath, relativePath, lineNumber, entries);
            }
        }
    }

    private extractDialogueLine(
        line: string,
        filePath: string,
        relativePath: string,
        lineNumber: number,
        entries: ExtractedTextEntry[]
    ): void {
        const trimmedLine: string = line.trim();

        if (trimmedLine.startsWith("[") || trimmedLine.startsWith("@") || trimmedLine.startsWith("#")) {
            return;
        }

        const textWithoutTags: string = this.removeInlineTags(line);
        this.addTextSegments(textWithoutTags, "dialogue", filePath, relativePath, lineNumber, entries);
    }

    private parseTags(line: string): readonly TyranoTag[] {
        const tags: TyranoTag[] = [];

        for (const bracketTag of this.parseBracketTags(line)) {
            tags.push(bracketTag);
        }

        const atTag: TyranoTag | null = this.parseAtTag(line);

        if (atTag !== null) {
            tags.push(atTag);
        }

        return tags;
    }

    private parseBracketTags(line: string): readonly TyranoTag[] {
        const tags: TyranoTag[] = [];
        const tagRegex: RegExp = /\[([A-Za-z0-9_]+)([^\]]*)\]/gu;
        let match: RegExpExecArray | null = tagRegex.exec(line);

        while (match !== null) {
            const tagName: string | undefined = match[1];
            const attributeText: string | undefined = match[2];

            if (tagName !== undefined && attributeText !== undefined) {
                tags.push({
                    name: tagName,
                    attributes: this.parseAttributes(attributeText)
                });
            }

            match = tagRegex.exec(line);
        }

        return tags;
    }

    private parseAtTag(line: string): TyranoTag | null {
        const trimmedLine: string = line.trim();

        if (!trimmedLine.startsWith("@")) {
            return null;
        }

        const content: string = trimmedLine.slice(1);
        const firstSpaceIndex: number = content.search(/\s/u);

        if (firstSpaceIndex < 0) {
            return {
                name: content,
                attributes: new Map<string, string>()
            };
        }

        return {
            name: content.slice(0, firstSpaceIndex),
            attributes: this.parseAttributes(content.slice(firstSpaceIndex + 1))
        };
    }

    private parseAttributes(attributeText: string): ReadonlyMap<string, string> {
        const attributes: Map<string, string> = new Map<string, string>();
        let index: number = 0;

        while (index < attributeText.length) {
            index = this.skipWhitespace(attributeText, index);

            const keyStartIndex: number = index;

            while (index < attributeText.length && !this.isAttributeNameEnd(attributeText[index] ?? "")) {
                index++;
            }

            const key: string = attributeText.slice(keyStartIndex, index);
            index = this.skipWhitespace(attributeText, index);

            if (key.length === 0 || attributeText[index] !== "=") {
                index++;
                continue;
            }

            index++;
            index = this.skipWhitespace(attributeText, index);

            const parsedValue: ParsedAttributeValue = this.parseAttributeValue(attributeText, index);
            attributes.set(key, parsedValue.value);
            index = parsedValue.nextIndex;
        }

        return attributes;
    }

    private parseAttributeValue(attributeText: string, startIndex: number): ParsedAttributeValue {
        if (attributeText[startIndex] === "\"") {
            return this.parseQuotedAttributeValue(attributeText, startIndex);
        }

        let index: number = startIndex;

        while (index < attributeText.length && !this.isWhitespace(attributeText[index] ?? "")) {
            index++;
        }

        return {
            value: attributeText.slice(startIndex, index),
            nextIndex: index
        };
    }

    private parseQuotedAttributeValue(attributeText: string, startIndex: number): ParsedAttributeValue {
        let index: number = startIndex + 1;
        let value: string = "";

        while (index < attributeText.length) {
            const currentCharacter: string = attributeText[index] ?? "";

            if (currentCharacter === "\"" && attributeText[index - 1] !== "\\") {
                return {
                    value: value.replaceAll("\\\"", "\""),
                    nextIndex: index + 1
                };
            }

            value += currentCharacter;
            index++;
        }

        return {
            value: value,
            nextIndex: index
        };
    }

    private addTextSegments(
        rawText: string,
        kind: ExtractedTextKind,
        filePath: string,
        relativePath: string,
        lineNumber: number,
        entries: ExtractedTextEntry[]
    ): void {
        const segments: readonly string[] = this.splitTextFromCode(rawText);

        for (const segment of segments) {
            const normalizedSegment: string = segment.trim();

            if (!this.isTranslatableText(normalizedSegment)) {
                continue;
            }

            entries.push({
                id: this.createEntryId(relativePath, lineNumber, entries.length),
                engineId: this.engineId,
                sourceText: normalizedSegment,
                kind: kind,
                location: {
                    filePath: filePath,
                    relativePath: relativePath,
                    lineNumber: lineNumber
                }
            });
        }
    }

    private splitTextFromCode(rawText: string): readonly string[] {
        // Translator-facing CSV should not ask the LLM to preserve engine control pieces.
        return rawText
            .split(/(\[[^\]]+\]|<[^>]+>|┻+|\\n|\\r)/gu)
            .filter((segment: string): boolean => !this.isCodeSegment(segment));
    }

    private removeInlineTags(line: string): string {
        return line.replaceAll(/\[[^\]]+\]/gu, "");
    }

    private isCodeSegment(segment: string): boolean {
        return segment.length === 0
            || /^\[[^\]]+\]$/u.test(segment)
            || /^<[^>]+>$/u.test(segment)
            || /^┻+$/u.test(segment)
            || /^\\[nr]$/u.test(segment);
    }

    private isTranslatableText(text: string): boolean {
        return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
    }

    private createEntryId(relativePath: string, lineNumber: number, entryIndex: number): string {
        return `${this.engineId}:${relativePath}:${lineNumber}:${entryIndex}`;
    }

    private skipWhitespace(text: string, startIndex: number): number {
        let index: number = startIndex;

        while (index < text.length && this.isWhitespace(text[index] ?? "")) {
            index++;
        }

        return index;
    }

    private isAttributeNameEnd(character: string): boolean {
        return character === "=" || this.isWhitespace(character);
    }

    private isWhitespace(character: string): boolean {
        return /\s/u.test(character);
    }
}

interface ParsedAttributeValue {
    readonly value: string;
    readonly nextIndex: number;
}
