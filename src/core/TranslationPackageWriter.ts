import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Result } from "./Result.js";
import { Results } from "./Result.js";
import type { TranslationPackage } from "./TranslationPackage.js";

export interface TranslationPackageWriteResult {
    readonly outputPath: string;
}

export class TranslationPackageWriter {
    public async write(filePath: string, packageData: TranslationPackage): Promise<Result<TranslationPackageWriteResult>> {
        const outputPath: string = path.resolve(filePath);
        const outputDirectoryPath: string = path.dirname(outputPath);

        await mkdir(outputDirectoryPath, { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(packageData, null, 4)}\n`, "utf8");

        return Results.success({
            outputPath: outputPath
        });
    }
}

