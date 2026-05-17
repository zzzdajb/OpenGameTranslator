(function () {
    "use strict";

    var GLOBAL = typeof window !== "undefined" ? window : this;
    var MAX_TEXT_CANDIDATES = 100000;
    var MAX_DISPLAYED_TEXTS = 5000;
    var MAX_FILE_READS = 2000;
    var MAX_WRITE_ATTEMPTS = 50;

    var candidateTextSeen = {};
    var displayedTextSeen = {};
    var currentJsonSource = null;

    var state = {
        formatVersion: 1,
        engineId: "cocos2d-js",
        mode: "runtime-extract",
        createdAt: createTimestamp(),
        environment: {},
        files: [],
        fileReads: [],
        jsonParses: [],
        candidateTexts: [],
        displayedTexts: [],
        hooks: {
            installAttempts: 0,
            installedTargets: []
        },
        scanStats: {
            visitedNodes: 0,
            candidateLimitReached: false,
            displayedLimitReached: false
        },
        writeAttempts: [],
        lastFlushReason: null,
        notes: []
    };

    function createTimestamp() {
        try {
            return new Date().toISOString();
        } catch (error) {
            return String(new Date());
        }
    }

    function log(message) {
        try {
            if (typeof console !== "undefined" && console.log) {
                console.log("[OpenGameTranslator Probe] " + message);
            }
        } catch (error) {
            // Logging must never affect the game.
        }
    }

    function safeString(value) {
        if (value === null || typeof value === "undefined") {
            return "";
        }

        return String(value);
    }

    function normalizeText(value) {
        return safeString(value)
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[ \t]+/g, " ")
            .trim();
    }

    function shouldCollectText(value) {
        var text = normalizeText(value);

        if (text.length < 2 || text.length > 1000) {
            return false;
        }

        if (!/[぀-ヿ㐀-鿿！-｠]/.test(text)) {
            return false;
        }

        if (/^[\d\s.,:;_\-+*/\\()[\]{}=<>|!?"'`~]+$/.test(text)) {
            return false;
        }

        if (/\.(png|jpg|jpeg|webp|ogg|mp3|wav|json|js|ttf|otf|fnt|plist|csb|tmx|tsx)$/i.test(text)) {
            return false;
        }

        return true;
    }

    function collectCandidateText(text, source, keyPath) {
        var normalizedText = normalizeText(text);

        if (!shouldCollectText(normalizedText)) {
            return;
        }

        if (state.candidateTexts.length >= MAX_TEXT_CANDIDATES) {
            state.scanStats.candidateLimitReached = true;
            return;
        }

        if (candidateTextSeen[normalizedText]) {
            return;
        }

        candidateTextSeen[normalizedText] = true;
        state.candidateTexts.push({
            text: normalizedText,
            source: source,
            path: keyPath
        });
    }

    function collectDisplayedText(text, targetName) {
        var normalizedText = normalizeText(text);

        if (!shouldCollectText(normalizedText)) {
            return;
        }

        if (state.displayedTexts.length >= MAX_DISPLAYED_TEXTS) {
            state.scanStats.displayedLimitReached = true;
            return;
        }

        if (displayedTextSeen[normalizedText]) {
            return;
        }

        displayedTextSeen[normalizedText] = true;
        state.displayedTexts.push({
            text: normalizedText,
            target: targetName
        });

        flushProbeData("displayed-text");
    }

    function scanJsonValue(value, source, keyPath, depth) {
        state.scanStats.visitedNodes += 1;

        if (typeof value === "string") {
            collectCandidateText(value, source, keyPath);
            return;
        }

        if (value === null || typeof value !== "object" || depth > 40) {
            return;
        }

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < value.length; i += 1) {
                scanJsonValue(value[i], source, appendPath(keyPath, String(i)), depth + 1);
            }

            return;
        }

        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                scanJsonValue(value[key], source, appendPath(keyPath, key), depth + 1);
            }
        }
    }

    function appendPath(basePath, key) {
        var result = basePath ? basePath + "." + key : key;

        if (result.length > 220) {
            return result.slice(0, 220);
        }

        return result;
    }

    function installJsonParseProbe() {
        if (!GLOBAL.JSON || !GLOBAL.JSON.parse || GLOBAL.JSON.parse.__openGameTranslatorProbe) {
            return;
        }

        var originalJsonParse = GLOBAL.JSON.parse;

        GLOBAL.JSON.parse = function () {
            var parsed = originalJsonParse.apply(GLOBAL.JSON, arguments);

            try {
                var source = currentJsonSource || "JSON.parse";
                state.jsonParses.push({
                    source: source,
                    length: typeof arguments[0] === "string" ? arguments[0].length : null
                });
                scanJsonValue(parsed, source, "", 0);
            } catch (error) {
                state.notes.push("JSON.parse scan failed: " + error);
            }

            return parsed;
        };

        GLOBAL.JSON.parse.__openGameTranslatorProbe = true;
    }

    function installFileReadProbe() {
        var fileUtils = getFileUtils();

        if (!fileUtils || !fileUtils.getStringFromFile || fileUtils.getStringFromFile.__openGameTranslatorProbe) {
            return;
        }

        var originalGetStringFromFile = fileUtils.getStringFromFile;

        fileUtils.getStringFromFile = function () {
            var filePath = safeString(arguments[0]);
            var result = originalGetStringFromFile.apply(this, arguments);

            try {
                recordFileRead(filePath, result);
            } catch (error) {
                state.notes.push("getStringFromFile scan failed: " + error);
            }

            return result;
        };

        fileUtils.getStringFromFile.__openGameTranslatorProbe = true;
    }

    function recordFileRead(filePath, text) {
        if (state.fileReads.length >= MAX_FILE_READS) {
            return;
        }

        if (typeof text !== "string") {
            state.fileReads.push({
                path: filePath,
                type: typeof text
            });
            return;
        }

        state.fileReads.push({
            path: filePath,
            length: text.length,
            hasTextCandidate: /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/.test(text)
        });
    }

    function probeKnownFiles() {
        var probePaths = [
            "project.json",
            "data/project.json",
            "Resources/data/project.json",
            "data/info.json",
            "plugins/init.js",
            "plugins/prepare.js",
            "script/jsb.js",
            "script/jsb_boot.js"
        ];

        for (var i = 0; i < probePaths.length; i += 1) {
            probeFile(probePaths[i]);
        }
    }

    function probeFile(filePath) {
        var fileUtils = getFileUtils();
        var entry = {
            path: filePath,
            exists: null,
            readable: false,
            length: null,
            json: "not-tested"
        };

        if (!fileUtils) {
            entry.json = "no-fileUtils";
            state.files.push(entry);
            return;
        }

        try {
            if (fileUtils.isFileExist) {
                entry.exists = !!fileUtils.isFileExist(filePath);
            }
        } catch (error) {
            state.notes.push("isFileExist failed for " + filePath + ": " + error);
        }

        if (!fileUtils.getStringFromFile) {
            entry.json = "no-getStringFromFile";
            state.files.push(entry);
            return;
        }

        try {
            var text = fileUtils.getStringFromFile(filePath);
            entry.readable = typeof text === "string";
            entry.length = typeof text === "string" ? text.length : null;

            if (typeof text === "string" && text.length > 0) {
                if (!parseAndScanText(text, filePath, entry)) {
                    scanPlainText(text, filePath);
                }
            }
        } catch (error) {
            entry.json = "read-failed";
            state.notes.push("read failed for " + filePath + ": " + error);
        }

        state.files.push(entry);
    }

    function parseAndScanText(text, source, entry) {
        currentJsonSource = source;

        try {
            JSON.parse(text);
            entry.json = "ok";
            currentJsonSource = null;
            return true;
        } catch (error) {
            entry.json = "parse-failed";
        }

        currentJsonSource = null;
        return false;
    }

    function scanPlainText(text, source) {
        var lines = text.split(/\n/);

        for (var i = 0; i < lines.length; i += 1) {
            collectCandidateText(lines[i], source, "line:" + String(i + 1));
        }
    }

    function installTextHookAfterEngineLoaded() {
        if (!GLOBAL.cc || !GLOBAL.cc.initEngine || GLOBAL.cc.initEngine.__openGameTranslatorProbe) {
            installTextHooks();
            return;
        }

        var originalInitEngine = GLOBAL.cc.initEngine;

        GLOBAL.cc.initEngine = function () {
            var result = originalInitEngine.apply(this, arguments);

            try {
                installTextHooks();
                flushProbeData("after-initEngine");
            } catch (error) {
                state.notes.push("installTextHooks failed after initEngine: " + error);
            }

            return result;
        };

        GLOBAL.cc.initEngine.__openGameTranslatorProbe = true;
    }

    function installTextHooks() {
        state.hooks.installAttempts += 1;
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

        if (!prototype.setString || prototype.setString.__openGameTranslatorProbe) {
            return;
        }

        var originalSetString = prototype.setString;

        prototype.setString = function () {
            if (arguments.length > 0) {
                collectDisplayedText(arguments[0], targetName);
            }

            return originalSetString.apply(this, arguments);
        };

        prototype.setString.__openGameTranslatorProbe = true;
        state.hooks.installedTargets.push(targetName);
    }

    function collectEnvironment() {
        var fileUtils = getFileUtils();

        state.environment.hasWindow = typeof GLOBAL.window !== "undefined";
        state.environment.hasCc = !!GLOBAL.cc;
        state.environment.hasJsb = !!GLOBAL.jsb;
        state.environment.hasFileUtils = !!fileUtils;
        state.environment.engineVersion = GLOBAL.cc && GLOBAL.cc.ENGINE_VERSION ? GLOBAL.cc.ENGINE_VERSION : null;
        state.environment.defaultEngine = GLOBAL.cc && GLOBAL.cc.DEFAULT_ENGINE ? GLOBAL.cc.DEFAULT_ENGINE : null;

        if (fileUtils) {
            state.environment.hasIsFileExist = typeof fileUtils.isFileExist === "function";
            state.environment.hasGetStringFromFile = typeof fileUtils.getStringFromFile === "function";
            state.environment.hasWriteStringToFile = typeof fileUtils.writeStringToFile === "function";
            state.environment.hasWriteDataToFile = typeof fileUtils.writeDataToFile === "function";
            state.environment.hasCreateDirectory = typeof fileUtils.createDirectory === "function";
            state.environment.hasGetWritablePath = typeof fileUtils.getWritablePath === "function";
            state.environment.hasFullPathForFilename = typeof fileUtils.fullPathForFilename === "function";
            state.environment.hasLocalStorage = !!(GLOBAL.cc && GLOBAL.cc.sys && GLOBAL.cc.sys.localStorage);

            try {
                state.environment.writablePath = fileUtils.getWritablePath ? fileUtils.getWritablePath() : null;
            } catch (error) {
                state.environment.writablePath = null;
            }
        }
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

    function flushProbeData(reason) {
        var fileUtils = getFileUtils();

        state.lastFlushReason = reason;
        state.environment.candidateTextCount = state.candidateTexts.length;
        state.environment.displayedTextCount = state.displayedTexts.length;
        var outputText = JSON.stringify(state, null, 2);

        if (!fileUtils || typeof fileUtils.writeStringToFile !== "function") {
            recordWriteAttempt(reason, "no-writeStringToFile", false);
            writeLocalStorage(outputText);
            return;
        }

        var outputPaths = createOutputPaths(fileUtils);

        for (var i = 0; i < outputPaths.length; i += 1) {
            try {
                ensureDirectory(fileUtils, dirname(outputPaths[i]));
                var ok = fileUtils.writeStringToFile(outputText, outputPaths[i]);
                recordWriteAttempt(reason, outputPaths[i], !!ok);

                if (ok) {
                    return;
                }
            } catch (error) {
                recordWriteAttempt(reason, outputPaths[i] + " error: " + error, false);
            }
        }

        writeLocalStorage(outputText);
    }

    function createOutputPaths(fileUtils) {
        var paths = [];

        addOutputPath(paths, "OpenGameTranslator/output/opengametranslator-extracted-texts.json");
        addOutputPath(paths, "Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json");
        addOutputPath(paths, "opengametranslator-extracted-texts.json");

        addFullPathForFilenameOutput(paths, fileUtils, "OpenGameTranslator/output");
        addFullPathForFilenameOutput(paths, fileUtils, "Resources/OpenGameTranslator/output");

        try {
            if (fileUtils.getWritablePath) {
                addOutputPath(paths, joinPath(fileUtils.getWritablePath(), "OpenGameTranslator/output/opengametranslator-extracted-texts.json"));
                addOutputPath(paths, joinPath(fileUtils.getWritablePath(), "opengametranslator-extracted-texts.json"));
            }
        } catch (error) {
            state.notes.push("getWritablePath failed: " + error);
        }

        return paths;
    }

    function addOutputPath(paths, filePath) {
        if (!filePath) {
            return;
        }

        for (var i = 0; i < paths.length; i += 1) {
            if (paths[i] === filePath) {
                return;
            }
        }

        paths.push(filePath);
    }

    function addFullPathForFilenameOutput(paths, fileUtils, directoryPath) {
        try {
            if (!fileUtils.fullPathForFilename) {
                return;
            }

            var fullPath = fileUtils.fullPathForFilename(directoryPath);

            if (fullPath) {
                addOutputPath(paths, joinPath(fullPath, "opengametranslator-extracted-texts.json"));
            }
        } catch (error) {
            state.notes.push("fullPathForFilename failed for " + directoryPath + ": " + error);
        }
    }

    function ensureDirectory(fileUtils, directoryPath) {
        if (!directoryPath || typeof fileUtils.createDirectory !== "function") {
            return;
        }

        try {
            fileUtils.createDirectory(directoryPath);
        } catch (error) {
            state.notes.push("createDirectory failed for " + directoryPath + ": " + error);
        }
    }

    function dirname(filePath) {
        var index = filePath.lastIndexOf("/");

        if (index < 0) {
            return "";
        }

        return filePath.slice(0, index);
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

    function writeLocalStorage(outputText) {
        try {
            if (!GLOBAL.cc || !GLOBAL.cc.sys || !GLOBAL.cc.sys.localStorage) {
                recordWriteAttempt("localStorage", "no-localStorage", false);
                return;
            }

            GLOBAL.cc.sys.localStorage.setItem("OpenGameTranslatorProbe", outputText);
            recordWriteAttempt("localStorage", "OpenGameTranslatorProbe", true);
        } catch (error) {
            recordWriteAttempt("localStorage", String(error), false);
        }
    }

    function recordWriteAttempt(reason, targetPath, ok) {
        if (state.writeAttempts.length >= MAX_WRITE_ATTEMPTS) {
            return;
        }

        state.writeAttempts.push({
            reason: reason,
            targetPath: targetPath,
            ok: ok,
            at: createTimestamp()
        });
    }

    function exposeDebugApi() {
        GLOBAL.OpenGameTranslatorProbe = {
            state: state,
            flush: function () {
                flushProbeData("manual-flush");
                return state;
            }
        };
    }

    // Walk any JS object tree and collect candidate texts from string values.
    // This catches runtime-loaded data that never goes through JSON.parse or setString.
    function scanObjectTree(obj, sourceName, maxDepth) {
        if (!obj || typeof obj !== "object") {
            return;
        }

        var visitedObjects = [];
        var stringCount = 0;

        function walk(value, path, depth) {
            if (depth > (maxDepth || 12)) {
                return;
            }

            if (value === null || typeof value === "undefined") {
                return;
            }

            if (typeof value === "string") {
                stringCount += 1;
                collectCandidateText(value, sourceName, path);
                return;
            }

            if (typeof value !== "object") {
                return;
            }

            // Avoid circular references.
            for (var vi = 0; vi < visitedObjects.length; vi += 1) {
                if (visitedObjects[vi] === value) {
                    return;
                }
            }

            visitedObjects.push(value);

            if (Object.prototype.toString.call(value) === "[object Array]") {
                for (var i = 0; i < Math.min(value.length, 5000); i += 1) {
                    walk(value[i], path + "[" + i + "]", depth + 1);
                }

                return;
            }

            // Skip native/C++ objects that have no enumerable JS properties.
            try {
                var keys = Object.keys(value);
                if (keys.length === 0 && typeof value.toString === "function" && value.toString() === "[object Object]") {
                    return; // Empty plain object, skip.
                }

                for (var ki = 0; ki < Math.min(keys.length, 2000); ki += 1) {
                    var key = keys[ki];

                    // Skip known noisy/recursive keys.
                    if (key === "prototype" || key === "__proto__" || key === "parent" || key === "super" || key === "constructor") {
                        continue;
                    }

                    try {
                        walk(value[key], path + "." + key, depth + 1);
                    } catch (accessError) {
                        // Some properties throw on access (native getters).
                    }
                }
            } catch (walkError) {
                // Object might be opaque/native.
            }
        }

        walk(obj, sourceName, 0);
        state.notes.push(sourceName + " scan: " + stringCount + " strings visited, " + state.candidateTexts.length + " total candidates");
    }

    // Hook additional text APIs beyond setString that AGTK might use.
    function installConstructorHooks() {
        var targets = [];

        if (GLOBAL.cc) {
            targets.push({ name: "cc.LabelTTF", ctor: GLOBAL.cc.LabelTTF });
            targets.push({ name: "cc.LabelBMFont", ctor: GLOBAL.cc.LabelBMFont });
            targets.push({ name: "cc.LabelAtlas", ctor: GLOBAL.cc.LabelAtlas });
        }

        if (GLOBAL.ccui) {
            targets.push({ name: "ccui.Text", ctor: GLOBAL.ccui.Text });
            targets.push({ name: "ccui.TextField", ctor: GLOBAL.ccui.TextField });
            targets.push({ name: "ccui.TextBMFont", ctor: GLOBAL.ccui.TextBMFont });
        }

        for (var ti = 0; ti < targets.length; ti += 1) {
            var t = targets[ti];

            if (!t.ctor || !t.ctor.prototype || t.ctor.prototype.__openGameTranslatorProbeCtor) {
                continue;
            }

            // Hook initWithString if it exists.
            if (typeof t.ctor.prototype.initWithString === "function" && !t.ctor.prototype.initWithString.__openGameTranslatorProbe) {
                var origInit = t.ctor.prototype.initWithString;

                t.ctor.prototype.initWithString = function () {
                    if (arguments.length > 0 && typeof arguments[0] === "string") {
                        collectDisplayedText(arguments[0], t.name + ".initWithString");
                    }

                    return origInit.apply(this, arguments);
                };

                t.ctor.prototype.initWithString.__openGameTranslatorProbe = true;
                state.hooks.installedTargets.push(t.name + ".initWithString");
            }

            // Hook ctor (the create/constructor function) by wrapping the function itself.
            if (!t.ctor.__openGameTranslatorProbeCtor) {
                var origCtor = t.ctor;
                var ctorName = t.name;

                // Replace the constructor function with a wrapper that scans text arguments.
                var wrappedCtor = function () {
                    // Text is often the first argument of label constructors.
                    if (arguments.length > 0 && typeof arguments[0] === "string") {
                        collectDisplayedText(arguments[0], ctorName + ".ctor");
                    }

                    // Handle create() static method.
                    return origCtor.apply(this, arguments);
                };

                // Copy static methods (like .create).
                for (var sk in origCtor) {
                    if (Object.prototype.hasOwnProperty.call(origCtor, sk)) {
                        if (sk === "create" && typeof origCtor[sk] === "function" && !origCtor[sk].__openGameTranslatorProbe) {
                            var origCreate = origCtor[sk];

                            wrappedCtor[sk] = function () {
                                if (arguments.length > 0 && typeof arguments[0] === "string") {
                                    collectDisplayedText(arguments[0], ctorName + ".create");
                                }

                                return origCreate.apply(this, arguments);
                            };

                            wrappedCtor[sk].__openGameTranslatorProbe = true;
                        } else {
                            wrappedCtor[sk] = origCtor[sk];
                        }
                    }
                }

                wrappedCtor.prototype = origCtor.prototype;
                wrappedCtor.__openGameTranslatorProbeCtor = true;

                if (t.name === "cc.LabelTTF" && GLOBAL.cc) {
                    GLOBAL.cc.LabelTTF = wrappedCtor;
                } else if (t.name === "cc.LabelBMFont" && GLOBAL.cc) {
                    GLOBAL.cc.LabelBMFont = wrappedCtor;
                } else if (t.name === "cc.LabelAtlas" && GLOBAL.cc) {
                    GLOBAL.cc.LabelAtlas = wrappedCtor;
                } else if (t.name === "ccui.Text" && GLOBAL.ccui) {
                    GLOBAL.ccui.Text = wrappedCtor;
                } else if (t.name === "ccui.TextField" && GLOBAL.ccui) {
                    GLOBAL.ccui.TextField = wrappedCtor;
                } else if (t.name === "ccui.TextBMFont" && GLOBAL.ccui) {
                    GLOBAL.ccui.TextBMFont = wrappedCtor;
                }

                state.hooks.installedTargets.push(t.name + ".ctor+create");
            }
        }
    }

    // Hook console.log to capture any text the game writes to console.
    function installConsoleHook() {
        if (!GLOBAL.console || !GLOBAL.console.log || GLOBAL.console.log.__openGameTranslatorProbe) {
            return;
        }

        var origLog = GLOBAL.console.log;

        GLOBAL.console.log = function () {
            for (var i = 0; i < arguments.length; i += 1) {
                if (typeof arguments[i] === "string") {
                    collectCandidateText(arguments[i], "console.log", "arg:" + i);
                }
            }

            return origLog.apply(GLOBAL.console, arguments);
        };

        GLOBAL.console.log.__openGameTranslatorProbe = true;
    }

    // Schedule a delayed scan of global objects after the game has initialized.
    function scheduleGlobalObjectScan() {
        // If setTimeout is not available, skip delayed scans.
        if (typeof setTimeout !== "function") {
            state.notes.push("setTimeout not available, skipping delayed scans.");
            return;
        }

        // Phase 1: Scan after ~3 seconds (after init.js runs).
        setTimeout(function () {
            log("phase-1: scanning global objects");
            try {
                if (GLOBAL.Agtk) {
                    scanObjectTree(GLOBAL.Agtk, "Agtk", 14);
                }

                // Also scan cc.director and scene-related objects.
                if (GLOBAL.cc && GLOBAL.cc.director) {
                    try {
                        var runningScene = GLOBAL.cc.director.getRunningScene();
                        if (runningScene) {
                            scanObjectTree(runningScene, "cc.director.runningScene", 14);
                        }
                    } catch (e) {
                        state.notes.push("Failed to scan running scene: " + e);
                    }
                }

                // Scan plugins that may have loaded text data.
                if (GLOBAL.Agtk && GLOBAL.Agtk.plugins && Array.isArray(GLOBAL.Agtk.plugins)) {
                    for (var pi = 0; pi < GLOBAL.Agtk.plugins.length; pi += 1) {
                        try {
                            var plugin = GLOBAL.Agtk.plugins[pi];
                            scanObjectTree(plugin, "Agtk.plugins[" + pi + "]", 14);

                            // Try calling getInfo on plugins.
                            if (typeof plugin.getInfo === "function") {
                                try {
                                    var info = plugin.getInfo("internal");
                                    if (typeof info === "string" && info.length > 2) {
                                        collectCandidateText(info, "plugin[" + pi + "].getInfo(internal)", "internal");
                                    }
                                } catch (e2) {
                                    // getInfo may throw if not supported.
                                }
                            }
                        } catch (pe) {
                            // Plugin access may fail.
                        }
                    }
                }

                flushProbeData("phase-1-global-scan");
            } catch (error) {
                state.notes.push("Phase-1 scan failed: " + error);
            }
        }, 3000);

        // Phase 2: Scan after ~10 seconds (game should be showing text).
        setTimeout(function () {
            log("phase-2: deep re-scan of global objects");
            try {
                if (GLOBAL.Agtk) {
                    scanObjectTree(GLOBAL.Agtk, "Agtk-phase2", 16);
                }

                if (GLOBAL.cc && GLOBAL.cc.director) {
                    try {
                        var rs2 = GLOBAL.cc.director.getRunningScene();
                        if (rs2) {
                            scanObjectTree(rs2, "cc.director.runningScene-phase2", 16);
                        }
                    } catch (e) {
                        state.notes.push("Phase-2 scene scan failed: " + e);
                    }
                }

                // Scan ALL enumerable properties of the global object.
                scanObjectTree(GLOBAL, "GLOBAL-phase2", 6);

                flushProbeData("phase-2-deep-scan");
            } catch (error) {
                state.notes.push("Phase-2 scan failed: " + error);
            }
        }, 10000);
    }

    // Try every possible API to load a native DLL from JavaScript.
    function tryLoadHookDll() {
        var dllPaths = [
            "OpenGameTranslator/runtime/cocos2d-js/opengametranslator_hook.dll",
            "Resources/OpenGameTranslator/runtime/cocos2d-js/opengametranslator_hook.dll"
        ];

        for (var dpi = 0; dpi < dllPaths.length; dpi += 1) {
            var dllPath = dllPaths[dpi];

            // Method 1: __jsc__.loadLibrary (SpiderMonkey extension)
            try {
                if (typeof __jsc__ !== "undefined" && __jsc__ && typeof __jsc__.loadLibrary === "function") {
                    __jsc__.loadLibrary(dllPath);
                    state.notes.push("Hook DLL loaded via __jsc__.loadLibrary: " + dllPath);
                    return true;
                }
            } catch (e1) {
                state.notes.push("__jsc__.loadLibrary failed: " + e1);
            }

            // Method 2: ctypes (SpiderMonkey FFI, if available)
            try {
                if (typeof ctypes !== "undefined" && ctypes) {
                    var lib = ctypes.open(dllPath);
                    if (lib) {
                        state.notes.push("Hook DLL loaded via ctypes.open: " + dllPath);
                        lib.close();
                        return true;
                    }
                }
            } catch (e2) {
                state.notes.push("ctypes.open failed: " + e2);
            }

            // Method 3: try to use require with full path
            try {
                require(dllPath);
                state.notes.push("Hook DLL loaded via require: " + dllPath);
                return true;
            } catch (e3) {
                state.notes.push("require DLL failed: " + e3);
            }

            // Method 4: use eval with a native call
            try {
                if (typeof jsb !== "undefined" && jsb && jsb.reflection && typeof jsb.reflection.callStaticMethod === "function") {
                    jsb.reflection.callStaticMethod("java/lang/System", "loadLibrary", "(Ljava/lang/String;)V", dllPath);
                    state.notes.push("Hook DLL loaded via jsb.reflection: " + dllPath);
                    return true;
                }
            } catch (e4) {
                state.notes.push("jsb.reflection failed: " + e4);
            }
        }

        state.notes.push("All DLL load methods failed.");
        return false;
    }

    // Dump module info to help locate AGTK function addresses.
    function dumpModuleInfo() {
        var fileUtils = getFileUtils();
        if (!fileUtils) return;

        tryLoadHookDll();

        // Write the environment info for diagnostics.
        try {
            var infoText = JSON.stringify({
                hasJsc: typeof __jsc__ !== "undefined",
                hasCtypes: typeof ctypes !== "undefined",
                hasJsReflection: !!(typeof jsb !== "undefined" && jsb && jsb.reflection),
                globalKeys: Object.keys(GLOBAL).filter(function(k) {
                    return typeof GLOBAL[k] !== "function" && typeof GLOBAL[k] !== "object";
                }).slice(0, 30),
            }, null, 2);

            if (fileUtils.writeStringToFile) {
                fileUtils.createDirectory && fileUtils.createDirectory("OpenGameTranslator/output");
                fileUtils.writeStringToFile(infoText, "OpenGameTranslator/output/opengametranslator-module-info.json");
            }
        } catch (e2) {
            state.notes.push("Failed to write module info: " + e2);
        }
    }

    try {
        log("installing runtime probe");
        exposeDebugApi();
        collectEnvironment();
        installJsonParseProbe();
        installFileReadProbe();
        installConsoleHook();
        probeKnownFiles();
        installTextHookAfterEngineLoaded();
        installConstructorHooks();
        scheduleGlobalObjectScan();
        flushProbeData("startup");
        log("runtime probe installed");
    } catch (error) {
        log("runtime probe failed: " + error);
    }
}());
