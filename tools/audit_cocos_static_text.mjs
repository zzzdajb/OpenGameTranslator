#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const JAPANESE_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;
const KANA_PATTERN = /[\u3040-\u30ff]/u;
const FILE_LIKE_PATTERN = /\.(?:png|jpg|jpeg|webp|gif|mp3|ogg|wav|m4a|mp4|json|js|ttf|otf|fnt)$/iu;

const [, , projectJsonArg, outputDirArg] = process.argv;

if (projectJsonArg === undefined) {
    console.error("Usage: node tools/audit_cocos_static_text.mjs <project-json> [output-dir]");
    process.exit(1);
}

const projectJsonPath = resolve(projectJsonArg);
const outputDir = resolve(outputDirArg ?? join(dirname(projectJsonPath), "..", "OpenGameTranslator", "output"));

function main() {
    console.log(`Loading: ${projectJsonPath}`);
    const raw = readFileSync(projectJsonPath, "utf8");
    const outputStem = safeOutputStem(projectJsonPath);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        writeParseFailure(outputDir, outputStem, raw, error);
        process.exitCode = 1;
        return;
    }

    const audit = {
        createdAt: new Date().toISOString(),
        input: projectJsonPath,
        inputBytes: Buffer.byteLength(raw),
        rootKeys: isPlainObject(parsed) ? Object.keys(parsed).sort() : [],
        stats: createEmptyStats(),
        japaneseStrings: [],
        duplicateGroups: [],
        topLevelCounts: [],
        keyCounts: [],
        numericDecodedStrings: [],
    };

    walkJson(parsed, "$", audit);
    audit.duplicateGroups = buildDuplicateGroups(audit.japaneseStrings);
    audit.topLevelCounts = counterToSortedEntries(audit.stats.topLevelCounters);
    audit.keyCounts = counterToSortedEntries(audit.stats.keyCounters);

    delete audit.stats.topLevelCounters;
    delete audit.stats.keyCounters;

    mkdirSync(outputDir, { recursive: true });
    const detailPath = join(outputDir, `${outputStem}-static-text-audit.json`);
    const summaryPath = join(outputDir, `${outputStem}-static-text-audit.txt`);

    writeFileSync(detailPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    writeFileSync(summaryPath, buildSummary(audit), "utf8");

    console.log(`Japanese strings: ${audit.stats.japaneseStringCount}`);
    console.log(`Likely dialogue: ${audit.stats.likelyDialogueCount}`);
    console.log(`Detail: ${detailPath}`);
    console.log(`Summary: ${summaryPath}`);
}

