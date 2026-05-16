import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Result } from "../../core/Result.js";
import { Results } from "../../core/Result.js";
import { TyranoScriptAdapter } from "./TyranoScriptAdapter.js";

const WORKDIR_NAME = "OpenGameTranslator";
const MANIFEST_FILE_NAME = "manifest.json";
const RUNTIME_SOURCE_RELATIVE_PATH = "runtime/tyrano/opengametranslator-runtime.js";
const PACKAGE_FILE_NAME = "opengametranslator.package.json";
const MARKER_BEGIN = "<!-- OpenGameTranslator BEGIN -->";
const MARKER_END = "<!-- OpenGameTranslator END -->";
const PROJECT_ROOT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface TyranoManagedInstallOptions {
    readonly gamePath: string;
    readonly translationPackagePath: string;
    readonly gameExecutableName: string | null;
}

export interface TyranoManagedInstallResult {
    readonly gameRootPath: string;
    readonly appRootPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly gameExecutableName: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export interface TyranoManagedUninstallResult {
    readonly restoredFilePath: string;
    readonly backupFilePath: string;
}

export interface TyranoManagedVerifyResult {
    readonly manifestPath: string;
    readonly patchedFilePath: string;
    readonly backupFilePath: string;
    readonly isInstalled: boolean;
    readonly currentSha256: string;
    readonly expectedPatchedSha256: string;
}

interface ManagedInstallManifest {
    readonly formatVersion: 1;
    readonly engineId: "tyrano";
    readonly installMode: "managed-patch";
    readonly createdAt: string;
    readonly gameExecutableName: string;
    readonly appRootRelativePath: string;
    readonly runtimeRelativePath: string;
    readonly packageRelativePath: string;
    readonly patchedFile: ManagedPatchedFile;
}

interface ManagedPatchedFile {
    readonly relativePath: string;
    readonly backupRelativePath: string;
    readonly originalSha256: string;
    readonly patchedSha256: string;
}

interface ResolvedInstallPaths {
    readonly gameRootPath: string;
    readonly appRootPath: string;
    readonly indexPath: string;
    readonly workdirPath: string;
    readonly manifestPath: string;
    readonly runtimePath: string;
    readonly packagePath: string;
    readonly backupPath: string;
    readonly runBatPath: string;
    readonly restoreBatPath: string;
}

export class TyranoScriptManagedInstaller {
    public async install(options: TyranoManagedInstallOptions): Promise<Result<TyranoManagedInstallResult>> {
        const resolvedPathsResult: Result<ResolvedInstallPaths> = await this.resolveInstallPaths(options.gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedInstallPaths = resolvedPathsResult.value;
        const packageExists: boolean = await this.pathExists(options.translationPackagePath);

        if (!packageExists) {
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
        await copyFile(path.join(PROJECT_ROOT_PATH, RUNTIME_SOURCE_RELATIVE_PATH), resolvedPaths.runtimePath);
        await copyFile(path.resolve(options.translationPackagePath), resolvedPaths.packagePath);

        const patchResult: Result<ManagedPatchedFile> = await this.patchIndexHtml(resolvedPaths);

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
            appRootPath: resolvedPaths.appRootPath,
            workdirPath: resolvedPaths.workdirPath,
            manifestPath: resolvedPaths.manifestPath,
            patchedFilePath: resolvedPaths.indexPath,
            backupFilePath: resolvedPaths.backupPath,
            gameExecutableName: gameExecutableNameResult.value,
            runBatPath: resolvedPaths.runBatPath,
            restoreBatPath: resolvedPaths.restoreBatPath
        });
    }

    public async uninstall(gamePath: string): Promise<Result<TyranoManagedUninstallResult>> {
        const resolvedPathsResult: Result<ResolvedInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedInstallPaths = resolvedPathsResult.value;
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

    public async verify(gamePath: string): Promise<Result<TyranoManagedVerifyResult>> {
        const resolvedPathsResult: Result<ResolvedInstallPaths> = await this.resolveInstallPaths(gamePath);

        if (!resolvedPathsResult.isSuccess) {
            return Results.failure(resolvedPathsResult.errorMessage);
        }

        const resolvedPaths: ResolvedInstallPaths = resolvedPathsResult.value;
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
            isInstalled: currentSha256 === expectedPatchedSha256,
            currentSha256: currentSha256,
            expectedPatchedSha256: expectedPatchedSha256
        });
    }

    private async resolveInstallPaths(gamePath: string): Promise<Result<ResolvedInstallPaths>> {
        const adapter: TyranoScriptAdapter = new TyranoScriptAdapter();
        const detectionResult = await adapter.detect(gamePath);

        if (!detectionResult.isSuccess) {
            return Results.failure(detectionResult.errorMessage);
        }

        if (detectionResult.value.confidence <= 0) {
            return Results.failure("TyranoScript game was not detected.");
        }

        const gameRootPath: string = this.resolveGameRootPath(path.resolve(gamePath), detectionResult.value.appRootPath);
        const appRootPath: string = detectionResult.value.appRootPath;
        const indexPath: string = path.join(appRootPath, "index.html");
        const workdirPath: string = path.join(gameRootPath, WORKDIR_NAME);
        const backupPath: string = path.join(workdirPath, "backups", "resources__app.asar__index.html.bak");

        return Results.success({
            gameRootPath: gameRootPath,
            appRootPath: appRootPath,
            indexPath: indexPath,
            workdirPath: workdirPath,
            manifestPath: path.join(workdirPath, MANIFEST_FILE_NAME),
            runtimePath: path.join(workdirPath, "runtime", "tyrano", "opengametranslator-runtime.js"),
            packagePath: path.join(workdirPath, PACKAGE_FILE_NAME),
            backupPath: backupPath,
            runBatPath: path.join(gameRootPath, "run-me.bat"),
            restoreBatPath: path.join(gameRootPath, "restore-original.bat")
        });
    }

