#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_STRUCTURAL =
    "games/maya/Resources/OpenGameTranslator/output/opengametranslator-structural.json";
const DEFAULT_EXTRACTED =
    "games/maya/Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json";
const DEFAULT_OUTPUT = "output/agtk-focused-text-system-report.txt";

const [, , structuralArg, extractedArg, outputArg] = process.argv;
const structuralPath = resolve(structuralArg ?? DEFAULT_STRUCTURAL);
const extractedPath = resolve(extractedArg ?? DEFAULT_EXTRACTED);
const outputPath = resolve(outputArg ?? DEFAULT_OUTPUT);
const jsonOutputPath = outputPath.replace(/\.txt$/iu, ".json");

function main() {
    const structural = loadJson(structuralPath);
    const extracted = loadJson(extractedPath);
    const report = buildReport(structural, extracted);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(outputPath, buildTextReport(report), "utf8");

    console.log(`Report: ${outputPath}`);
    console.log(`Detail: ${jsonOutputPath}`);
    if (!report.ready) {
        process.exitCode = 2;
    }
}

function loadJson(filePath) {
    if (!existsSync(filePath)) {
        return { exists: false, filePath };
    }

    return {
        exists: true,
        filePath,
        data: JSON.parse(readFileSync(filePath, "utf8")),
    };
}

function buildReport(structuralInput, extractedInput) {
    const structural = structuralInput.data ?? {};
    const extracted = extractedInput.data ?? {};
    const focusedGroups = Array.isArray(structural.focusedActionGroups) ? structural.focusedActionGroups : [];
    const focusedAnimations = Array.isArray(structural.focusedAnimations) ? structural.focusedAnimations : [];
    const decryptedImageExports = Array.isArray(structural.decryptedImageExports) ? structural.decryptedImageExports : [];
    const switchNames = buildSwitchNameMap(structural, extracted);
    const imageNames = buildImageNameMap(structural);

    return {
        createdAt: new Date().toISOString(),
        ready: structuralInput.exists && focusedGroups.length > 0,
        inputs: {
            structural: structuralInput.filePath,
            extracted: extractedInput.filePath,
        },
        counts: {
            focusedActionGroups: focusedGroups.length,
            focusedAnimations: focusedAnimations.length,
            switchDefinitions: Array.isArray(structural.switchDefinitions) ? structural.switchDefinitions.length : 0,
            imageDefinitions: Array.isArray(structural.imageDefinitions) ? structural.imageDefinitions.length : 0,
            decryptedImageExports: decryptedImageExports.length,
            successfulImageExports: decryptedImageExports.filter((item) => item.ok).length,
        },
        instructions: structuralInput.exists ? [] : [
            "Run install-probe, then run the game once so opengametranslator-structural.json is generated.",
        ],
        switchUsage: summarizeSwitchUsage(focusedGroups, switchNames),
        focusedGroups: summarizeFocusedGroups(focusedGroups, switchNames),
        focusedAnimations: summarizeFocusedAnimations(focusedAnimations, imageNames),
        decryptedImageExports: decryptedImageExports.slice(0, 220),
    };
}

function buildSwitchNameMap(structural, extracted) {
    const names = {};
    const definitions = Array.isArray(structural.switchDefinitions) ? structural.switchDefinitions : [];
    for (const item of definitions) {
        if (typeof item.id === "number") {
            names[String(item.id)] = item.name || "";
        }
    }

    // Older probe output did not include switchDefinitions. For AGTK global switches in
    // these samples, the runtime id is switchList index + 2014, so use that as fallback.
    const candidates = Array.isArray(extracted.candidateTexts) ? extracted.candidateTexts : [];
    for (const item of candidates) {
        const match = String(item.path ?? "").match(/^switchList\.(\d+)\.name$/u);
        if (match) {
            names[String(Number(match[1]) + 2014)] = String(item.text ?? "");
        }
    }

    return names;
}