function writeParseFailure(targetDir, outputStem, raw, error) {
    mkdirSync(targetDir, { recursive: true });

    const firstBytes = Buffer.from(raw.slice(0, 64), "utf8").toString("hex");
    const detail = {
        createdAt: new Date().toISOString(),
        input: projectJsonPath,
        inputBytes: Buffer.byteLength(raw),
        parseError: error instanceof Error ? error.message : String(error),
        firstBytesHex: firstBytes,
        note: raw.startsWith("enc") ? "The file starts with 'enc' and is probably an encrypted AGTK resource." : ""
    };

    const detailPath = join(targetDir, `${outputStem}-static-text-audit-parse-failed.json`);
    const summaryPath = join(targetDir, `${outputStem}-static-text-audit-parse-failed.txt`);
    writeFileSync(detailPath, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    writeFileSync(
        summaryPath,
        [
            "Cocos2d-JS Static Text Audit",
            "",
            `Input: ${detail.input}`,
            `Input bytes: ${detail.inputBytes}`,
            `Parse failed: ${detail.parseError}`,
            detail.note ? `Note: ${detail.note}` : "",
            `Detail: ${detailPath}`,
            ""
        ].filter(Boolean).join("\n"),
        "utf8"
    );

    console.error(`Parse failed: ${detail.parseError}`);
    console.error(`Detail: ${detailPath}`);
    console.error(`Summary: ${summaryPath}`);
}

function createEmptyStats() {
    return {
        objectCount: 0,
        arrayCount: 0,
        stringCount: 0,
        numberCount: 0,
        booleanCount: 0,
        nullCount: 0,
        japaneseStringCount: 0,
        uniqueJapaneseStringCount: 0,
        likelyDialogueCount: 0,
        maxDepth: 0,
        numericArrayCount: 0,
        numericArrayBytes: 0,
        topLevelCounters: new Map(),
        keyCounters: new Map(),
    };
}

function walkJson(value, path, audit) {
    audit.stats.maxDepth = Math.max(audit.stats.maxDepth, pathDepth(path));

    if (Array.isArray(value)) {
        audit.stats.arrayCount += 1;
        maybeDecodeNumericArray(value, path, audit);
        for (let index = 0; index < value.length; index += 1) {
            walkJson(value[index], `${path}[${index}]`, audit);
        }
        return;
    }

    if (isPlainObject(value)) {
        audit.stats.objectCount += 1;
        for (const [key, child] of Object.entries(value)) {
            walkJson(child, `${path}.${escapePathKey(key)}`, audit);
        }
        return;
    }

    if (typeof value === "string") {
        audit.stats.stringCount += 1;
        inspectString(value, path, audit);
        return;
    }

    if (typeof value === "number") {
        audit.stats.numberCount += 1;
        return;
    }

    if (typeof value === "boolean") {
        audit.stats.booleanCount += 1;
        return;
    }

    if (value === null) {
        audit.stats.nullCount += 1;
    }
}

function inspectString(text, path, audit) {
    if (!JAPANESE_PATTERN.test(text)) {
        return;
    }

    const key = lastPathKey(path);
    const topLevel = topLevelKey(path);
    const category = classifyText(text, key, path);
    const item = {
        path,
        topLevel,
        key,
        category,
        length: text.length,
        hash: sha1(text),
        text,
    };

    audit.japaneseStrings.push(item);
    audit.stats.japaneseStringCount += 1;
    increment(audit.stats.topLevelCounters, topLevel);
    increment(audit.stats.keyCounters, key);

    if (category === "likely-dialogue") {
        audit.stats.likelyDialogueCount += 1;
    }
}

function maybeDecodeNumericArray(values, path, audit) {
    if (values.length < 6 || values.length > 200000) {
        return;
    }

    for (const value of values) {
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            return;
        }
    }

    audit.stats.numericArrayCount += 1;
    audit.stats.numericArrayBytes += values.length;

    const bytes = Buffer.from(values);
    for (const encoding of ["utf8", "utf16le"]) {
        const decoded = bytes.toString(encoding).replace(/\0+$/u, "");
        if (looksLikeUsefulJapanese(decoded)) {
            audit.numericDecodedStrings.push({
                path,
                encoding,
                length: decoded.length,
                text: decoded,
            });
        }
    }
}

function classifyText(text, key, path) {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
        return "empty";
    }

    if (FILE_LIKE_PATTERN.test(trimmed) || path.includes("SrcFilename") || path.includes("srcFilename")) {
        return "asset-path";
    }

    if (key === "name" || key.endsWith("Name") || key === "title" || key === "genre" || key === "author") {
        return "label-or-metadata";
    }

    if (key === "description" || trimmed.includes("\n") || trimmed.length >= 18) {
        return "likely-dialogue";
    }

    // Dialogue in this engine is often short. Kana plus Japanese punctuation is a stronger signal than kanji alone.
    if (KANA_PATTERN.test(trimmed) && /[。、！？…「」]/u.test(trimmed)) {
        return "likely-dialogue";
    }

    return "short-text";
}

function looksLikeUsefulJapanese(text) {
    const cleaned = text.replace(/[\u0000-\u001f]+/gu, "").trim();
    return cleaned.length >= 3 && KANA_PATTERN.test(cleaned);
}

