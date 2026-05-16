import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

import type { EngineDetectionResult, EngineEvidence } from "../EngineDetectionResult.js";
import type { ExtractedTextEntry } from "../../core/ExtractedTextEntry.js";
import type { GameEngineAdapter } from "../GameEngineAdapter.js";
import type { Result } from "../../core/Result.js";
import { Results } from "../../core/Result.js";
import { TyranoScriptTextExtractor } from "./TyranoScriptTextExtractor.js";

export class TyranoScriptAdapter implements GameEngineAdapter {
    public readonly engineId: string = "tyrano";
    public readonly engineName: string = "TyranoScript";

    public async detect(inputPath: string): Promise<Result<EngineDetectionResult>> {
        const normalizedInputPath: string = path.resolve(inputPath);
        const inputExists: boolean = await this.pathExists(normalizedInputPath);

        if (!inputExists) {
            return Results.failure(`Path does not exist: ${normalizedInputPath}`);
        }

        const appRootPath: string | null = await this.findAppRootPath(normalizedInputPath);

        if (appRootPath === null) {
            return Results.success(this.createEmptyResult(normalizedInputPath));
        }

        const evidence: EngineEvidence[] = [];
        let score: number = 0;

        // Tyrano games can be checked without running the Windows executable.
        score += await this.addPackageEvidence(appRootPath, evidence);
        score += await this.addFileEvidence(appRootPath, "index.html", "index.html exists", evidence, 15);
        score += await this.addFileEvidence(appRootPath, "tyrano/plugins/kag/kag.tag.js", "KAG tag handler exists", evidence, 25);
        score += await this.addFileEvidence(appRootPath, "tyrano/plugins/kag/kag.js", "KAG core exists", evidence, 15);
        score += await this.addScenarioEvidence(appRootPath, evidence);
        score += await this.addElectronEvidence(appRootPath, evidence);

        const scenarioDirectoryPath: string = path.join(appRootPath, "data", "scenario");

        return Results.success({
            engineId: this.engineId,
            engineName: this.engineName,
            inputPath: normalizedInputPath,
            appRootPath: appRootPath,
            scenarioDirectoryPath: await this.pathExists(scenarioDirectoryPath) ? scenarioDirectoryPath : null,
            confidence: Math.min(score, 100),
            evidence: evidence
        });
    }

    public async extractText(inputPath: string): Promise<Result<readonly ExtractedTextEntry[]>> {
        const detectionResult: Result<EngineDetectionResult> = await this.detect(inputPath);

        if (!detectionResult.isSuccess) {
            return Results.failure(detectionResult.errorMessage);
        }

        if (detectionResult.value.scenarioDirectoryPath === null || detectionResult.value.confidence <= 0) {
            return Results.failure("TyranoScript scenario directory was not detected.");
        }

        const extractor: TyranoScriptTextExtractor = new TyranoScriptTextExtractor(this.engineId);
        const entries: readonly ExtractedTextEntry[] = await extractor.extractDirectory(detectionResult.value.scenarioDirectoryPath);

        return Results.success(entries);
    }

    private createEmptyResult(inputPath: string): EngineDetectionResult {
        return {
            engineId: this.engineId,
            engineName: this.engineName,
            inputPath: inputPath,
            appRootPath: "",
            scenarioDirectoryPath: null,
            confidence: 0,
            evidence: []
        };
    }

    private async findAppRootPath(inputPath: string): Promise<string | null> {
        if (await this.isTyranoAppRoot(inputPath)) {
            return inputPath;
        }

        const appAsarPath: string = path.join(inputPath, "resources", "app.asar");
        if (await this.isTyranoAppRoot(appAsarPath)) {
            return appAsarPath;
        }

        const appPath: string = path.join(inputPath, "resources", "app");
        if (await this.isTyranoAppRoot(appPath)) {
            return appPath;
        }

        return null;
    }

    private async isTyranoAppRoot(candidatePath: string): Promise<boolean> {
        const packagePath: string = path.join(candidatePath, "package.json");
        const tyranoTagPath: string = path.join(candidatePath, "tyrano", "plugins", "kag", "kag.tag.js");
        const scenarioPath: string = path.join(candidatePath, "data", "scenario");

        return await this.pathExists(packagePath)
            && await this.pathExists(tyranoTagPath)
            && await this.pathExists(scenarioPath);
    }

    private async addPackageEvidence(appRootPath: string, evidence: EngineEvidence[]): Promise<number> {
        const packagePath: string = path.join(appRootPath, "package.json");
        const packageText: string | null = await this.readTextIfExists(packagePath);

        if (packageText === null) {
            return 0;
        }

        if (packageText.includes("TyranoScript") || packageText.includes("tyranogame")) {
            evidence.push({
                path: packagePath,
                message: "package.json contains TyranoScript markers"
            });

            return 30;
        }

        evidence.push({
            path: packagePath,
            message: "package.json exists but does not contain a known Tyrano marker"
        });

        return 10;
    }

    private async addFileEvidence(
        appRootPath: string,
        relativePath: string,
        message: string,
        evidence: EngineEvidence[],
        score: number
    ): Promise<number> {
        const targetPath: string = path.join(appRootPath, relativePath);

        if (!await this.pathExists(targetPath)) {
            return 0;
        }

        evidence.push({
            path: targetPath,
            message: message
        });

        return score;
    }

    private async addScenarioEvidence(appRootPath: string, evidence: EngineEvidence[]): Promise<number> {
        const scenarioDirectoryPath: string = path.join(appRootPath, "data", "scenario");

        if (!await this.pathExists(scenarioDirectoryPath)) {
            return 0;
        }

        evidence.push({
            path: scenarioDirectoryPath,
            message: "data/scenario directory exists"
        });

        return 10;
    }

    private async addElectronEvidence(appRootPath: string, evidence: EngineEvidence[]): Promise<number> {
        const mainPath: string = path.join(appRootPath, "main.js");
        const mainText: string | null = await this.readTextIfExists(mainPath);

        if (mainText === null) {
            return 0;
        }

        if (!mainText.includes("TyranoErectron") && !mainText.includes("nodeIntegration")) {
            return 0;
        }

        evidence.push({
            path: mainPath,
            message: "Electron wrapper marker found"
        });

        return 10;
    }

    private async readTextIfExists(filePath: string): Promise<string | null> {
        if (!await this.pathExists(filePath)) {
            return null;
        }

        return await readFile(filePath, "utf8");
    }

    private async pathExists(targetPath: string): Promise<boolean> {
        try {
            await access(targetPath, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

}
