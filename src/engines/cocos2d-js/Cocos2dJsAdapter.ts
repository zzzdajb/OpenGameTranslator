import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtractedTextEntry } from "../../core/ExtractedTextEntry.js";
import type { Result } from "../../core/Result.js";
import { Results } from "../../core/Result.js";
import type { EngineDetectionResult, EngineEvidence } from "../EngineDetectionResult.js";
import type { GameEngineAdapter } from "../GameEngineAdapter.js";

export interface Cocos2dJsGamePaths {
    readonly gameRootPath: string;
    readonly resourcesPath: string;
    readonly jsbBootPath: string;
    readonly jsbLoaderPath: string;
    readonly cocos2dCorePath: string;
}

export class Cocos2dJsAdapter implements GameEngineAdapter {
    public readonly engineId: string = "cocos2d-js";
    public readonly engineName: string = "Cocos2d-JS";

    public async detect(inputPath: string): Promise<Result<EngineDetectionResult>> {
        const pathsResult: Result<Cocos2dJsGamePaths> = await this.resolveGamePaths(inputPath);

        if (!pathsResult.isSuccess) {
            if (pathsResult.errorMessage.startsWith("Path does not exist:")) {
                return Results.failure(pathsResult.errorMessage);
            }

            return Results.success(this.createEmptyResult(path.resolve(inputPath)));
        }

        const paths: Cocos2dJsGamePaths = pathsResult.value;
        const evidence: EngineEvidence[] = [];
        let score: number = 0;

        score += await this.addEngineVersionEvidence(paths.cocos2dCorePath, evidence);
        score += await this.addFileEvidence(paths.jsbBootPath, "JSB boot script exists", evidence, 20);
        score += await this.addFileEvidence(paths.jsbLoaderPath, "JSB loader script exists", evidence, 15);
        score += await this.addFileEvidence(path.join(paths.resourcesPath, "data", "project.json"), "project.json data file exists", evidence, 5);
        score += await this.addFileEvidence(path.join(paths.gameRootPath, "player.exe"), "native player.exe exists", evidence, 10);
        score += await this.addFileEvidence(path.join(paths.gameRootPath, "libcocos2d.dll"), "libcocos2d.dll exists", evidence, 10);
        score += await this.addFileEvidence(path.join(paths.gameRootPath, "mozjs-33.dll"), "SpiderMonkey mozjs-33.dll exists", evidence, 10);

        return Results.success({
            engineId: this.engineId,
            engineName: this.engineName,
            inputPath: path.resolve(inputPath),
            appRootPath: paths.resourcesPath,
            scenarioDirectoryPath: null,
            confidence: Math.min(score, 100),
            evidence: evidence
        });
    }

    public async extractText(inputPath: string): Promise<Result<readonly ExtractedTextEntry[]>> {
        const detectionResult: Result<EngineDetectionResult> = await this.detect(inputPath);

        if (!detectionResult.isSuccess) {
            return Results.failure(detectionResult.errorMessage);
        }

        if (detectionResult.value.confidence <= 0) {
            return Results.failure("Cocos2d-JS game was not detected.");
        }

        return Results.failure(
            "Cocos2d-JS static extraction is not implemented yet. Use install-probe to test runtime resource reading first."
        );
    }

    public async resolveGamePaths(inputPath: string): Promise<Result<Cocos2dJsGamePaths>> {
        const normalizedInputPath: string = path.resolve(inputPath);

        if (!await this.pathExists(normalizedInputPath)) {
            return Results.failure(`Path does not exist: ${normalizedInputPath}`);
        }

        const resourcesPath: string | null = await this.findResourcesPath(normalizedInputPath);

        if (resourcesPath === null) {
            return Results.failure("Cocos2d-JS Resources directory was not detected.");
        }

        const gameRootPath: string = path.basename(resourcesPath) === "Resources"
            ? path.dirname(resourcesPath)
            : normalizedInputPath;

        return Results.success({
            gameRootPath: gameRootPath,
            resourcesPath: resourcesPath,
            jsbBootPath: path.join(resourcesPath, "script", "jsb_boot.js"),
            jsbLoaderPath: path.join(resourcesPath, "script", "jsb.js"),
            cocos2dCorePath: path.join(resourcesPath, "script", "jsb_cocos2d.js")
        });
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

    private async findResourcesPath(inputPath: string): Promise<string | null> {
        if (await this.isResourcesRoot(inputPath)) {
            return inputPath;
        }

        const nestedResourcesPath: string = path.join(inputPath, "Resources");

        if (await this.isResourcesRoot(nestedResourcesPath)) {
            return nestedResourcesPath;
        }

        return null;
    }

    private async isResourcesRoot(candidatePath: string): Promise<boolean> {
        const cocos2dCorePath: string = path.join(candidatePath, "script", "jsb_cocos2d.js");
        const jsbBootPath: string = path.join(candidatePath, "script", "jsb_boot.js");
        const jsbLoaderPath: string = path.join(candidatePath, "script", "jsb.js");

        return await this.pathExists(cocos2dCorePath)
            && await this.pathExists(jsbBootPath)
            && await this.pathExists(jsbLoaderPath);
    }

    private async addEngineVersionEvidence(cocos2dCorePath: string, evidence: EngineEvidence[]): Promise<number> {
        if (!await this.pathExists(cocos2dCorePath)) {
            return 0;
        }

        const coreText: string = await readFile(cocos2dCorePath, "utf8");
        const versionMatch: RegExpMatchArray | null = coreText.match(/cc\.ENGINE_VERSION\s*=\s*["']([^"']+)["']/);
        const versionText: string | undefined = versionMatch?.[1];

        if (versionText !== undefined && versionText.includes("Cocos2d-JS")) {
            evidence.push({
                path: cocos2dCorePath,
                message: `Engine version marker found: ${versionText}`
            });

            return 40;
        }

        evidence.push({
            path: cocos2dCorePath,
            message: "jsb_cocos2d.js exists but no known Cocos2d-JS version marker was found"
        });

        return 20;
    }

    private async addFileEvidence(
        filePath: string,
        message: string,
        evidence: EngineEvidence[],
        score: number
    ): Promise<number> {
        if (!await this.pathExists(filePath)) {
            return 0;
        }

        evidence.push({
            path: filePath,
            message: message
        });

        return score;
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
