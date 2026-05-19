#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_NERUKO_STRUCTURAL =
    "games/Neruko_wa_Sodatsu/Resources/OpenGameTranslator/output/opengametranslator-structural.json";
const DEFAULT_MAYA_STRUCTURAL =
    "games/maya/Resources/OpenGameTranslator/output/opengametranslator-structural.json";
const DEFAULT_OUTPUT = "output/agtk-action-group-compare.txt";

const NERUKO_TEXT_SYSTEM_RE =
    /テキスト表示|テキスト枠表示|次のテキスト|スキップ|ゲームイベント|文字数/u;
const MAYA_TEXT_SYSTEM_RE =
    /テキストフィールド表示|繰り返し|アニメーション変数|終了・次へ|音声再生|画面切り替え|設定　分岐|陽気|真面目|内気/u;
const MAYA_STORY_OBJECT_RE = /opening|ending|エンディング|day|event|テキスト/u;

const [, , nerukoArg, mayaArg, outputArg] = process.argv;
const nerukoPath = resolve(nerukoArg ?? DEFAULT_NERUKO_STRUCTURAL);
const mayaPath = resolve(mayaArg ?? DEFAULT_MAYA_STRUCTURAL);
const outputPath = resolve(outputArg ?? DEFAULT_OUTPUT);
const jsonOutputPath = outputPath.replace(/\.txt$/iu, ".json");

function main() {
    const neruko = loadStructural("Neruko_wa_Sodatsu", nerukoPath);
    const maya = loadStructural("Maya", mayaPath);
    const report = buildReport(neruko, maya);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(outputPath, buildTextReport(report), "utf8");

    console.log(`Report: ${outputPath}`);
    console.log(`Detail: ${jsonOutputPath}`);

    if (!report.ready) {
        process.exitCode = 2;
    }
}

function loadStructural(name, filePath) {
    if (!existsSync(filePath)) {
        return {
            name,
            filePath,
            exists: false,
            hasActionGroups: false,
            actionGroupCount: 0,
            focusedActionGroupCount: 0,
            focusedAnimationCount: 0,
            switchDefinitionCount: 0,
            imageDefinitionCount: 0,
            notes: [],
            groups: [],
        };
    }

    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const actionGroups = Array.isArray(data.actionGroups) ? data.actionGroups : [];
    const focusedActionGroups = Array.isArray(data.focusedActionGroups) ? data.focusedActionGroups : [];
    const focusedAnimations = Array.isArray(data.focusedAnimations) ? data.focusedAnimations : [];
    const switchDefinitions = Array.isArray(data.switchDefinitions) ? data.switchDefinitions : [];
    const imageDefinitions = Array.isArray(data.imageDefinitions) ? data.imageDefinitions : [];

    return {
        name,
        filePath,
        exists: true,
        hasActionGroups: Array.isArray(data.actionGroups),
        actionGroupCount: actionGroups.length,
        focusedActionGroupCount: focusedActionGroups.length,
        focusedAnimationCount: focusedAnimations.length,
        switchDefinitionCount: switchDefinitions.length,
        imageDefinitionCount: imageDefinitions.length,
        notes: Array.isArray(data.notes) ? data.notes : [],
        groups: actionGroups.map(normalizeGroup),
    };
}

