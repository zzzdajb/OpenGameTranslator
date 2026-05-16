#!/usr/bin/env node

import type { Logger } from "../core/Logger.js";
import type { EngineDetectionResult, EngineEvidence } from "../engines/EngineDetectionResult.js";
import type { GameEngineAdapter } from "../engines/GameEngineAdapter.js";
import { ConsoleLogger } from "./ConsoleLogger.js";
import { EngineRegistry } from "../engines/EngineRegistry.js";
import { TranslationCsvWriter } from "../core/TranslationCsvWriter.js";

interface DetectedEngine {
    readonly adapter: GameEngineAdapter;
    readonly result: EngineDetectionResult;
}

class Program {
    public static async main(): Promise<void> {
        const logger: Logger = new ConsoleLogger();
        const registry: EngineRegistry = new EngineRegistry();
        const app: CliApplication = new CliApplication(logger, registry.getAdapters());

        process.exitCode = await app.run(process.argv.slice(2));
    }
}

class CliApplication {
    public constructor(
        private readonly logger: Logger,
        private readonly adapters: readonly GameEngineAdapter[]
    ) {
    }

    public async run(args: readonly string[]): Promise<number> {
        const commandName: string | undefined = args[0];

        if (commandName === undefined || commandName === "help" || commandName === "--help") {
            this.printHelp();
            return 0;
        }

        if (commandName === "detect") {
            return await this.runDetect(args);
        }

        if (commandName === "extract") {
            return await this.runExtract(args);
        }

        this.logger.error(`Unknown command: ${commandName}`);
        this.printHelp();
        return 1;
    }

    private async runDetect(args: readonly string[]): Promise<number> {
        const targetPath: string | undefined = args[1];

        if (targetPath === undefined) {
            this.logger.error("Missing path. Usage: opengametranslator detect <game-path>");
            return 1;
        }

        const detectedEngine: DetectedEngine | null = await this.detectBestEngine(targetPath);

        if (detectedEngine === null || detectedEngine.result.confidence <= 0) {
            this.logger.warn("No supported engine detected.");
            return 2;
        }

        this.printDetectionResult(detectedEngine.result);
        return 0;
    }

    private async runExtract(args: readonly string[]): Promise<number> {
        const targetPath: string | undefined = args[1];
        const outputPath: string | undefined = args[2];

        if (targetPath === undefined || outputPath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator extract <game-path> <output-csv>");
            return 1;
        }

        const detectedEngine: DetectedEngine | null = await this.detectBestEngine(targetPath);

        if (detectedEngine === null || detectedEngine.result.confidence <= 0) {
            this.logger.warn("No supported engine detected.");
            return 2;
        }

        const extractResult = await detectedEngine.adapter.extractText(targetPath);

        if (!extractResult.isSuccess) {
            this.logger.error(extractResult.errorMessage);
            return 1;
        }

        const writer: TranslationCsvWriter = new TranslationCsvWriter();
        const writeResult = await writer.write(outputPath, extractResult.value);

        if (!writeResult.isSuccess) {
            this.logger.error(writeResult.errorMessage);
            return 1;
        }

        this.logger.info(`Engine: ${detectedEngine.result.engineName} (${detectedEngine.result.engineId})`);
        this.logger.info(`Extracted entries: ${writeResult.value.totalEntryCount}`);
        this.logger.info(`Unique CSV rows: ${writeResult.value.uniqueSourceCount}`);
        this.logger.info(`Output CSV: ${writeResult.value.outputPath}`);

        return 0;
    }

    private async detectBestEngine(targetPath: string): Promise<DetectedEngine | null> {
        let bestResult: DetectedEngine | null = null;

        for (const adapter of this.adapters) {
            const result = await adapter.detect(targetPath);

            if (!result.isSuccess) {
                this.logger.warn(result.errorMessage);
                continue;
            }

            if (bestResult === null || result.value.confidence > bestResult.result.confidence) {
                bestResult = {
                    adapter: adapter,
                    result: result.value
                };
            }
        }

        return bestResult;
    }

    private printDetectionResult(result: EngineDetectionResult): void {
        this.logger.info(`Engine: ${result.engineName} (${result.engineId})`);
        this.logger.info(`Confidence: ${result.confidence}`);
        this.logger.info(`Input path: ${result.inputPath}`);
        this.logger.info(`App root: ${result.appRootPath}`);

        if (result.scenarioDirectoryPath !== null) {
            this.logger.info(`Scenario directory: ${result.scenarioDirectoryPath}`);
        }

        this.logger.info("Evidence:");

        for (const item of result.evidence) {
            this.printEvidence(item);
        }
    }

    private printEvidence(item: EngineEvidence): void {
        this.logger.info(`- ${item.message}: ${item.path}`);
    }

    private printHelp(): void {
        this.logger.info("OpenGameTranslator");
        this.logger.info("");
        this.logger.info("Usage:");
        this.logger.info("  opengametranslator detect <game-path>");
        this.logger.info("  opengametranslator extract <game-path> <output-csv>");
        this.logger.info("");
        this.logger.info("Commands:");
        this.logger.info("  detect    Detect the game engine from a local game directory.");
        this.logger.info("  extract   Extract translatable text to a two-column CSV.");
    }
}

Program.main().catch((error: unknown): void => {
    const logger: Logger = new ConsoleLogger();

    if (error instanceof Error) {
        logger.error(error.message);
    } else {
        logger.error(String(error));
    }

    process.exitCode = 1;
});