function buildImageNameMap(structural) {
    const names = {};
    const definitions = Array.isArray(structural.imageDefinitions) ? structural.imageDefinitions : [];
    for (const item of definitions) {
        if (typeof item.id === "number") {
            names[String(item.id)] = {
                name: item.name || "",
                filename: item.filename || item.srcFilename || "",
            };
        }
    }

    return names;
}

function summarizeSwitchUsage(groups, switchNames) {
    const byId = {};

    for (const group of groups) {
        for (const action of group.actions ?? []) {
            for (const command of action.commandSamples ?? []) {
                const change = command.switchVariableChange;
                if (!change || !change.swtch || typeof change.switchId !== "number") {
                    continue;
                }

                const id = String(change.switchId);
                if (!byId[id]) {
                    byId[id] = {
                        switchId: change.switchId,
                        name: switchNames[id] ?? "",
                        count: 0,
                        samples: [],
                    };
                }

                byId[id].count += 1;
                if (byId[id].samples.length < 12) {
                    byId[id].samples.push({
                        groupPath: group.path,
                        groupName: group.objectName,
                        actionIndex: action.index,
                        actionName: action.name,
                        switchValue: change.switchValue,
                    });
                }
            }
        }
    }

    return Object.values(byId).sort((a, b) => b.count - a.count || a.switchId - b.switchId);
}

function summarizeFocusedGroups(groups, switchNames) {
    return groups
        .filter((group) => /Opening|Ending|エンディング|day|event|テキスト/u.test(group.objectName ?? ""))
        .map((group) => ({
            path: group.path,
            objectId: group.objectId,
            objectName: group.objectName,
            animationId: group.ownerFields?.animationId ?? null,
            actionCount: group.actionCount,
            commandTotal: group.commandTotal,
            actions: summarizeActions(group.actions ?? [], switchNames),
        }))
        .slice(0, 80);
}

function summarizeActions(actions, switchNames) {
    return actions
        .filter((action) => {
            if (/テキスト|繰り返し|アニメーション|終了|設定|^[0-9０-９]+$/u.test(action.name ?? "")) {
                return true;
            }

            return (action.commandSamples ?? []).some((command) => command.actionExec);
        })
        .slice(0, 80)
        .map((action) => ({
            index: action.index,
            id: action.id,
            name: action.name,
            switches: summarizeActionSwitches(action.commandSamples ?? [], switchNames),
            actionExec: (action.commandSamples ?? [])
                .filter((command) => command.actionExec)
                .map((command) => command.actionExec)
                .slice(0, 8),
        }));
}

function summarizeActionSwitches(commands, switchNames) {
    return commands
        .map((command) => command.switchVariableChange)
        .filter((change) => change && change.swtch && typeof change.switchId === "number")
        .map((change) => ({
            switchId: change.switchId,
            name: switchNames[String(change.switchId)] ?? "",
            value: change.switchValue,
        }))
        .slice(0, 12);
}

function summarizeFocusedAnimations(animations, imageNames) {
    return animations.slice(0, 80).map((animation) => ({
        path: animation.path,
        id: animation.id,
        name: animation.name,
        resources: (animation.resourceInfoList ?? []).slice(0, 24).map((resource) => ({
            id: resource.id ?? null,
            image: getResourceImageId(resource),
            imageName: imageNames[String(getResourceImageId(resource))]?.name ?? "",
            filename: imageNames[String(getResourceImageId(resource))]?.filename ?? "",
        })),
        motions: (animation.motionList ?? []).slice(0, 60).map((motion) => ({
            id: motion.id,
            name: motion.name,
            dispFrameCount300: motion.primitiveFields?.dispFrameCount300 ?? null,
            directions: (motion.directionList ?? []).slice(0, 4).map((direction) => ({
                id: direction.id,
                name: direction.primitiveFields?.name ?? "",
                animationName: direction.animationName,
                resourceInfoId: direction.primitiveFields?.resourceInfoId ?? null,
                imageWidth: direction.primitiveFields?.imageWidth ?? null,
                imageHeight: direction.primitiveFields?.imageHeight ?? null,
                frames: (direction.frameList ?? []).slice(0, 8),
            })),
        })),
    }));
}

