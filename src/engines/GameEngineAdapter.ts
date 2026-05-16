import type { Result } from "../core/Result.js";
import type { EngineDetectionResult } from "./EngineDetectionResult.js";

export interface GameEngineAdapter {
    readonly engineId: string;
    readonly engineName: string;

    detect(inputPath: string): Promise<Result<EngineDetectionResult>>;
}

