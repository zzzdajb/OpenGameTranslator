(function () {
    "use strict";

    var GLOBAL = typeof window !== "undefined" ? window : this;
    var DEFAULT_PACKAGE_PATHS = [
        "OpenGameTranslator/opengametranslator.package.json",
        "Resources/OpenGameTranslator/opengametranslator.package.json"
    ];
    var PROJECT_JSON_PATHS = [
        "data/project.json",
        "project.json",
        "Resources/data/project.json"
    ];
    var MAX_PROJECT_JSON_SIZE = 200 * 1024 * 1024;

    var state = {
        formatVersion: 1,
        engineId: "cocos2d-js",
        mode: "runtime-translation",
        packagePath: null,
        isPackageLoaded: false,
        translationCount: 0,
        projectJsonPatched: false,
        projectJsonPath: null,
        projectJsonBackupPath: null,
        projectJsonReplacedCount: 0,
        jsonParsePatchCount: 0,
        projectJsonPatchCount: 0,
        replacedTextCount: 0,
        setStringReplaceCount: 0,
        installedTextHooks: [],
        notes: []
    };

    var translations = {};

    function start() {
        loadPackage();
        probeAndPatchProjectJson();
        installJsonParseHook();
        installFileReadHook();
        installTextHookAfterEngineLoaded();
        exposeDebugApi();
        writeStatus("startup");
    }

    function loadPackage() {
        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.getStringFromFile) {
            state.notes.push("jsb.fileUtils.getStringFromFile is not available.");
            return;
        }

        for (var i = 0; i < DEFAULT_PACKAGE_PATHS.length; i += 1) {
            var packagePath = DEFAULT_PACKAGE_PATHS[i];

            try {
                var packageText = fileUtils.getStringFromFile(packagePath);

                if (!packageText || packageText.length <= 0) {
                    continue;
                }

                var packageData = JSON.parse(packageText);
                translations = createTranslationMap(packageData);
                state.translationCount = countObjectKeys(translations);
                state.packagePath = packagePath;
                state.isPackageLoaded = state.translationCount > 0;
                return;
            } catch (error) {
                state.notes.push("Failed to load package from " + packagePath + ": " + error);
            }
        }

        state.notes.push("Translation package was not found.");
    }

    function createTranslationMap(packageData) {
        var result = {};

        if (!packageData || packageData.formatVersion !== 1 || !packageData.entries) {
            state.notes.push("Unsupported translation package format.");
            return result;
        }

        for (var i = 0; i < packageData.entries.length; i += 1) {
            var entry = packageData.entries[i];

            if (!entry || typeof entry.sourceText !== "string" || typeof entry.translatedText !== "string") {
                continue;
            }

            if (entry.sourceText.length <= 0 || entry.translatedText.length <= 0) {
                continue;
            }

            result[entry.sourceText] = entry.translatedText;
            result[normalizeText(entry.sourceText)] = entry.translatedText;
        }

        return result;
    }

    function probeAndPatchProjectJson() {
        if (!state.isPackageLoaded) {
            return;
        }

        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.getStringFromFile || !fileUtils.writeStringToFile) {
            state.notes.push("Cannot patch project.json: fileUtils not available.");
            return;
        }

        for (var i = 0; i < PROJECT_JSON_PATHS.length; i += 1) {
            var projectPath = PROJECT_JSON_PATHS[i];

            try {
                var text = fileUtils.getStringFromFile(projectPath);

                if (!text || text.length <= 0 || text.length > MAX_PROJECT_JSON_SIZE) {
                    continue;
                }

                var projectData = JSON.parse(text);
                var before = state.replacedTextCount;
                replaceStringValues(projectData, 0);
                var replaced = state.replacedTextCount - before;

                if (replaced <= 0) {
                    state.projectJsonPath = projectPath;
                    state.projectJsonPatched = true;
                    state.notes.push("project.json read but no strings matched for replacement.");
                    return;
                }

                // Backup original before writing patched version.
                var backupPath = "OpenGameTranslator/backups/project.json.bak";
                try {
                    fileUtils.createDirectory && fileUtils.createDirectory("OpenGameTranslator/backups");
                    fileUtils.writeStringToFile(text, backupPath);
                    state.projectJsonBackupPath = backupPath;
                } catch (backupError) {
                    state.notes.push("Failed to back up project.json: " + backupError);
                }

                // Write translated JSON so CLI can pick it up and deploy.
                var patchedText = JSON.stringify(projectData);
                var outputPaths = buildTranslatedOutputPaths(fileUtils);
                var writeOk = false;

                for (var pi = 0; pi < outputPaths.length; pi += 1) {
                    try {
                        ensureDirectory(fileUtils, dirname(outputPaths[pi]));
                        writeOk = fileUtils.writeStringToFile(patchedText, outputPaths[pi]);
                        if (writeOk) {
                            break;
                        }
                    } catch (writeError) {
                        state.notes.push("Write attempt " + outputPaths[pi] + " failed: " + writeError);
                    }
                }

                if (!writeOk) {
                    state.notes.push("Failed to write translated project.json to any path.");
                    return;
                }

                state.projectJsonPatched = true;
                state.projectJsonPath = projectPath;
                state.projectJsonReplacedCount = replaced;
                writeStatus("project-json-patched");
                return;
            } catch (error) {
                state.notes.push("Failed to patch " + projectPath + ": " + error);
            }
        }

        state.notes.push("Could not find or patch any project.json.");
    }

    function installJsonParseHook() {
        if (!GLOBAL.JSON || !GLOBAL.JSON.parse || GLOBAL.JSON.parse.__openGameTranslatorRuntime) {
            return;
        }

        var originalJsonParse = GLOBAL.JSON.parse;

        GLOBAL.JSON.parse = function () {
            var parsed = originalJsonParse.apply(GLOBAL.JSON, arguments);

            try {
                if (state.isPackageLoaded) {
                    var before = state.replacedTextCount;
                    replaceStringValues(parsed, 0);
                    if (state.replacedTextCount > before) {
                        state.jsonParsePatchCount += 1;
                        writeStatus("json-parse");
                    }
                }
            } catch (error) {
                state.notes.push("JSON.parse hook failed: " + error);
            }

            return parsed;
        };

        GLOBAL.JSON.parse.__openGameTranslatorRuntime = true;
    }

    function installFileReadHook() {
        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.getStringFromFile || fileUtils.getStringFromFile.__openGameTranslatorRuntime) {
            return;
        }

        var originalGetStringFromFile = fileUtils.getStringFromFile;

        fileUtils.getStringFromFile = function () {
            var filePath = safeString(arguments[0]);
            var result = originalGetStringFromFile.apply(this, arguments);

            if (!state.isPackageLoaded || !isProjectJsonPath(filePath) || typeof result !== "string" || result.length <= 0) {
                return result;
            }

            return translateProjectJsonSafely(result, filePath);
        };

        fileUtils.getStringFromFile.__openGameTranslatorRuntime = true;
    }

    function isProjectJsonPath(filePath) {
        var normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
        return normalizedPath === "project.json"
            || normalizedPath === "data/project.json"
            || normalizedPath === "resources/data/project.json"
            || /\/data\/project\.json$/.test(normalizedPath);
    }

    function translateProjectJsonSafely(projectJsonText, filePath) {
        try {
            var projectData = JSON.parse(projectJsonText);
            var beforeCount = state.replacedTextCount;
            replaceStringValues(projectData, 0);
            state.projectJsonPatchCount += 1;
            writeStatus("project-json:" + filePath);

            if (state.replacedTextCount === beforeCount) {
                return projectJsonText;
            }

            return JSON.stringify(projectData);
        } catch (error) {
            state.notes.push("Failed to patch project JSON: " + error);
            writeStatus("project-json-error");
            return projectJsonText;
        }
    }

    function replaceStringValues(value, depth) {
        if (depth > 80 || value === null || typeof value !== "object") {
            return value;
        }

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < value.length; i += 1) {
                if (typeof value[i] === "string") {
                    value[i] = translateText(value[i]);
                } else {
                    replaceStringValues(value[i], depth + 1);
                }
            }

            return value;
        }

        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                continue;
            }

            if (typeof value[key] === "string") {
                value[key] = translateText(value[key]);
            } else {
                replaceStringValues(value[key], depth + 1);
            }
        }

        return value;
    }

    function installTextHookAfterEngineLoaded() {
        if (!GLOBAL.cc || !GLOBAL.cc.initEngine || GLOBAL.cc.initEngine.__openGameTranslatorRuntime) {
            installTextHooks();
            return;
        }

        var originalInitEngine = GLOBAL.cc.initEngine;

        GLOBAL.cc.initEngine = function () {
            var result = originalInitEngine.apply(this, arguments);
            installTextHooks();
            return result;
        };

        GLOBAL.cc.initEngine.__openGameTranslatorRuntime = true;
    }

    function installTextHooks() {
        hookSetString("cc.Label", GLOBAL.cc && GLOBAL.cc.Label);
        hookSetString("cc.LabelTTF", GLOBAL.cc && GLOBAL.cc.LabelTTF);
        hookSetString("cc.LabelBMFont", GLOBAL.cc && GLOBAL.cc.LabelBMFont);
        hookSetString("cc.LabelAtlas", GLOBAL.cc && GLOBAL.cc.LabelAtlas);
        hookSetString("cc.TextFieldTTF", GLOBAL.cc && GLOBAL.cc.TextFieldTTF);
        hookSetString("cc.MenuItemLabel", GLOBAL.cc && GLOBAL.cc.MenuItemLabel);

        if (GLOBAL.ccui) {
            hookSetString("ccui.Text", GLOBAL.ccui.Text);
            hookSetString("ccui.TextField", GLOBAL.ccui.TextField);
            hookSetString("ccui.TextBMFont", GLOBAL.ccui.TextBMFont);
            hookSetString("ccui.TextAtlas", GLOBAL.ccui.TextAtlas);
            hookSetString("ccui.EditBox", GLOBAL.ccui.EditBox);
        }
    }

    function hookSetString(targetName, constructorValue) {
        if (!constructorValue || !constructorValue.prototype) {
            return;
        }

        var prototype = constructorValue.prototype;

        if (!prototype.setString || prototype.setString.__openGameTranslatorRuntime) {
            return;
        }

        var originalSetString = prototype.setString;

        prototype.setString = function () {
            if (arguments.length > 0 && typeof arguments[0] === "string") {
                var translatedText = translateText(arguments[0]);

                if (translatedText !== arguments[0]) {
                    state.setStringReplaceCount += 1;
                    arguments[0] = translatedText;
                }
            }

            return originalSetString.apply(this, arguments);
        };

        prototype.setString.__openGameTranslatorRuntime = true;
        state.installedTextHooks.push(targetName);
    }

    function translateText(sourceText) {
        var exactTranslation = translations[sourceText];

        if (typeof exactTranslation === "string" && exactTranslation.length > 0) {
            state.replacedTextCount += 1;
            return exactTranslation;
        }

        var normalizedText = normalizeText(sourceText);
        var normalizedTranslation = translations[normalizedText];

        if (typeof normalizedTranslation === "string" && normalizedTranslation.length > 0) {
            state.replacedTextCount += 1;
            return normalizedTranslation;
        }

        return sourceText;
    }

    function normalizeText(value) {
        return safeString(value)
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[ \t]+/g, " ")
            .trim();
    }

    function safeString(value) {
        if (value === null || typeof value === "undefined") {
            return "";
        }

        return String(value);
    }

    function getFileUtils() {
        if (GLOBAL.jsb && GLOBAL.jsb.fileUtils) {
            return GLOBAL.jsb.fileUtils;
        }

        if (GLOBAL.cc && GLOBAL.cc.fileUtils) {
            return GLOBAL.cc.fileUtils;
        }

        return null;
    }

    function writeStatus(reason) {
        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.writeStringToFile) {
            return;
        }

        var status = {
            formatVersion: state.formatVersion,
            engineId: state.engineId,
            mode: state.mode,
            reason: reason,
            packagePath: state.packagePath,
            isPackageLoaded: state.isPackageLoaded,
            translationCount: state.translationCount,
            projectJsonPatched: state.projectJsonPatched,
            projectJsonPath: state.projectJsonPath,
            projectJsonBackupPath: state.projectJsonBackupPath,
            projectJsonReplacedCount: state.projectJsonReplacedCount,
            jsonParsePatchCount: state.jsonParsePatchCount,
            projectJsonPatchCount: state.projectJsonPatchCount,
            replacedTextCount: state.replacedTextCount,
            setStringReplaceCount: state.setStringReplaceCount,
            installedTextHooks: state.installedTextHooks,
            notes: state.notes
        };

        var outputPaths = [
            "OpenGameTranslator/output/opengametranslator-runtime-status.json",
            "Resources/OpenGameTranslator/output/opengametranslator-runtime-status.json"
        ];

        for (var i = 0; i < outputPaths.length; i += 1) {
            try {
                fileUtils.createDirectory && fileUtils.createDirectory(dirname(outputPaths[i]));
                fileUtils.writeStringToFile(JSON.stringify(status, null, 2), outputPaths[i]);
            } catch (error) {
                // Status writing is best-effort only.
            }
        }
    }

    function buildTranslatedOutputPaths(fileUtils) {
        var paths = [];

        // Prefer writable path for large file writes.
        try {
            if (fileUtils.getWritablePath) {
                var wp = fileUtils.getWritablePath();
                if (wp) {
                    paths.push(joinPath(wp, "OpenGameTranslator/output/opengametranslator-translated-project.json"));
                    paths.push(joinPath(wp, "opengametranslator-translated-project.json"));
                }
            }
        } catch (error) {
            // Best-effort.
        }

        // Fall back to search-path-relative paths.
        paths.push("OpenGameTranslator/output/opengametranslator-translated-project.json");
        paths.push("Resources/OpenGameTranslator/output/opengametranslator-translated-project.json");

        return paths;
    }

    function ensureDirectory(fileUtils, directoryPath) {
        if (!directoryPath || typeof fileUtils.createDirectory !== "function") {
            return;
        }

        try {
            fileUtils.createDirectory(directoryPath);
        } catch (error) {
            // Best-effort.
        }
    }

    function joinPath(basePath, childPath) {
        if (!basePath) {
            return childPath;
        }

        if (basePath.charAt(basePath.length - 1) === "/" || basePath.charAt(basePath.length - 1) === "\\") {
            return basePath + childPath;
        }

        return basePath + "/" + childPath;
    }

    function dirname(filePath) {
        var index = filePath.lastIndexOf("/");
        return index < 0 ? "" : filePath.slice(0, index);
    }

    function countObjectKeys(value) {
        var count = 0;

        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                count += 1;
            }
        }

        return count;
    }

    function exposeDebugApi() {
        GLOBAL.OpenGameTranslatorRuntime = {
            state: state,
            writeStatus: writeStatus
        };
    }

    try {
        start();
    } catch (error) {
        state.notes.push("Runtime failed: " + error);
        writeStatus("runtime-error");
    }
}());