function buildReport(neruko, maya) {
    const ready = neruko.hasActionGroups && maya.hasActionGroups;
    const dialogueTemplateGroups = neruko.groups
        .filter((group) => group.templateCount > 0 && /テキスト/u.test(group.objectName))
        .sort((a, b) => b.dialogueTemplateScore - a.dialogueTemplateScore)
        .slice(0, 20);
    const textSystemGroups = neruko.groups
        .filter((group) => group.nerukoTextSystemHintCount > 0)
        .sort((a, b) =>
            b.nerukoTextSystemScore - a.nerukoTextSystemScore
            || b.commandTotal - a.commandTotal
        )
        .slice(0, 20);

    const dialogueTemplateProfile = mergeProfiles(dialogueTemplateGroups.map((group) => group.profile));
    const textSystemProfile = mergeProfiles(textSystemGroups.map((group) => group.profile));
    const mayaSimilarityCandidates = maya.groups
        .map((group) => ({
            ...group,
            similarityToDialogueTemplateProfile: profileSimilarity(group.profile, dialogueTemplateProfile),
            similarityToTextSystemProfile: profileSimilarity(group.profile, textSystemProfile),
            mayaTextSystemScore: scoreMayaTextSystemGroup(group),
        }))
        .sort((a, b) =>
            b.similarityToDialogueTemplateProfile - a.similarityToDialogueTemplateProfile
            || b.similarityToTextSystemProfile - a.similarityToTextSystemProfile
            || b.displayRelatedCount - a.displayRelatedCount
            || b.commandTotal - a.commandTotal
        )
        .slice(0, 40);
    const mayaTextSystemCandidates = maya.groups
        .map((group) => ({
            ...group,
            similarityToDialogueTemplateProfile: profileSimilarity(group.profile, dialogueTemplateProfile),
            similarityToTextSystemProfile: profileSimilarity(group.profile, textSystemProfile),
            mayaTextSystemScore: scoreMayaTextSystemGroup(group),
        }))
        .filter((group) => group.mayaTextSystemScore > 0)
        .sort((a, b) =>
            b.mayaTextSystemScore - a.mayaTextSystemScore
            || b.similarityToTextSystemProfile - a.similarityToTextSystemProfile
            || b.displayRelatedCount - a.displayRelatedCount
            || b.commandTotal - a.commandTotal
        )
        .slice(0, 60);

    return {
        createdAt: new Date().toISOString(),
        ready,
        inputs: {
            neruko: neruko.filePath,
            maya: maya.filePath,
        },
        neruko: summarizeLoaded(neruko),
        maya: summarizeLoaded(maya),
        instructions: ready ? [] : [
            "Run both games once after install-probe so opengametranslator-structural.json contains actionGroups.",
            "For Maya: games/maya/run-me.bat",
            "For Neruko: games/Neruko_wa_Sodatsu/run-me.bat",
        ],
        dialogueTemplateGroups,
        textSystemGroups,
        dialogueTemplateProfile,
        textSystemProfile,
        mayaTextSystemCandidates,
        mayaSimilarityCandidates,
    };
}

function summarizeLoaded(game) {
    return {
        name: game.name,
        exists: game.exists,
        hasActionGroups: game.hasActionGroups,
        actionGroupCount: game.actionGroupCount,
        focusedActionGroupCount: game.focusedActionGroupCount,
        focusedAnimationCount: game.focusedAnimationCount,
        switchDefinitionCount: game.switchDefinitionCount,
        imageDefinitionCount: game.imageDefinitionCount,
        lastNote: game.notes[game.notes.length - 1] ?? "",
    };
}

function normalizeGroup(group) {
    const actions = Array.isArray(group.actions) ? group.actions : [];
    const templateCount = actions.filter((action) => isTemplateAction(action.name)).length;
    const dialogueLikeCount = actions.filter((action) => isDialogueLike(action.name)).length;
    const displayRelatedCount = Number(group.displayRelatedActionNameCount ?? 0);
    const nerukoTextSystemHintCount = countActionNameMatches(actions, NERUKO_TEXT_SYSTEM_RE);
    const mayaTextSystemHintCount = countActionNameMatches(actions, MAYA_TEXT_SYSTEM_RE);
    const mayaStoryObjectHint = MAYA_STORY_OBJECT_RE.test(String(group.objectName ?? ""));
    const commandTotal = Number(group.commandTotal ?? 0);
    const profile = buildProfile(group);

    return {
        path: String(group.path ?? ""),
        objectName: String(group.objectName ?? ""),
        actionCount: Number(group.actionCount ?? actions.length),
        sampledActionCount: Number(group.sampledActionCount ?? actions.length),
        commandTotal,
        templateCount,
        dialogueLikeCount,
        displayRelatedCount,
        nerukoTextSystemHintCount,
        mayaTextSystemHintCount,
        mayaStoryObjectHint,
        dialogueTemplateScore: templateCount * 12 + dialogueLikeCount * 4 + displayRelatedCount * 2,
        nerukoTextSystemScore: nerukoTextSystemHintCount * 10 + displayRelatedCount * 2 + commandTotal * 0.05,
        profile,
        actionSamples: actions.slice(0, 30).map((action) => ({
            index: action.index,
            name: action.name,
            commandCount: action.commandCount,
            commandKinds: action.commandKinds,
            messageVariableIds: action.messageVariableIds,
            switchVariableIds: action.switchVariableIds,
        })),
    };
}

