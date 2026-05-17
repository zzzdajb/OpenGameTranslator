import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Result } from "../../core/Result.js";
import { Results } from "../../core/Result.js";
import { Cocos2dJsAdapter, type Cocos2dJsGamePaths } from "./Cocos2dJsAdapter.js";

const WORKDIR_NAME = "OpenGameTranslator";
const MANIFEST_FILE_NAME = "manifest.json";
const RUNTIME_SOURCE_RELATIVE_PATH = "runtime/cocos2d-js/opengametranslator-probe.js";
const MARKER_BEGIN = "// OpenGameTranslator BEGIN";
const MARKER_END = "// OpenGameTranslator END";
const PROJECT_ROOT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Cocos2dJsProbeInstallOptions {
    readonly gamePath: string;
    readonly gameExecutableName: string | null;
}

export interface Cocos2dJsProbeInstallResult {
    readonly gameRootPath: string;
    readonly resourcesPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly runtimePath: string;
    readonly expectedLoaderOutputPath: string;
    readonly expectedProbeOutputPath: string;
    readonly gameExecutableName: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export interface Cocos2dJsProbeUninstallResult {
    readonly restoredFilePath: string;
    readonly backupFilePath: string;
}

export interface Cocos2dJsProbeVerifyResult {
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly expectedLoaderOutputPath: string;
    readonly expectedProbeOutputPath: string;
    readonly isInstalled: boolean;
    readonly currentSha256: string;
    readonly expectedPatchedSha256: string;
}

interface ProbeInstallManifest {
    readonly formatVersion: 1;
    readonly engineId: "cocos2d-js";
    readonly installMode: "runtime-probe-managed-patch";
    readonly createdAt: string;
    readonly gameExecutableName: string;
    readonly resourcesRelativePath: string;
    readonly runtimeRelativePath: string;
    readonly expectedLoaderOutputRelativePath: string;
    readonly expectedProbeOutputRelativePath: string;
    readonly patchedFile: ProbePatchedFile;
}

interface ProbePatchedFile {
    readonly relativePath: string;
    readonly backupRelativePath: string;
    readonly originalSha256: string;
    readonly patchedSha256: string;
}

interface ResolvedProbeInstallPaths {
    readonly gameRootPath: string;
    readonly resourcesPath: string;
    readonly jsbBootPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly runtimePath: string;
    readonly backupPath: string;
    readonly loaderOutputPath: string;
    readonly probeOutputPath: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export class Cocos2dJsProbeInstaller {
    public async install(options: Cocos2dJsProbeInstallOptions): Promise<Result<Cocos2dJsProbeInstallResult>> {
        const resolvedPathsResult: Result<ResolvedProbeInstallPaths> = await this.resolveInstallPaths(options.gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedProbeInstallPaths = resolvedPathsResult.value;
        const gameExecutableNameResult: Result<string> = await this.resolveGameExecutableName(
            resolvedPaths.gameRootPath,
            options.gameExecutableName
        );

        if (!gameExecutableNameResult.isSuccess) {
            return Results.failure(gameExecutableNameResult.errorMessage);
        }

        await this.ensureWorkdir(resolvedPaths);
        await this.cleanupGeneratedOutputFiles(resolvedPaths);
        await copyFile(path.join(PROJECT_ROOT_PATH, RUNTIME_SOURCE_RELATIVE_PATH), resolvedPaths.runtimePath);

        const patchResult: Result<ProbePatchedFile> = await this.patchJsbBoot(resolvedPaths);

        if (!patchResult.isSuccess) {
            return Results.failure(patchResult.errorMessage);
        }

        await this.writeLaunchBats(resolvedPaths, gameExecutableNameResult.value);

        const manifest: ProbeInstallManifest = this.createManifest(
            resolvedPaths,
            patchResult.value,
            gameExecutableNameResult.value
        );

        await writeFile(resolvedPaths.manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");

        return Results.success({
            gameRootPath: resolvedPaths.gameRootPath,
            resourcesPath: resolvedPaths.resourcesPath,
            workdirPath: resolvedPaths.workdirPath,
            manifestPath: resolvedPaths.manifestPath,
            patchedFilePath: resolvedPaths.jsbBootPath,
            backupFilePath: resolvedPaths.backupPath,
            runtimePath: resolvedPaths.runtimePath,
            expectedLoaderOutputPath: resolvedPaths.loaderOutputPath,
            expectedProbeOutputPath: resolvedPaths.probeOutputPath,
            gameExecutableName: gameExecutableNameResult.value,
            runBatPath: resolvedPaths.runBatPath,
            restoreBatPath: resolvedPaths.restoreBatPath
        });
    }

    public async uninstall(gamePath: string): Promise<Result<Cocos2dJsProbeUninstallResult>> {
        const resolvedPathsResult: Result<ResolvedProbeInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedProbeInstallPaths = resolvedPathsResult.value;
        const manifestResult: Result<ProbeInstallManifest> = await this.readManifest(resolvedPaths.manifestPath);

        if (!manifestResult.isSuccess) {
            return Results.failure(manifestResult.errorMessage);
        }

        const backupPath: string = path.join(resolvedPaths.gameRootPath, manifestResult.value.patchedFile.backupRelativePath);
        const patchedFilePath: string = path.join(resolvedPaths.gameRootPath, manifestResult.value.patchedFile.relativePath);

        if (!await this.pathExists(backupPath)) {
            return Results.failure(`Backup file does not exist: ${backupPath}`);
        }

        await copyFile(backupPath, patchedFilePath);

        return Results.success({
            restoredFilePath: patchedFilePath,
            backupFilePath: backupPath
        });
    }

    public async verify(gamePath: string): Promise<Result<Cocos2dJsProbeVerifyResult>> {
        const resolvedPathsResult: Result<ResolvedProbeInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedProbeInstallPaths = resolvedPathsResult.value;
        const manifestResult: Result<ProbeInstallManifest> = await this.readManifest(resolvedPaths.manifestPath);

        if (!manifestResult.isSuccess) {
            return Results.failure(manifestResult.errorMessage);
        }

        const backupPath: string = path.join(resolvedPaths.gameRootPath, manifestResult.value.patchedFile.backupRelativePath);
        const patchedFilePath: string = path.join(resolvedPaths.gameRootPath, manifestResult.value.patchedFile.relativePath);

        if (!await this.pathExists(backupPath)) {
            return Results.failure(`Backup file does not exist: ${backupPath}`);
        }

        const currentSha256: string = await this.hashFile(patchedFilePath);
        const expectedPatchedSha256: string = manifestResult.value.patchedFile.patchedSha256;

        return Results.success({
            manifestPath: resolvedPaths.manifestPath,
            patchedFilePath: patchedFilePath,
            backupFilePath: backupPath,
            expectedLoaderOutputPath: resolvedPaths.loaderOutputPath,
            expectedProbeOutputPath: resolvedPaths.probeOutputPath,
            isInstalled: currentSha256 === expectedPatchedSha256,
            currentSha256: currentSha256,
            expectedPatchedSha256: expectedPatchedSha256
        });
    }

    private async resolveInstallPaths(gamePath: string): Promise<Result<ResolvedProbeInstallPaths>> {
        const adapter: Cocos2dJsAdapter = new Cocos2dJsAdapter();
        const gamePathsResult: Result<Cocos2dJsGamePaths> = await adapter.resolveGamePaths(gamePath);

        if (!gamePathsResult.isSuccess) {
            return Results.failure(gamePathsResult.errorMessage);
        }

        const gamePaths: Cocos2dJsGamePaths = gamePathsResult.value;
        const workdirPath: string = path.join(gamePaths.resourcesPath, WORKDIR_NAME);

        return Results.success({
            gameRootPath: gamePaths.gameRootPath,
            resourcesPath: gamePaths.resourcesPath,
            jsbBootPath: gamePaths.jsbBootPath,
            workdirPath: workdirPath,
            manifestPath: path.join(workdirPath, MANIFEST_FILE_NAME),
            runtimePath: path.join(workdirPath, "runtime", "cocos2d-js", "opengametranslator-probe.js"),
            backupPath: path.join(workdirPath, "backups", "Resources__script__jsb_boot.js.bak"),
            loaderOutputPath: path.join(workdirPath, "output", "opengametranslator-loader.json"),
            probeOutputPath: path.join(workdirPath, "output", "opengametranslator-extracted-texts.json"),
            runBatPath: path.join(gamePaths.gameRootPath, "run-me.bat"),
            restoreBatPath: path.join(gamePaths.gameRootPath, "restore-original.bat")
        });
    }

    private async resolveGameExecutableName(
        gameRootPath: string,
        requestedExecutableName: string | null
    ): Promise<Result<string>> {
        if (requestedExecutableName !== null) {
            const requestedPath: string = path.join(gameRootPath, requestedExecutableName);

            if (!await this.pathExists(requestedPath)) {
                return Results.failure(`Game executable does not exist: ${requestedPath}`);
            }

            return Results.success(requestedExecutableName);
        }

        const exeFiles: string[] = await this.findExeFiles(gameRootPath);

        if (exeFiles.length === 0) {
            return Results.failure("No game executable was found. Pass the executable file name explicitly.");
        }

        let bestExeName: string = exeFiles[0] ?? "";
        let bestSize: number = -1;

        for (const exeName of exeFiles) {
            const exeStat = await stat(path.join(gameRootPath, exeName));

            if (exeStat.size > bestSize) {
                bestExeName = exeName;
                bestSize = exeStat.size;
            }
        }

        return Results.success(bestExeName);
    }

    private async findExeFiles(gameRootPath: string): Promise<string[]> {
        const entries = await readdir(gameRootPath, { withFileTypes: true });
        const exeFiles: string[] = [];

        for (const entry of entries) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
                exeFiles.push(entry.name);
            }
        }

        return exeFiles;
    }

    private async ensureWorkdir(resolvedPaths: ResolvedProbeInstallPaths): Promise<void> {
        await mkdir(path.dirname(resolvedPaths.runtimePath), { recursive: true });
        await mkdir(path.dirname(resolvedPaths.backupPath), { recursive: true });
        await mkdir(path.dirname(resolvedPaths.probeOutputPath), { recursive: true });
    }

    private async cleanupGeneratedOutputFiles(resolvedPaths: ResolvedProbeInstallPaths): Promise<void> {
        const outputFilePaths: readonly string[] = [
            resolvedPaths.loaderOutputPath,
            resolvedPaths.probeOutputPath,
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-loader.json"),
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-probe.json"),
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-extracted-texts.json"),
            path.join(resolvedPaths.workdirPath, "output", "opengametranslator-runtime-status.json"),
            path.join(resolvedPaths.workdirPath, "opengametranslator.package.json"),
            path.join(resolvedPaths.workdirPath, "runtime", "cocos2d-js", "opengametranslator-runtime.js")
        ];

        for (const outputFilePath of outputFilePaths) {
            await this.deleteFileIfExists(outputFilePath);
        }
    }

    private async patchJsbBoot(resolvedPaths: ResolvedProbeInstallPaths): Promise<Result<ProbePatchedFile>> {
        const bootText: string = await readFile(resolvedPaths.jsbBootPath, "utf8");
        const originalSha256: string = await this.ensureBackup(resolvedPaths, bootText);
        const loaderBlock: string = this.createLoaderBlock();
        const patchedTextResult: Result<string> = this.createPatchedBootText(bootText, loaderBlock);

        if (!patchedTextResult.isSuccess) {
            return Results.failure(patchedTextResult.errorMessage);
        }

        await writeFile(resolvedPaths.jsbBootPath, patchedTextResult.value, "utf8");

        return Results.success({
            relativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.jsbBootPath)),
            backupRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.backupPath)),
            originalSha256: originalSha256,
            patchedSha256: await this.hashFile(resolvedPaths.jsbBootPath)
        });
    }

    private async ensureBackup(resolvedPaths: ResolvedProbeInstallPaths, bootText: string): Promise<string> {
        if (await this.pathExists(resolvedPaths.backupPath)) {
            return await this.hashFile(resolvedPaths.backupPath);
        }

        await writeFile(resolvedPaths.backupPath, bootText, "utf8");
        return this.hashText(bootText);
    }

    private createPatchedBootText(bootText: string, loaderBlock: string): Result<string> {
        const cleanBootText: string = this.removeExistingLoaderBlock(bootText);
        const insertNeedle = "delete cc.fileUtils;";
        const insertIndex: number = cleanBootText.indexOf(insertNeedle);

        if (insertIndex < 0) {
            return Results.failure("Could not find jsb.fileUtils initialization point in jsb_boot.js.");
        }

        const insertPosition: number = insertIndex + insertNeedle.length;
        const beforeText: string = cleanBootText.slice(0, insertPosition);
        const afterText: string = cleanBootText.slice(insertPosition);

        return Results.success(`${beforeText}\n${loaderBlock}${afterText}`);
    }

    private removeExistingLoaderBlock(bootText: string): string {
        if (!bootText.includes(MARKER_BEGIN) || !bootText.includes(MARKER_END)) {
            return bootText;
        }

        const markerPattern: RegExp = new RegExp(
            `^[ \\t]*${this.escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?^[ \\t]*${this.escapeRegExp(MARKER_END)}[ \\t]*\\r?\\n?`,
            "m"
        );

        return bootText.replace(markerPattern, "");
    }

    private createLoaderBlock(): string {
        return `${MARKER_BEGIN}
(function () {
    var probePaths = [
        'OpenGameTranslator/runtime/cocos2d-js/opengametranslator-probe.js',
        'Resources/OpenGameTranslator/runtime/cocos2d-js/opengametranslator-probe.js',
        './OpenGameTranslator/runtime/cocos2d-js/opengametranslator-probe.js'
    ];
    var outputPaths = [
        'OpenGameTranslator/output/opengametranslator-loader.json',
        'Resources/OpenGameTranslator/output/opengametranslator-loader.json'
    ];

    function writeLoaderStatus(status, detail) {
        try {
            var fileUtils = getFileUtils();

            if (!fileUtils || !fileUtils.writeStringToFile) {
                return;
            }

            var text = JSON.stringify({
                formatVersion: 1,
                engineId: 'cocos2d-js',
                mode: 'probe-loader',
                status: status,
                detail: String(detail || ''),
                at: new Date().toISOString()
            }, null, 2);

            for (var i = 0; i < outputPaths.length; i += 1) {
                try {
                    fileUtils.createDirectory && fileUtils.createDirectory(dirname(outputPaths[i]));
                    fileUtils.writeStringToFile(text, outputPaths[i]);
                } catch (writeError) {
                    // Keep trying the other path.
                }
            }
        } catch (error) {
            // Loader diagnostics must never affect the game.
        }
    }

    function dirname(filePath) {
        var index = filePath.lastIndexOf('/');
        return index < 0 ? '' : filePath.slice(0, index);
    }

    function getFileUtils() {
        if (typeof jsb !== 'undefined' && jsb && jsb.fileUtils) {
            return jsb.fileUtils;
        }

        return null;
    }

    function loadByEval(filePath) {
        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.getStringFromFile) {
            return false;
        }

        var scriptText = fileUtils.getStringFromFile(filePath);

        if (!scriptText || scriptText.length <= 0) {
            return false;
        }

        (0, eval)(scriptText);
        return true;
    }

    writeLoaderStatus('started', 'loader block entered');

    for (var i = 0; i < probePaths.length; i += 1) {
        try {
            if (loadByEval(probePaths[i])) {
                writeLoaderStatus('loaded-by-eval', probePaths[i]);
                return;
            }
        } catch (evalError) {
            writeLoaderStatus('eval-failed', probePaths[i] + ': ' + evalError);
        }

        try {
            require(probePaths[i]);
            writeLoaderStatus('loaded-by-require', probePaths[i]);
            return;
        } catch (requireError) {
            writeLoaderStatus('require-failed', probePaths[i] + ': ' + requireError);
        }
    }

    writeLoaderStatus('failed', 'all load attempts failed');
}());
${MARKER_END}
`;
    }

    private async writeLaunchBats(resolvedPaths: ResolvedProbeInstallPaths, gameExecutableName: string): Promise<void> {
        await writeFile(resolvedPaths.runBatPath, this.createRunBatText(gameExecutableName), "utf8");
        await writeFile(resolvedPaths.restoreBatPath, this.createRestoreBatText(), "utf8");
    }

    private createRunBatText(gameExecutableName: string): string {
        return `@echo off
setlocal
cd /d "%~dp0"
start "" "%~dp0${gameExecutableName}"
`;
    }

    private createRestoreBatText(): string {
        return `@echo off
setlocal
set "GAME_DIR=%~dp0"
set "BACKUP=%GAME_DIR%Resources\\${WORKDIR_NAME}\\backups\\Resources__script__jsb_boot.js.bak"
set "TARGET=%GAME_DIR%Resources\\script\\jsb_boot.js"

if not exist "%BACKUP%" (
    echo Backup file was not found.
    pause
    exit /b 1
)

copy /Y "%BACKUP%" "%TARGET%" >nul
if errorlevel 1 (
    echo Failed to restore original file.
    pause
    exit /b 1
)

echo Original file restored.
pause
`;
    }

    private createManifest(
        resolvedPaths: ResolvedProbeInstallPaths,
        patchedFile: ProbePatchedFile,
        gameExecutableName: string
    ): ProbeInstallManifest {
        return {
            formatVersion: 1,
            engineId: "cocos2d-js",
            installMode: "runtime-probe-managed-patch",
            createdAt: new Date().toISOString(),
            gameExecutableName: gameExecutableName,
            resourcesRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.resourcesPath)),
            runtimeRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.runtimePath)),
            expectedLoaderOutputRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.loaderOutputPath)),
            expectedProbeOutputRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.probeOutputPath)),
            patchedFile: patchedFile
        };
    }

    private async readManifest(manifestPath: string): Promise<Result<ProbeInstallManifest>> {
        let manifestText: string;
        let parsedManifest: unknown;

        try {
            manifestText = await readFile(manifestPath, "utf8");
            parsedManifest = JSON.parse(manifestText) as unknown;
        } catch (error: unknown) {
            if (error instanceof Error) {
                return Results.failure(`Failed to read manifest: ${error.message}`);
            }

            return Results.failure("Failed to read manifest.");
        }

        if (!this.isProbeInstallManifest(parsedManifest)) {
            return Results.failure("Invalid OpenGameTranslator Cocos probe manifest.");
        }

        return Results.success(parsedManifest);
    }

    private isProbeInstallManifest(value: unknown): value is ProbeInstallManifest {
        if (typeof value !== "object" || value === null) {
            return false;
        }

        const manifest: Record<string, unknown> = value as Record<string, unknown>;
        const patchedFile: unknown = manifest["patchedFile"];

        return manifest["formatVersion"] === 1
            && manifest["engineId"] === "cocos2d-js"
            && manifest["installMode"] === "runtime-probe-managed-patch"
            && typeof manifest["gameExecutableName"] === "string"
            && typeof manifest["resourcesRelativePath"] === "string"
            && typeof manifest["runtimeRelativePath"] === "string"
            && typeof manifest["expectedLoaderOutputRelativePath"] === "string"
            && typeof manifest["expectedProbeOutputRelativePath"] === "string"
            && this.isProbePatchedFile(patchedFile);
    }

    private isProbePatchedFile(value: unknown): value is ProbePatchedFile {
        if (typeof value !== "object" || value === null) {
            return false;
        }

        const patchedFile: Record<string, unknown> = value as Record<string, unknown>;

        return typeof patchedFile["relativePath"] === "string"
            && typeof patchedFile["backupRelativePath"] === "string"
            && typeof patchedFile["originalSha256"] === "string"
            && typeof patchedFile["patchedSha256"] === "string";
    }

    private async hashFile(filePath: string): Promise<string> {
        const fileBuffer: Buffer = await readFile(filePath);
        return createHash("sha256").update(fileBuffer).digest("hex");
    }

    private hashText(text: string): string {
        return createHash("sha256").update(text, "utf8").digest("hex");
    }

    private toManifestPath(relativePath: string): string {
        return relativePath.split(path.sep).join("/");
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private async pathExists(targetPath: string): Promise<boolean> {
        try {
            await access(targetPath, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    private async deleteFileIfExists(filePath: string): Promise<void> {
        try {
            await unlink(filePath);
        } catch (error: unknown) {
            if (typeof error === "object" && error !== null && "code" in error) {
                const nodeError: { readonly code?: unknown } = error;

                if (nodeError.code === "ENOENT") {
                    return;
                }
            }

            throw error;
        }
    }
}