function buildDuplicateGroups(items) {
    const byHash = new Map();

    for (const item of items) {
        const existing = byHash.get(item.hash);
        if (existing === undefined) {
            byHash.set(item.hash, { hash: item.hash, text: item.text, count: 1, paths: [item.path] });
        } else {
            existing.count += 1;
            if (existing.paths.length < 20) {
                existing.paths.push(item.path);
            }
        }
    }

    const groups = [...byHash.values()].filter((group) => group.count > 1);
    groups.sort((a, b) => b.count - a.count || b.text.length - a.text.length);
    return groups.slice(0, 200);
}

function buildSummary(audit) {
    const lines = [];
    lines.push("Cocos2d-JS Static Text Audit");
    lines.push("");
    lines.push(`Input: ${audit.input}`);
    lines.push(`Input bytes: ${audit.inputBytes}`);
    lines.push(`Root file: ${basename(audit.input)}`);
    lines.push("");
    lines.push("Tree stats:");
    lines.push(`  Objects: ${audit.stats.objectCount}`);
    lines.push(`  Arrays: ${audit.stats.arrayCount}`);
    lines.push(`  Strings: ${audit.stats.stringCount}`);
    lines.push(`  Japanese strings: ${audit.stats.japaneseStringCount}`);
    lines.push(`  Likely dialogue strings: ${audit.stats.likelyDialogueCount}`);
    lines.push(`  Numeric byte arrays scanned: ${audit.stats.numericArrayCount}`);
    lines.push(`  Decoded Japanese strings from numeric arrays: ${audit.numericDecodedStrings.length}`);
    lines.push(`  Max depth: ${audit.stats.maxDepth}`);
    lines.push("");

    lines.push("Japanese strings by top-level key:");
    for (const entry of audit.topLevelCounts.slice(0, 25)) {
        lines.push(`  ${entry.key}: ${entry.count}`);
    }
    lines.push("");

    lines.push("Japanese strings by field name:");
    for (const entry of audit.keyCounts.slice(0, 25)) {
        lines.push(`  ${entry.key}: ${entry.count}`);
    }
    lines.push("");

    lines.push("Likely dialogue samples:");
    for (const item of audit.japaneseStrings.filter((entry) => entry.category === "likely-dialogue").slice(0, 80)) {
        lines.push(`  [${item.length}] ${item.path}`);
        lines.push(`      ${oneLine(item.text)}`);
    }
    lines.push("");

    lines.push("Longest Japanese strings:");
    const longest = [...audit.japaneseStrings].sort((a, b) => b.length - a.length).slice(0, 40);
    for (const item of longest) {
        lines.push(`  [${item.length}] ${item.category} ${item.path}`);
        lines.push(`      ${oneLine(item.text)}`);
    }
    lines.push("");

    lines.push("Most repeated Japanese strings:");
    for (const group of audit.duplicateGroups.slice(0, 40)) {
        lines.push(`  x${group.count} ${oneLine(group.text)}`);
    }
    lines.push("");

    return `${lines.join("\n")}\n`;
}

function counterToSortedEntries(counter) {
    return [...counter.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function safeOutputStem(filePath) {
    const extension = extname(filePath);
    const stem = basename(filePath, extension);
    return stem.replace(/[^A-Za-z0-9_.-]+/gu, "_");
}

function increment(counter, key) {
    counter.set(key, (counter.get(key) ?? 0) + 1);
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha1(text) {
    return createHash("sha1").update(text).digest("hex");
}

function oneLine(text) {
    return text.replace(/\s+/gu, " ").slice(0, 180);
}

function escapePathKey(key) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
        return key;
    }
    return JSON.stringify(key);
}

function lastPathKey(path) {
    const match = /\.([^.[\]]+)(?:\[\d+\])?$/u.exec(path);
    if (match?.[1] !== undefined) {
        return match[1];
    }
    return "(array-item)";
}

function topLevelKey(path) {
    const match = /^\$\.([^.[\]]+)/u.exec(path);
    return match?.[1] ?? "(root)";
}

function pathDepth(path) {
    let depth = 0;
    for (const char of path) {
        if (char === "." || char === "[") {
            depth += 1;
        }
    }
    return depth;
}

main();