function scoreMayaTextSystemGroup(group) {
    let score = 0;

    // Maya 的疑似剧情链集中在 Opening/*day 这类对象，动作名则反复出现
    // “文本框显示、循环、动画变量推进、场景结束”等控制步骤。
    if (group.mayaStoryObjectHint) {
        score += 25;
    }

    if (/^(\d+|なにもしない\d+)day$/iu.test(group.objectName)) {
        score += 20;
    }

    if (/opening|エンディング/iu.test(group.objectName)) {
        score += 15;
    }

    score += group.mayaTextSystemHintCount * 10;
    score += group.displayRelatedCount * 3;
    score += Math.min(group.commandTotal, 160) * 0.05;

    return score;
}

function buildProfile(group) {
    const profile = {};
    const actions = Array.isArray(group.actions) ? group.actions : [];

    addFeature(profile, "action-count", Math.min(Number(group.actionCount ?? actions.length), 100) / 10);
    addFeature(profile, "display-related", Number(group.displayRelatedActionNameCount ?? 0));
    addFeature(profile, "text-like", Number(group.textLikeActionNameCount ?? 0));

    for (const action of actions) {
        const commandKinds = isPlainObject(action.commandKinds) ? action.commandKinds : {};
        const commandTypeCounts = isPlainObject(action.commandTypeCounts) ? action.commandTypeCounts : {};

        for (const [kind, count] of Object.entries(commandKinds)) {
            addFeature(profile, `kind:${kind}`, Number(count));
        }

        for (const [commandType, count] of Object.entries(commandTypeCounts)) {
            addFeature(profile, `type:${commandType}`, Math.min(Number(count), 20));
        }

        if (Array.isArray(action.messageVariableIds) && action.messageVariableIds.length > 0) {
            addFeature(profile, "has-message-variable", 1);
        }

        if (Array.isArray(action.switchVariableIds) && action.switchVariableIds.length > 0) {
            addFeature(profile, "has-switch-variable", 1);
        }
    }

    return profile;
}

function mergeProfiles(profiles) {
    const merged = {};

    for (const profile of profiles) {
        for (const [key, value] of Object.entries(profile)) {
            addFeature(merged, key, value);
        }
    }

    const divisor = Math.max(profiles.length, 1);
    for (const key of Object.keys(merged)) {
        merged[key] = merged[key] / divisor;
    }

    return merged;
}

function profileSimilarity(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (const value of Object.values(left)) {
        leftNorm += value * value;
    }

    for (const value of Object.values(right)) {
        rightNorm += value * value;
    }

    for (const [key, value] of Object.entries(left)) {
        dot += value * (right[key] ?? 0);
    }

    if (leftNorm <= 0 || rightNorm <= 0) {
        return 0;
    }

    return dot / Math.sqrt(leftNorm * rightNorm);
}

function addFeature(profile, key, value) {
    if (!Number.isFinite(value) || value <= 0) {
        return;
    }

    profile[key] = (profile[key] ?? 0) + value;
}

function countActionNameMatches(actions, pattern) {
    return actions.filter((action) => typeof action.name === "string" && pattern.test(action.name)).length;
}

function isTemplateAction(text) {
    return typeof text === "string" && /テキスト１|消すテンプレ|出現テンプレ/u.test(text);
}

function isDialogueLike(text) {
    if (typeof text !== "string") {
        return false;
    }

    const normalized = text.trim();
    if (normalized.length < 3 || normalized.length > 60 || !/[ぁ-んァ-ヶ]/u.test(normalized)) {
        return false;
    }

    if (/アクション|オブジェクト|スイッチ|変数|テンプレ|設定|生成|消滅|切り替え|初期|重要|メニュー|タイトル|セーブ|ロード|経験値|座標|当たり判定|フレーム|パーティクル|レイヤー|コモン|分岐|処理|制御/u.test(normalized)) {
        return false;
    }

    return /[「」『』。、！？?？]/u.test(normalized) || normalized.length >= 8;
}

