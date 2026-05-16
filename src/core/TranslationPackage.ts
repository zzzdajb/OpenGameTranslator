export interface TranslationPackage {
    readonly formatVersion: 1;
    readonly entries: readonly TranslationPackageEntry[];
}

export interface TranslationPackageEntry {
    readonly sourceText: string;
    readonly translatedText: string;
}

