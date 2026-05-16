export type ExtractedTextKind = "dialogue" | "characterName" | "tagAttribute";

export interface SourceLocation {
    readonly filePath: string;
    readonly relativePath: string;
    readonly lineNumber: number;
}

export interface ExtractedTextEntry {
    readonly id: string;
    readonly engineId: string;
    readonly sourceText: string;
    readonly kind: ExtractedTextKind;
    readonly location: SourceLocation;
}

