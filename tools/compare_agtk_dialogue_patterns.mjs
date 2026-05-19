#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_NERUKO_EXTRACTED =
    "games/Neruko_wa_Sodatsu/Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json";
const DEFAULT_MAYA_EXTRACTED =
    "games/maya/Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json";
const DEFAULT_OUTPUT = "output/agtk-dialogue-pattern-report.txt";

const [, , nerukoArg, mayaArg, outputArg] = process.argv;
const nerukoPath = resolve(nerukoArg ?? DEFAULT_NERUKO_EXTRACTED);
const mayaPath = resolve(mayaArg ?? DEFAULT_MAYA_EXTRACTED);
const outputPath = resolve(outputArg ?? DEFAULT_OUTPUT);
const jsonOutputPath = outputPath.replace(/\.txt$/iu, ".json");

function main() {
    const neruko = analyzeGame("Neruko_wa_Sodatsu", nerukoPath);
    const maya = analyzeGame("Maya", mayaPath);

    const report = {
        createdAt: new Date().toISOString(),
        inputs: {
            neruko: nerukoPath,
            maya: mayaPath,
        },
        neruko,
        maya,
        comparison: buildComparison(neruko, maya),
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(outputPath, buildTextReport(report), "utf8");

    console.log(`Report: ${outputPath}`);
    console.log(`Detail: ${jsonOutputPath}`);
}

function analyzeGame(name, filePath) {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const rows = Array.isArray(data.candidateTexts) ? data.candidateTexts : [];
    const actionNameRows = rows
        .map(parseActionNameRow)
        .filter((row) => row !== null);
    const groups = groupActionRows(actionNameRows);
    const groupSummaries = [...groups.values()]
        .map((group) => summarizeActionGroup(group))
        .sort((a, b) => b.score - a.score || b.dialogueLikeCount - a.dialogueLikeCount);

    return {
        name,
        filePath,
        candidateTextCount: rows.length,
        actionNameCount: actionNameRows.length,
        templateTermCounts: countTerms(actionNameRows.map((row) => row.text), [
            "テキスト１",
            "消すテンプレ",
            "出現テンプレ",
            "音声テキスト",
        ]),
        punctuationActionNameCount: actionNameRows.filter((row) => /[「」『』。、！？?？]/u.test(row.text)).length,
        dialogueLikeActionNameCount: actionNameRows.filter((row) => isDialogueLike(row.text)).length,
        strongestGroups: groupSummaries.slice(0, 30),
        templateGroups: groupSummaries.filter((group) => group.templateCount > 0).slice(0, 30),
        dialogueGroups: groupSummaries.filter((group) => group.dialogueLikeCount > 0).slice(0, 30),
    };
}

function parseActionNameRow(row) {
    if (typeof row?.path !== "string" || typeof row?.text !== "string") {
        return null;
    }

    const match = /^(.*)\.actionList\.(\d+)\.name$/u.exec(row.path);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        return null;
    }

    return {
        objectPath: match[1],
        actionIndex: Number.parseInt(match[2], 10),
        path: row.path,
        text: row.text,
    };
}

function groupActionRows(rows) {
    const groups = new Map();

    for (const row of rows) {
        const current = groups.get(row.objectPath) ?? {
            objectPath: row.objectPath,
            actions: [],
        };
        current.actions.push(row);
        groups.set(row.objectPath, current);
    }

    for (const group of groups.values()) {
        group.actions.sort((a, b) => a.actionIndex - b.actionIndex);
    }

    return groups;
}

function summarizeActionGroup(group) {
    const actions = group.actions;
    const templateActions = actions.filter((action) => isTemplateAction(action.text));
    const dialogueActions = actions.filter((action) => isDialogueLike(action.text));
    const displayActions = actions.filter((action) => isDisplayRelated(action.text));
    const punctuationActions = actions.filter((action) => /[「」『』。、！？?？]/u.test(action.text));
    const editorActions = actions.filter((action) => isEditorLabel(action.text));
    const score =
        templateActions.length * 10
        + dialogueActions.length * 6
        + displayActions.length * 3
        + punctuationActions.length * 2
        - editorActions.length * 2;

    return {
        objectPath: group.objectPath,
        actionCount: actions.length,
        templateCount: templateActions.length,
        displayRelatedCount: displayActions.length,
        dialogueLikeCount: dialogueActions.length,
        punctuationCount: punctuationActions.length,
        editorLabelCount: editorActions.length,
        score,
        sampleActions: actions.slice(0, 80).map((action) => ({
            index: action.actionIndex,
            text: action.text,
            kind: classifyActionName(action.text),
        })),
        dialogueSamples: dialogueActions.slice(0, 20).map((action) => ({
            index: action.actionIndex,
            text: action.text,
        })),
        templateSamples: templateActions.slice(0, 20).map((action) => ({
            index: action.actionIndex,
            text: action.text,
        })),
    };
}