    private resolveGameRootPath(inputPath: string, appRootPath: string): string {
        const resourcesPath: string = path.dirname(appRootPath);
        const appRootName: string = path.basename(appRootPath);

        if (path.basename(resourcesPath) === "resources" && (appRootName === "app.asar" || appRootName === "app")) {
            return path.dirname(resourcesPath);
        }

        return inputPath;
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

    private async ensureWorkdir(resolvedPaths: ResolvedInstallPaths): Promise<void> {
        await mkdir(path.dirname(resolvedPaths.runtimePath), { recursive: true });
        await mkdir(path.dirname(resolvedPaths.backupPath), { recursive: true });
    }

    private async patchIndexHtml(resolvedPaths: ResolvedInstallPaths): Promise<Result<ManagedPatchedFile>> {
        const indexText: string = await readFile(resolvedPaths.indexPath, "utf8");
        const originalSha256: string = await this.ensureBackup(resolvedPaths, indexText);
        const loaderBlock: string = this.createLoaderBlock(resolvedPaths);
        const patchedTextResult: Result<string> = this.createPatchedIndexText(indexText, loaderBlock);

        if (!patchedTextResult.isSuccess) {
            return Results.failure(patchedTextResult.errorMessage);
        }

        await writeFile(resolvedPaths.indexPath, patchedTextResult.value, "utf8");

        return Results.success({
            relativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.indexPath)),
            backupRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.backupPath)),
            originalSha256: originalSha256,
            patchedSha256: await this.hashFile(resolvedPaths.indexPath)
        });
    }

    private async ensureBackup(resolvedPaths: ResolvedInstallPaths, indexText: string): Promise<string> {
        if (await this.pathExists(resolvedPaths.backupPath)) {
            return await this.hashFile(resolvedPaths.backupPath);
        }

        await writeFile(resolvedPaths.backupPath, indexText, "utf8");
        return this.hashText(indexText);
    }

    private createPatchedIndexText(indexText: string, loaderBlock: string): Result<string> {
        if (indexText.includes(MARKER_BEGIN) && indexText.includes(MARKER_END)) {
            const markerPattern: RegExp = new RegExp(`${this.escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${this.escapeRegExp(MARKER_END)}`);
            return Results.success(indexText.replace(markerPattern, loaderBlock.trimEnd()));
        }

        const kagTagScript: string = "<script type=\"text/javascript\" src=\"./tyrano/plugins/kag/kag.tag.js\" ></script>";
        const insertIndex: number = indexText.indexOf(kagTagScript);

        if (insertIndex < 0) {
            return Results.failure("Could not find TyranoScript kag.tag.js script tag in index.html.");
        }

        const insertPosition: number = insertIndex + kagTagScript.length;
        const beforeText: string = indexText.slice(0, insertPosition);
        const afterText: string = indexText.slice(insertPosition);

        return Results.success(`${beforeText}\n\n${loaderBlock}${afterText}`);
    }

    private createLoaderBlock(resolvedPaths: ResolvedInstallPaths): string {
        const indexDirectoryPath: string = path.dirname(resolvedPaths.indexPath);
        const packagePath: string = this.toBrowserPath(path.relative(indexDirectoryPath, resolvedPaths.packagePath));
        const runtimePath: string = this.toBrowserPath(path.relative(indexDirectoryPath, resolvedPaths.runtimePath));

        return `${MARKER_BEGIN}
<script>
window.OpenGameTranslatorConfig = {
    packagePath: "${packagePath}"
};
</script>
<script type="text/javascript" src="${runtimePath}"></script>
${MARKER_END}
`;
    }

    private async writeLaunchBats(resolvedPaths: ResolvedInstallPaths, gameExecutableName: string): Promise<void> {
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
set "BACKUP=%GAME_DIR%${WORKDIR_NAME}\\backups\\resources__app.asar__index.html.bak"
set "TARGET=%GAME_DIR%resources\\app.asar\\index.html"

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
        resolvedPaths: ResolvedInstallPaths,
        patchedFile: ManagedPatchedFile,
        gameExecutableName: string
    ): ManagedInstallManifest {
        return {
            formatVersion: 1,
            engineId: "tyrano",
            installMode: "managed-patch",
            createdAt: new Date().toISOString(),
            gameExecutableName: gameExecutableName,
            appRootRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.appRootPath)),
            runtimeRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.runtimePath)),
            packageRelativePath: this.toManifestPath(path.relative(resolvedPaths.gameRootPath, resolvedPaths.packagePath)),
            patchedFile: patchedFile
        };
    }

    private async readManifest(manifestPath: string): Promise<Result<ManagedInstallManifest>> {
        let manifestText: string;

        try {
            manifestText = await readFile(manifestPath, "utf8");
        } catch (error: unknown) {
            if (error instanceof Error) {
                return Results.failure(`Failed to read manifest: ${error.message}`);
            }

            return Results.failure("Failed to read manifest.");
        }

        const parsedManifest: unknown = JSON.parse(manifestText);

        if (!this.isManagedInstallManifest(parsedManifest)) {
            return Results.failure("Invalid OpenGameTranslator manifest.");
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
            && manifest["engineId"] === "tyrano"
            && manifest["installMode"] === "managed-patch"
            && typeof manifest["gameExecutableName"] === "string"
            && typeof manifest["appRootRelativePath"] === "string"
            && typeof manifest["runtimeRelativePath"] === "string"
            && typeof manifest["packageRelativePath"] === "string"
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

    private toBrowserPath(relativePath: string): string {
        return relativePath.split(path.sep).join("/");
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
}