function buildTextReport(report) {
    const lines = [];

    lines.push("AGTK Action Group Comparison");
    lines.push("");
    lines.push(`Created: ${report.createdAt}`);
    lines.push(`Ready: ${report.ready ? "yes" : "no"}`);
    lines.push("");
    lines.push(`Neruko structural file: ${report.neruko.exists ? "found" : "missing"}`);
    lines.push(`Neruko actionGroups: ${report.neruko.hasActionGroups ? report.neruko.actionGroupCount : "missing"}`);
    lines.push(`Neruko focusedActionGroups: ${report.neruko.focusedActionGroupCount}`);
    lines.push(`Neruko focusedAnimations: ${report.neruko.focusedAnimationCount}`);
    lines.push(`Neruko switchDefinitions: ${report.neruko.switchDefinitionCount}`);
    lines.push(`Neruko imageDefinitions: ${report.neruko.imageDefinitionCount}`);
    lines.push(`Neruko last note: ${report.neruko.lastNote}`);
    lines.push(`Maya structural file: ${report.maya.exists ? "found" : "missing"}`);
    lines.push(`Maya actionGroups: ${report.maya.hasActionGroups ? report.maya.actionGroupCount : "missing"}`);
    lines.push(`Maya focusedActionGroups: ${report.maya.focusedActionGroupCount}`);
    lines.push(`Maya focusedAnimations: ${report.maya.focusedAnimationCount}`);
    lines.push(`Maya switchDefinitions: ${report.maya.switchDefinitionCount}`);
    lines.push(`Maya imageDefinitions: ${report.maya.imageDefinitionCount}`);
    lines.push(`Maya last note: ${report.maya.lastNote}`);
    lines.push("");

    if (!report.ready) {
        lines.push("Required Next Step:");
        for (const instruction of report.instructions) {
            lines.push(`  - ${instruction}`);
        }
        lines.push("");
        return `${lines.join("\n")}\n`;
    }

    lines.push("Neruko Dialogue Template Groups:");
    for (const group of report.dialogueTemplateGroups.slice(0, 10)) {
        appendGroup(lines, group, "  ");
    }
    lines.push("");

    lines.push("Neruko Text-System Groups:");
    for (const group of report.textSystemGroups.slice(0, 10)) {
        appendGroup(lines, group, "  ");
    }
    lines.push("");

    lines.push("Maya Focused Text-System Candidates:");
    for (const group of report.mayaTextSystemCandidates.slice(0, 25)) {
        lines.push(
            `  score=${group.mayaTextSystemScore.toFixed(1)} `
            + `textSystemSimilarity=${group.similarityToTextSystemProfile.toFixed(3)}`
        );
        appendGroup(lines, group, "    ");
    }
    lines.push("");

    lines.push("Maya Broad Structural Similarity Candidates:");
    for (const group of report.mayaSimilarityCandidates.slice(0, 15)) {
        lines.push(
            `  dialogueTemplateSimilarity=${group.similarityToDialogueTemplateProfile.toFixed(3)} `
            + `textSystemSimilarity=${group.similarityToTextSystemProfile.toFixed(3)}`
        );
        appendGroup(lines, group, "    ");
    }
    lines.push("");

    return `${lines.join("\n")}\n`;
}

function appendGroup(lines, group, indent) {
    lines.push(
        `${indent}${group.path} object="${group.objectName}" `
        + `actions=${group.actionCount} commands=${group.commandTotal} `
        + `templates=${group.templateCount} dialogueLike=${group.dialogueLikeCount} `
        + `display=${group.displayRelatedCount} textSystemHints=${group.mayaTextSystemHintCount ?? 0}`
    );

    const samples = group.actionSamples.slice(0, 12)
        .map((action) => `${action.index}:${action.name}`)
        .join(" | ");
    lines.push(`${indent}  ${samples}`);
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

main();