function buildComparison(neruko, maya) {
    return {
        conclusion: [
            "Neruko has clear action-name dialogue templates in decrypted project JSON.",
            "Maya does not use the same visible template names in actionList.name.",
            "The next useful probe output is command-level action sequence summaries, not more plain string counts.",
        ],
        missingMayaTemplateTerms: Object.entries(neruko.templateTermCounts)
            .filter(([term, count]) => count > 0 && (maya.templateTermCounts[term] ?? 0) === 0)
            .map(([term]) => term),
        nerukoTopPositiveGroups: neruko.templateGroups.slice(0, 8),
        mayaClosestGroups: maya.strongestGroups.slice(0, 12),
    };
}

function countTerms(texts, terms) {
    const counts = {};
    for (const term of terms) {
        counts[term] = 0;
    }

    for (const text of texts) {
        for (const term of terms) {
            if (text.includes(term)) {
                counts[term] += 1;
            }
        }
    }

    return counts;
}

function classifyActionName(text) {
    if (isTemplateAction(text)) {
        return "template";
    }

    if (isDialogueLike(text)) {
        return "dialogue-like";
    }

    if (isDisplayRelated(text)) {
        return "display-related";
    }

    if (isEditorLabel(text)) {
        return "editor-label";
    }

    return "other";
}

function isTemplateAction(text) {
    return /テキスト１|消すテンプレ|出現テンプレ/u.test(text);
}

function isDisplayRelated(text) {
    return /テキスト|文字|字幕|会話|セリフ|台詞|吹き出し|表示|消す|出現|音声テキスト/u.test(text);
}

function isDialogueLike(text) {
    const normalized = text.trim();

    if (normalized.length < 3 || normalized.length > 55) {
        return false;
    }

    if (!/[ぁ-んァ-ヶ]/u.test(normalized)) {
        return false;
    }

    if (isTemplateAction(normalized) || isEditorLabel(normalized)) {
        return false;
    }

    if (/[「」『』。、！？?？]/u.test(normalized)) {
        return true;
    }

    return normalized.length >= 8 && !/[★↑↓←→]/u.test(normalized);
}

function isEditorLabel(text) {
    return /アクション|オブジェクト|スイッチ|変数|テンプレ|設定|生成|消滅|切り替え|初期|重要|stage|Stage|メニュー|タイトル|セーブ|ロード|戻る|終了|経験値|座標|当たり判定|フレーム|パーティクル|レイヤー|コモン|分岐|処理|制御|追加すること|わすれないこと/u.test(text);
}

function buildTextReport(report) {
    const lines = [];

    lines.push("AGTK Dialogue Pattern Comparison");
    lines.push("");
    lines.push(`Created: ${report.createdAt}`);
    lines.push(`Neruko input: ${report.inputs.neruko}`);
    lines.push(`Maya input: ${report.inputs.maya}`);
    lines.push("");
    appendGameSummary(lines, report.neruko);
    appendGameSummary(lines, report.maya);

    lines.push("Comparison:");
    for (const item of report.comparison.conclusion) {
        lines.push(`  - ${item}`);
    }
    lines.push(`  Missing Maya template terms: ${report.comparison.missingMayaTemplateTerms.join(", ") || "(none)"}`);
    lines.push("");

    lines.push("Neruko Positive Groups:");
    appendGroupList(lines, report.comparison.nerukoTopPositiveGroups, 8);
    lines.push("");

    lines.push("Maya Closest Groups:");
    appendGroupList(lines, report.comparison.mayaClosestGroups, 12);
    lines.push("");

    return `${lines.join("\n")}\n`;
}

function appendGameSummary(lines, game) {
    lines.push(`${game.name}:`);
    lines.push(`  Candidate texts: ${game.candidateTextCount}`);
    lines.push(`  actionList.name rows: ${game.actionNameCount}`);
    lines.push(`  Punctuation action names: ${game.punctuationActionNameCount}`);
    lines.push(`  Dialogue-like action names: ${game.dialogueLikeActionNameCount}`);
    lines.push("  Template terms:");
    for (const [term, count] of Object.entries(game.templateTermCounts)) {
        lines.push(`    ${term}: ${count}`);
    }
    lines.push("");
}

function appendGroupList(lines, groups, maxCount) {
    for (const group of groups.slice(0, maxCount)) {
        lines.push(
            `  ${group.objectPath} score=${group.score} actions=${group.actionCount} `
            + `templates=${group.templateCount} dialogueLike=${group.dialogueLikeCount} display=${group.displayRelatedCount}`
        );

        const samples = group.sampleActions.slice(0, 16)
            .map((action) => `${action.index}:${action.text}`)
            .join(" | ");
        lines.push(`    ${samples}`);

        if (group.dialogueSamples.length > 0) {
            const dialogue = group.dialogueSamples.slice(0, 8)
                .map((action) => `${action.index}:${action.text}`)
                .join(" | ");
            lines.push(`    dialogue: ${dialogue}`);
        }
    }
}

main();
