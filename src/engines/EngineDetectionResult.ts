export interface EngineDetectionResult {
    readonly engineId: string;
    readonly engineName: string;
    readonly inputPath: string;
    readonly appRootPath: string;
    readonly scenarioDirectoryPath: string | null;
    readonly confidence: number;
    readonly evidence: readonly EngineEvidence[];
}

export interface EngineEvidence {
    readonly path: string;
    readonly message: string;
}

