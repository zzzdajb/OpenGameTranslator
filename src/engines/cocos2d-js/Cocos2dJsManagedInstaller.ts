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
const RUNTIME_SOURCE_RELATIVE_PATH = "runtime/cocos2d-js/opengametranslator-runtime.js";
const PACKAGE_FILE_NAME = "opengametranslator.package.json";
const MARKER_BEGIN = "// OpenGameTranslator BEGIN";
const MARKER_END = "// OpenGameTranslator END";
const PROJECT_ROOT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Cocos2dJsManagedInstallOptions {
    readonly gamePath: string;
    readonly translationPackagePath: string;
    readonly gameExecutableName: string | null;
}

export interface Cocos2dJsManagedInstallResult {
    readonly gameRootPath: string;
    readonly resourcesPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly runtimePath: string;
    readonly packagePath: string;
    readonly expectedRuntimeStatusPath: string;
    readonly gameExecutableName: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export interface Cocos2dJsManagedUninstallResult {
    readonly restoredFilePath: string;
    readonly backupFilePath: string;
}

export interface Cocos2dJsManagedVerifyResult {
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly expectedRuntimeStatusPath: string;
    readonly isInstalled: boolean;
    readonly currentSha256: string;
    readonly expectedPatchedSha256: string;
}

interface ManagedInstallManifest {
    readonly formatVersion: 1;
    readonly engineId: "cocos2d-js";
    readonly installMode: "runtime-translation-managed-patch";
    readonly createdAt: string;
    readonly gameExecutableName: string;
    readonly resourcesRelativePath: string;
    readonly runtimeRelativePath: string;
    readonly packageRelativePath: string;
    readonly expectedRuntimeStatusRelativePath: string;
    readonly patchedFile: ManagedPatchedFile;
}

interface ManagedPatchedFile {
    readonly relativePath: string;
    readonly backupRelativePath: string;
    readonly originalSha256: string;
    readonly patchedSha256: string;
}

interface ResolvedManagedInstallPaths {
    readonly gameRootPath: string;
    readonly resourcesPath: string;
    readonly jsbBootPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly runtimePath: string;
    readonly packagePath: string;
    readonly backupPath: string;
    readonly runtimeStatusPath: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export class Cocos2dJsManagedInstaller {
    public async install(options: Cocos2dJsManagedInstallOptions): Promise<Result<Cocos2dJsManagedInstallResult>> {
        const resolvedPathsResult: Result<ResolvedManagedInstallPaths> = await this.resolveInstallPaths(options.gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedManagedInstallPaths = resolvedPathsResult.value;

        if (!await this.pathExists(options.translationPackagePath)) {
            return Results.failure(`Translation package does not exist: ${path.resolve(options.translationPackagePath)}`);
        }

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
        await copyFile(path.resolve(options.translationPackagePath), resolvedPaths.packagePath);

        const patchResult: Result<ManagedPatchedFile> = await this.patchJsbBoot(resolvedPaths);

        if (!patchResult.isSuccess) {
            return Results.failure(patchResult.errorMessage);
        }

        await this.writeLaunchBats(resolvedPaths, gameExecutableNameResult.value);

        const manifest: ManagedInstallManifest = this.createManifest(
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
            packagePath: resolvedPaths.packagePath,
            expectedRuntimeStatusPath: resolvedPaths.runtimeStatusPath,
            gameExecutableName: gameExecutableNameResult.value,
            runBatPath: resolvedPaths.runBatPath,
            restoreBatPath: resolvedPaths.restoreBatPath
        });
    }

    public async uninstall(gamePath: string): Promise<Result<Cocos2dJsManagedUninstallResult>> {
        const resolvedPathsResult: Result<ResolvedManagedInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedManagedInstallPaths = resolvedPathsResult.value;
        const manifestResult: Result<ManagedInstallManifest> = await this.readManifest(resolvedPaths.manifestPath);

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

    public async verify(gamePath: string): Promise<Result<Cocos2dJsManagedVerifyResult>> {
        const resolvedPathsResult: Result<ResolvedManagedInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedManagedInstallPaths = resolvedPathsResult.value;
        const manifestResult: Result<ManagedInstallManifest> = await this.readManifest(resolvedPaths.manifestPath);

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
            expectedRuntimeStatusPath: resolvedPaths.runtimeStatusPath,
            isInstalled: currentSha256 === expectedPatchedSha256,
            currentSha256: currentSha256,
            expectedPatchedSha256: expectedPatchedSha256
        });
    }

