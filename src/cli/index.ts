#!/usr/bin/env node

import type { Logger } from "../core/Logger.js";
import type { EngineDetectionResult, EngineEvidence } from "../engines/EngineDetectionResult.js";
import type { GameEngineAdapter } from "../engines/GameEngineAdapter.js";
import { ConsoleLogger } from "./ConsoleLogger.js";
import { EngineRegistry } from "../engines/EngineRegistry.js";
import { TranslationCsvReader } from "../core/TranslationCsvReader.js";
import { TranslationCsvRepairer } from "../core/TranslationCsvRepairer.js";
import type { TranslationCsvValidationResult } from "../core/TranslationCsvValidator.js";
import { TranslationCsvValidator } from "../core/TranslationCsvValidator.js";
import { TranslationCsvWriter } from "../core/TranslationCsvWriter.js";
import { TranslationPackageBuilder } from "../core/TranslationPackageBuilder.js";
import { TranslationPackageWriter } from "../core/TranslationPackageWriter.js";
import { TyranoScriptManagedInstaller } from "../engines/tyrano/TyranoScriptManagedInstaller.js";

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

        if (commandName === "validate") {
            return await this.runValidate(args);
        }

        if (commandName === "repair") {
            return await this.runRepair(args);
        }

        if (commandName === "build") {
            return await this.runBuild(args);
        }

        if (commandName === "install") {
            return await this.runInstall(args);
        }

        if (commandName === "uninstall") {
            return await this.runUninstall(args);
        }

        if (commandName === "verify-install") {
            return await this.runVerifyInstall(args);
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

    private async runValidate(args: readonly string[]): Promise<number> {
        const csvPath: string | undefined = args[1];

        if (csvPath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator validate <translation-csv>");
            return 1;
        }

        const reader: TranslationCsvReader = new TranslationCsvReader();
        const readResult = await reader.read(csvPath);

        if (!readResult.isSuccess) {
            this.logger.error(readResult.errorMessage);
            return 1;
        }

        const validator: TranslationCsvValidator = new TranslationCsvValidator();
        const validationResult: TranslationCsvValidationResult = validator.validate(readResult.value.entries);

        this.printCsvValidationResult(readResult.value.filePath, validationResult);

        return validationResult.hasErrors ? 1 : 0;
    }

    private async runRepair(args: readonly string[]): Promise<number> {
        const originalCsvPath: string | undefined = args[1];
        const translatedCsvPath: string | undefined = args[2];
        const outputCsvPath: string | undefined = args[3];

        if (originalCsvPath === undefined || translatedCsvPath === undefined || outputCsvPath === undefined) {
            this.logger.error(
                "Missing argument. Usage: opengametranslator repair <original-csv> <translated-tool-csv> <output-csv>"
            );
            return 1;
        }

        const reader: TranslationCsvReader = new TranslationCsvReader();
        const originalReadResult = await reader.read(originalCsvPath);

        if (!originalReadResult.isSuccess) {
            this.logger.error(originalReadResult.errorMessage);
            return 1;
        }

        const translatedReadResult = await reader.read(translatedCsvPath);

        if (!translatedReadResult.isSuccess) {
            this.logger.error(translatedReadResult.errorMessage);
            return 1;
        }

        const repairer: TranslationCsvRepairer = new TranslationCsvRepairer();
        const repairResult = repairer.repair(
            originalReadResult.value.entries,
            translatedReadResult.value.entries
        );

        if (!repairResult.isSuccess) {
            this.logger.error(repairResult.errorMessage);
            return 1;
        }

        const validator: TranslationCsvValidator = new TranslationCsvValidator();
        const validationResult: TranslationCsvValidationResult = validator.validate(repairResult.value.entries);

        if (validationResult.hasErrors) {
            this.printCsvValidationResult(outputCsvPath, validationResult);
            return 1;
        }

        const writer: TranslationCsvWriter = new TranslationCsvWriter();
        const writeResult = await writer.writeTranslations(outputCsvPath, repairResult.value.entries);

        if (!writeResult.isSuccess) {
            this.logger.error(writeResult.errorMessage);
            return 1;
        }

        this.logger.info(`Rows: ${repairResult.value.rowCount}`);
        this.logger.info(`Recovered translations: ${repairResult.value.translatedRows}`);
        this.logger.info(`Empty translations: ${repairResult.value.emptyTranslationRows}`);
        this.logger.info(`Output CSV: ${writeResult.value.outputPath}`);

        return 0;
    }

    private async runBuild(args: readonly string[]): Promise<number> {
        const csvPath: string | undefined = args[1];
        const outputPath: string | undefined = args[2];

        if (csvPath === undefined || outputPath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator build <translation-csv> <output-json>");
            return 1;
        }

        const reader: TranslationCsvReader = new TranslationCsvReader();
        const readResult = await reader.read(csvPath);

        if (!readResult.isSuccess) {
            this.logger.error(readResult.errorMessage);
            return 1;
        }

        const validator: TranslationCsvValidator = new TranslationCsvValidator();
        const validationResult: TranslationCsvValidationResult = validator.validate(readResult.value.entries);

        if (validationResult.hasErrors) {
            this.printCsvValidationResult(readResult.value.filePath, validationResult);
            return 1;
        }

        const builder: TranslationPackageBuilder = new TranslationPackageBuilder();
        const buildResult = builder.build(readResult.value.entries);

        if (!buildResult.isSuccess) {
            this.logger.error(buildResult.errorMessage);
            return 1;
        }

        const writer: TranslationPackageWriter = new TranslationPackageWriter();
        const writeResult = await writer.write(outputPath, buildResult.value.packageData);

        if (!writeResult.isSuccess) {
            this.logger.error(writeResult.errorMessage);
            return 1;
        }

        this.logger.info(`Input rows: ${buildResult.value.inputRowCount}`);
        this.logger.info(`Package entries: ${buildResult.value.packageEntryCount}`);
        this.logger.info(`Output package: ${writeResult.value.outputPath}`);

        return 0;
    }

    private async runInstall(args: readonly string[]): Promise<number> {
        const gamePath: string | undefined = args[1];
        const translationPackagePath: string | undefined = args[2];
        const gameExecutableName: string | null = args[3] ?? null;

        if (gamePath === undefined || translationPackagePath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator install <game-path> <translation-package> [game-exe-name]");
            return 1;
        }

        const installer: TyranoScriptManagedInstaller = new TyranoScriptManagedInstaller();
        const installResult = await installer.install({
            gamePath: gamePath,
            translationPackagePath: translationPackagePath,
            gameExecutableName: gameExecutableName
        });

        if (!installResult.isSuccess) {
            this.logger.error(installResult.errorMessage);
            return 1;
        }

        this.logger.info(`Game root: ${installResult.value.gameRootPath}`);
        this.logger.info(`App root: ${installResult.value.appRootPath}`);
        this.logger.info(`Workdir: ${installResult.value.workdirPath}`);
        this.logger.info(`Manifest: ${installResult.value.manifestPath}`);
        this.logger.info(`Patched file: ${installResult.value.patchedFilePath}`);
        this.logger.info(`Backup file: ${installResult.value.backupFilePath}`);
        this.logger.info(`Game executable: ${installResult.value.gameExecutableName}`);
        this.logger.info(`Run script: ${installResult.value.runBatPath}`);
        this.logger.info(`Restore script: ${installResult.value.restoreBatPath}`);

        return 0;
    }

    private async runUninstall(args: readonly string[]): Promise<number> {
        const gamePath: string | undefined = args[1];

        if (gamePath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator uninstall <game-path>");
            return 1;
        }

        const installer: TyranoScriptManagedInstaller = new TyranoScriptManagedInstaller();
        const uninstallResult = await installer.uninstall(gamePath);

        if (!uninstallResult.isSuccess) {
            this.logger.error(uninstallResult.errorMessage);
            return 1;
        }

        this.logger.info(`Restored file: ${uninstallResult.value.restoredFilePath}`);
        this.logger.info(`Backup file: ${uninstallResult.value.backupFilePath}`);

        return 0;
    }

    private async runVerifyInstall(args: readonly string[]): Promise<number> {
        const gamePath: string | undefined = args[1];

        if (gamePath === undefined) {
            this.logger.error("Missing argument. Usage: opengametranslator verify-install <game-path>");
            return 1;
        }

        const installer: TyranoScriptManagedInstaller = new TyranoScriptManagedInstaller();
        const verifyResult = await installer.verify(gamePath);

        if (!verifyResult.isSuccess) {
            this.logger.error(verifyResult.errorMessage);
            return 1;
        }

        this.logger.info(`Manifest: ${verifyResult.value.manifestPath}`);
        this.logger.info(`Patched file: ${verifyResult.value.patchedFilePath}`);
        this.logger.info(`Backup file: ${verifyResult.value.backupFilePath}`);
        this.logger.info(`Current SHA-256: ${verifyResult.value.currentSha256}`);
        this.logger.info(`Expected SHA-256: ${verifyResult.value.expectedPatchedSha256}`);
        this.logger.info(`Status: ${verifyResult.value.isInstalled ? "Installed" : "Changed"}`);

        return verifyResult.value.isInstalled ? 0 : 1;
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

    private printCsvValidationResult(filePath: string, result: TranslationCsvValidationResult): void {
        this.logger.info(`CSV: ${filePath}`);
        this.logger.info(`Rows: ${result.totalRows}`);
        this.logger.info(`Translated rows: ${result.translatedRows}`);
        this.logger.info(`Empty translations: ${result.emptyTranslationRows}`);
        this.logger.info(`Same as source: ${result.sameAsSourceRows}`);
        this.logger.info(`Empty source rows: ${result.emptySourceRows}`);
        this.logger.info(`Duplicate source rows: ${result.duplicateSourceRows}`);
        this.logger.info(`Status: ${result.hasErrors ? "Has errors" : "OK"}`);
    }

    private printHelp(): void {
        this.logger.info("OpenGameTranslator");
        this.logger.info("");
        this.logger.info("Usage:");
        this.logger.info("  opengametranslator detect <game-path>");
        this.logger.info("  opengametranslator extract <game-path> <output-csv>");
        this.logger.info("  opengametranslator validate <translation-csv>");
        this.logger.info("  opengametranslator repair <original-csv> <translated-tool-csv> <output-csv>");
        this.logger.info("  opengametranslator build <translation-csv> <output-json>");
        this.logger.info("  opengametranslator install <game-path> <translation-package> [game-exe-name]");
        this.logger.info("  opengametranslator verify-install <game-path>");
        this.logger.info("  opengametranslator uninstall <game-path>");
        this.logger.info("");
        this.logger.info("Commands:");
        this.logger.info("  detect    Detect the game engine from a local game directory.");
        this.logger.info("  extract   Extract translatable text to a two-column CSV.");
        this.logger.info("  validate  Validate a two-column translation CSV.");
        this.logger.info("  repair    Restore a two-column CSV when a tool overwrote the source column.");
        this.logger.info("  build     Build a runtime translation package from CSV.");
        this.logger.info("  install   Create a managed TyranoScript patch, workdir, and launch scripts.");
        this.logger.info("  verify-install  Verify the managed patch recorded in the manifest.");
        this.logger.info("  uninstall Restore the original file from the managed backup.");
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
