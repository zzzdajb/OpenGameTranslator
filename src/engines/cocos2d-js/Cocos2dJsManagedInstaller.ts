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

interface TranslationEntry {
    readonly sourceText: string;
    readonly translatedText: string;
}

interface TranslationPackage {
    readonly formatVersion: 1;
    readonly entries: readonly TranslationEntry[];
}

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
    readonly projectJsonPatched: boolean;
    readonly projectJsonReplacedCount: number;
}

export interface Cocos2dJsManagedUninstallResult {
    readonly restoredFilePath: string;
    readonly backupFilePath: string;
    readonly projectJsonRestored: boolean;
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
    projectJson?: ManagedPatchedFile;
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
    readonly projectJsonPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly runtimePath: string;
    readonly packagePath: string;
    readonly backupPath: string;
    readonly projectJsonBackupPath: string;
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

        // Patch data/project.json on disk with translations.
        let projectJsonPatched: boolean = false;
        let projectJsonReplacedCount: number = 0;
        let projectJsonPatchFile: ManagedPatchedFile | undefined;

        if (await this.pathExists(resolvedPaths.projectJsonPath)) {
            const projectJsonPatchResult: Result<ManagedPatchedFile | undefined> = await this.patchProjectJson(
                resolvedPaths,
                path.resolve(options.translationPackagePath)
            );

            if (projectJsonPatchResult.isSuccess) {
                projectJsonPatchFile = projectJsonPatchResult.value;
                projectJsonPatched = projectJsonPatchFile !== undefined;
                projectJsonReplacedCount = projectJsonPatchFile !== undefined ? 1 : 0;
            }
            // Project JSON patching is best-effort for translation mode; don't block install.
        }

        await this.writeLaunchBats(resolvedPaths, gameExecutableNameResult.value);

        const manifest: ManagedInstallManifest = this.createManifest(
            resolvedPaths,
            patchResult.value,
            projectJsonPatchFile,
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
            restoreBatPath: resolvedPaths.restoreBatPath,
            projectJsonPatched: projectJsonPatched,
            projectJsonReplacedCount: projectJsonReplacedCount
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

        const manifest: ManagedInstallManifest = manifestResult.value;
        const backupPath: string = path.join(resolvedPaths.gameRootPath, manifest.patchedFile.backupRelativePath);
        const patchedFilePath: string = path.join(resolvedPaths.gameRootPath, manifest.patchedFile.relativePath);

        if (!await this.pathExists(backupPath)) {
            return Results.failure(`Backup file does not exist: ${backupPath}`);
        }

        await copyFile(backupPath, patchedFilePath);

        // Restore project.json if it was patched.
        let projectJsonRestored: boolean = false;

        if (manifest.projectJson !== undefined) {
            const projectJsonBackupPath: string = path.join(
                resolvedPaths.gameRootPath,
                manifest.projectJson.backupRelativePath
            );
            const projectJsonTargetPath: string = path.join(
                resolvedPaths.gameRootPath,
                manifest.projectJson.relativePath
            );

            if (await this.pathExists(projectJsonBackupPath)) {
                await copyFile(projectJsonBackupPath, projectJsonTargetPath);
                projectJsonRestored = true;
            }
        }

        return Results.success({
            restoredFilePath: patchedFilePath,
            backupFilePath: backupPath,
            projectJsonRestored: projectJsonRestored
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
            projectJsonPath: path.join(gamePaths.resourcesPath, "data", "project.json"),
            workdirPath: workdirPath,
            manifestPath: path.join(workdirPath, MANIFEST_FILE_NAME),
            runtimePath: path.join(workdirPath, "runtime", "cocos2d-js", "opengametranslator-runtime.js"),
            packagePath: path.join(workdirPath, PACKAGE_FILE_NAME),
            backupPath: path.join(workdirPath, "backups", "Resources__script__jsb_boot.js.bak"),
            projectJsonBackupPath: path.join(workdirPath, "backups", "Resources__data__project.json.bak"),
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
            path.join(resolvedPaths.workdirPath, "runtime", "cocos2d-js", "opengametranslator-probe.js"),
            resolvedPaths.projectJsonBackupPath
        ];

        for (const outputFilePath of outputFilePaths) {
            await this.deleteFileIfExists(outputFilePath);
        }
    }

    private async patchProjectJson(
        resolvedPaths: ResolvedManagedInstallPaths,
        translationPackagePath: string
    ): Promise<Result<ManagedPatchedFile | undefined>> {
        const packageText: string = await readFile(translationPackagePath, "utf8");
        let packageData: unknown;

        try {
            packageData = JSON.parse(packageText) as unknown;
        } catch {
            return Results.failure("Failed to parse translation package JSON.");
        }

        if (!isTranslationPackage(packageData) || packageData.entries.length === 0) {
            return Results.failure("Invalid or empty translation package.");
        }

        const translations: Map<string, string> = new Map();
        for (const entry of packageData.entries) {
            const key: string = normalizeText(entry.sourceText);

            if (key.length > 0 && entry.translatedText.length > 0) {
                translations.set(entry.sourceText, entry.translatedText);
                translations.set(key, entry.translatedText);
            }
        }

        if (translations.size === 0) {
            return Results.success(undefined);
        }

        const projectJsonText: string = await readFile(resolvedPaths.projectJsonPath, "utf8");
        let projectData: unknown;

        try {
            projectData = JSON.parse(projectJsonText) as unknown;
        } catch {
            return Results.failure("Failed to parse data/project.json.");
        }

        let replacedCount: number = 0;

        const replaceStrings = (value: unknown, depth: number): void => {
            if (depth > 80 || value === null || typeof value !== "object") {
                return;
            }

            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i += 1) {
                    if (typeof value[i] === "string") {
                        const translation: string | undefined = translations.get(value[i]) ?? translations.get(normalizeText(value[i]));

                        if (translation !== undefined) {
                            value[i] = translation;
                            replacedCount += 1;
                        }
                    } else {
                        replaceStrings(value[i], depth + 1);
                    }
                }

                return;
            }

            for (const key in value) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) {
                    continue;
                }