    private async resolveInstallPaths(gamePath: string): Promise<Result<ResolvedManagedInstallPaths>> {
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
            runtimePath: path.join(workdirPath, "runtime", "cocos2d-js", "opengametranslator-runtime.js"),
            packagePath: path.join(workdirPath, PACKAGE_FILE_NAME),
            backupPath: path.join(workdirPath, "backups", "Resources__script__jsb_boot.js.bak"),
            runtimeStatusPath: path.join(workdirPath, "output", "opengametranslator-runtime-status.json"),
            runBatPath: path.join(gamePaths.gameRootPath, "run-me.bat"),
            restoreBatPath: path.join(gamePaths.gameRootPath, "restore-original.bat")
        });
    }

    private async resolveGameExecutableName(gameRootPath: string, requestedExecutableName: string | null): Promise<Result<string>> {
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

    private async ensureWorkdir(resolvedPaths: ResolvedManagedInstallPaths): Promise<void> {
        await mkdir(path.dirname(resolvedPaths.runtimePath), { recursive: true });
        await mkdir(path.dirname(resolvedPaths.backupPath), { recursive: true });
        await mkdir(path.dirname(resolvedPaths.runtimeStatusPath), { recursive: true });
    }

    private async cleanupGeneratedOutputFiles(resolvedPaths: ResolvedManagedInstallPaths): Promise<void> {
        const outputFilePaths: readonly string[] = [
            resolvedPaths.runtimeStatusPath,
            path.join(resolvedPaths.workdirPath, "output", "opengametranslator-loader.json"),
            path.join(resolvedPaths.workdirPath, "output", "opengametranslator-extracted-texts.json"),
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-loader.json"),
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-probe.json"),
            path.join(resolvedPaths.workdirPath, "probe-output", "opengametranslator-extracted-texts.json"),
            path.join(resolvedPaths.workdirPath, "runtime", "cocos2d-js", "opengametranslator-probe.js")
        ];

        for (const outputFilePath of outputFilePaths) {
            await this.deleteFileIfExists(outputFilePath);
        }
    }

    private async patchJsbBoot(resolvedPaths: ResolvedManagedInstallPaths): Promise<Result<ManagedPatchedFile>> {
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

    private async ensureBackup(resolvedPaths: ResolvedManagedInstallPaths, bootText: string): Promise<string> {
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
    var runtimePaths = [
        'OpenGameTranslator/runtime/cocos2d-js/opengametranslator-runtime.js',
        'Resources/OpenGameTranslator/runtime/cocos2d-js/opengametranslator-runtime.js',
        './OpenGameTranslator/runtime/cocos2d-js/opengametranslator-runtime.js'
    ];

    function loadByEval(filePath) {
        var fileUtils = typeof jsb !== 'undefined' && jsb && jsb.fileUtils ? jsb.fileUtils : null;

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

    for (var i = 0; i < runtimePaths.length; i += 1) {
        try {
            if (loadByEval(runtimePaths[i])) {
                return;
            }
        } catch (evalError) {
            // Try the next path.
        }

        try {
            require(runtimePaths[i]);
            return;
        } catch (requireError) {
            // Try the next path.
        }
    }
}());
${MARKER_END}
`;
    }

    private async writeLaunchBats(resolvedPaths: ResolvedManagedInstallPaths, gameExecutableName: string): Promise<void> {
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
        resolvedPaths: ResolvedManagedInstallPaths,
        patchedFile: ManagedPatchedFile,
        gameExecutableName: string
    ): ManagedInstallManifest {
        return {
            formatVersion: 1,
            engineId: "cocos2d-js",
            installMode: "runtime-translation-managed-patch",
            createdAt: new Date().toISOString(),
            gameExecutableName: gameExecutableName,
            resourcesRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.resourcesPath)),
            runtimeRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.runtimePath)),
            packageRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.packagePath)),
            expectedRuntimeStatusRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.runtimeStatusPath)),
            patchedFile: patchedFile
        };
    }

    private async readManifest(manifestPath: string): Promise<Result<ManagedInstallManifest>> {
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

        if (!this.isManagedInstallManifest(parsedManifest)) {
            return Results.failure("Invalid OpenGameTranslator Cocos managed install manifest.");
        }

        return Results.success(parsedManifest);
    }

    private isManagedInstallManifest(value: unknown): value is ManagedInstallManifest {
        if (typeof value !== "object" || value === null) {
            return false;
        }

        const manifest: Record<string, unknown> = value as Record<string, unknown>;
        const patchedFile: unknown = manifest["patchedFile"];

        return manifest["formatVersion"] === 1
            && manifest["engineId"] === "cocos2d-js"
            && manifest["installMode"] === "runtime-translation-managed-patch"
            && typeof manifest["gameExecutableName"] === "string"
            && typeof manifest["resourcesRelativePath"] === "string"
            && typeof manifest["runtimeRelativePath"] === "string"
            && typeof manifest["packageRelativePath"] === "string"
            && typeof manifest["expectedRuntimeStatusRelativePath"] === "string"
            && this.isManagedPatchedFile(patchedFile);
    }

    private isManagedPatchedFile(value: unknown): value is ManagedPatchedFile {
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