function getResourceImageId(resource) {
    if (typeof resource.imageId === "number") {
        return resource.imageId;
    }

    if (typeof resource.image === "number") {
        return resource.image;
    }

    return null;
}

function buildTextReport(report) {
    const lines = [];

    lines.push("AGTK Focused Text-System Report");
    lines.push("");
    lines.push(`Created: ${report.createdAt}`);
    lines.push(`Ready: ${report.ready ? "yes" : "no"}`);
    lines.push(`focusedActionGroups: ${report.counts.focusedActionGroups}`);
    lines.push(`focusedAnimations: ${report.counts.focusedAnimations}`);
    lines.push(`switchDefinitions: ${report.counts.switchDefinitions}`);
    lines.push(`imageDefinitions: ${report.counts.imageDefinitions}`);
    lines.push(`decryptedImageExports: ${report.counts.successfulImageExports}/${report.counts.decryptedImageExports}`);
    lines.push("");

    if (!report.ready) {
        lines.push("Required Next Step:");
        for (const instruction of report.instructions) {
            lines.push(`  - ${instruction}`);
        }
        return `${lines.join("\n")}\n`;
    }

    lines.push("Top Switch Usage:");
    for (const item of report.switchUsage.slice(0, 30)) {
        lines.push(`  ${item.switchId} ${item.name || "(unknown)"} count=${item.count}`);
        for (const sample of item.samples.slice(0, 3)) {
            lines.push(`    ${sample.groupPath} ${sample.groupName} action=${sample.actionIndex}:${sample.actionName} value=${sample.switchValue}`);
        }
    }
    lines.push("");

    lines.push("Focused Groups:");
    for (const group of report.focusedGroups.slice(0, 20)) {
        lines.push(`  ${group.path} object="${group.objectName}" animationId=${group.animationId} actions=${group.actionCount} commands=${group.commandTotal}`);
        for (const action of group.actions.slice(0, 8)) {
            const switches = action.switches.map((item) => `${item.switchId}:${item.name}=${item.value}`).join(", ");
            lines.push(`    ${action.index}:${action.name}${switches ? ` switches=[${switches}]` : ""}${action.actionExec.length ? " actionExec=yes" : ""}`);
        }
    }
    lines.push("");

    lines.push("Focused Animations:");
    for (const animation of report.focusedAnimations.slice(0, 20)) {
        lines.push(`  ${animation.path} id=${animation.id} name="${animation.name}" resources=${animation.resources.length} motions=${animation.motions.length}`);
        for (const resource of animation.resources.slice(0, 8)) {
            lines.push(`    resource ${resource.id}: image=${resource.image} ${resource.imageName || ""} ${resource.filename || ""}`.trimEnd());
        }
        for (const motion of animation.motions.slice(0, 8)) {
            lines.push(`    motion ${motion.id}:${motion.name} frames=${motion.dispFrameCount300}`);
            for (const direction of motion.directions.slice(0, 2)) {
                lines.push(`      direction ${direction.id}:${direction.name} resourceInfoId=${direction.resourceInfoId} size=${direction.imageWidth}x${direction.imageHeight}`);
            }
        }
    }
    lines.push("");

    lines.push("Decrypted Image Exports:");
    for (const item of report.decryptedImageExports.slice(0, 30)) {
        lines.push(`  ${item.ok ? "ok" : "no"} image=${item.imageId} ${item.name || ""} ${item.filename || ""} -> ${item.outputPath || item.reason || ""}`);
    }
    lines.push("");

    return `${lines.join("\n")}\n`;
}

main();