                const val: unknown = (value as Record<string, unknown>)[key];

                if (typeof val === "string") {
                    const translation: string | undefined = translations.get(val) ?? translations.get(normalizeText(val));

                    if (translation !== undefined) {
                        (value as Record<string, unknown>)[key] = translation;
                        replacedCount += 1;
                    }
                } else {
                    replaceStrings(val, depth + 1);
                }
            }
        };

        replaceStrings(projectData, 0);

        if (replacedCount === 0) {
            return Results.success(undefined);
        }

        // Backup original before writing patched version.
        const originalSha256: string = createHash("sha256").update(projectJsonText, "utf8").digest("hex");
        await writeFile(resolvedPaths.projectJsonBackupPath, projectJsonText, "utf8");

        // Write patched project.json.
        const patchedText: string = JSON.stringify(projectData);
        await writeFile(resolvedPaths.projectJsonPath, patchedText, "utf8");
        const patchedSha256: string = createHash("sha256").update(patchedText, "utf8").digest("hex");

        const projectJsonRelativePath: string = path.relative(resolvedPaths.gameRootPath, resolvedPaths.projectJsonPath).split(path.sep).join("/");
        const projectJsonBackupRelativePath: string = path.relative(resolvedPaths.gameRootPath, resolvedPaths.projectJsonBackupPath).split(path.sep).join("/");

        return Results.success({
            relativePath: projectJsonRelativePath,
            backupRelativePath: projectJsonBackupRelativePath,
            originalSha256: originalSha256,
            patchedSha256: patchedSha256,
            _replacedCount: replacedCount
        } as unknown as ManagedPatchedFile);
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
set "WORKDIR=%GAME_DIR%Resources\\${WORKDIR_NAME}"
set "JSB_BACKUP=%WORKDIR%\\backups\\Resources__script__jsb_boot.js.bak"
set "JSB_TARGET=%GAME_DIR%Resources\\script\\jsb_boot.js"
set "PJ_BACKUP=%WORKDIR%\\backups\\Resources__data__project.json.bak"
set "PJ_TARGET=%GAME_DIR%Resources\\data\\project.json"

set "RESTORED=0"

if exist "%JSB_BACKUP%" (
    copy /Y "%JSB_BACKUP%" "%JSB_TARGET%" >nul
    if errorlevel 1 (
        echo Failed to restore jsb_boot.js.
    ) else (
        echo jsb_boot.js restored.
        set "RESTORED=1"
    )
) else (
    echo jsb_boot.js backup was not found.
)

if exist "%PJ_BACKUP%" (
    copy /Y "%PJ_BACKUP%" "%PJ_TARGET%" >nul
    if errorlevel 1 (
        echo Failed to restore project.json.
    ) else (
        echo project.json restored.
        set "RESTORED=1"
    )
) else (
    echo project.json backup was not found.
)

if "%RESTORED%"=="1" (
    echo Original files have been restored.
) else (
    echo No files were restored.
)

pause
`;
    }

    private createManifest(
        resolvedPaths: ResolvedManagedInstallPaths,
        patchedFile: ManagedPatchedFile,
        projectJsonPatch: ManagedPatchedFile | undefined,
        gameExecutableName: string
    ): ManagedInstallManifest {
        const manifest: ManagedInstallManifest = {
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

        if (projectJsonPatch !== undefined) {
            manifest.projectJson = projectJsonPatch;
        }

        return manifest;
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

        if (!isManagedInstallManifest(parsedManifest)) {
            return Results.failure("Invalid OpenGameTranslator Cocos managed install manifest.");
        }

        return Results.success(parsedManifest);
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

function isTranslationPackage(value: unknown): value is TranslationPackage {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const pkg: Record<string, unknown> = value as Record<string, unknown>;

    return pkg["formatVersion"] === 1
        && Array.isArray(pkg["entries"]);
}

function isManagedInstallManifest(value: unknown): value is ManagedInstallManifest {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const manifest: Record<string, unknown> = value as Record<string, unknown>;
    const patchedFile: unknown = manifest["patchedFile"];
    const projectJson: unknown = manifest["projectJson"];

    const baseValid: boolean = manifest["formatVersion"] === 1
        && manifest["engineId"] === "cocos2d-js"
        && manifest["installMode"] === "runtime-translation-managed-patch"
        && typeof manifest["gameExecutableName"] === "string"
        && typeof manifest["resourcesRelativePath"] === "string"
        && typeof manifest["runtimeRelativePath"] === "string"
        && typeof manifest["packageRelativePath"] === "string"
        && typeof manifest["expectedRuntimeStatusRelativePath"] === "string"
        && isManagedPatchedFile(patchedFile);

    if (!baseValid) {
        return false;
    }

    // projectJson is optional in the manifest.
    if (projectJson !== undefined && !isManagedPatchedFile(projectJson)) {
        return false;
    }

    return true;
}

function isManagedPatchedFile(value: unknown): value is ManagedPatchedFile {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const patchedFile: Record<string, unknown> = value as Record<string, unknown>;

    return typeof patchedFile["relativePath"] === "string"
        && typeof patchedFile["backupRelativePath"] === "string"
        && typeof patchedFile["originalSha256"] === "string"
        && typeof patchedFile["patchedSha256"] === "string";
}

function normalizeText(value: string): string {
    return value
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();
}
