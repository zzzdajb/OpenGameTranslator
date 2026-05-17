/**
 * OpenGameTranslator Structural Probe for AGTK/Cocos2d-JS.
 * Deep-analyzes the decrypted project.json structure to find where dialogue text lives.
 *
 * Key goals:
 *  1. Build a structural map of all JSON key paths (which keys appear at which levels).
 *  2. Export all messageShow commands with their full data.
 *  3. Trace textFlag/TextId references to find the text data table.
 *  4. Find any objects that look like dialogue text containers.
 */
(function () {
    "use strict";

    var GLOBAL = typeof window !== "undefined" ? window : this;
    var STATE = {
        formatVersion: 2,
        engineId: "cocos2d-js-structural",
        createdAt: new Date().toISOString(),
        projectKeys: [],           // All unique top-level keys in project.json
        keyPathMap: {},            // key -> paths where it appears
        messageShows: [],          // Full messageShow command data
        scrollMessageShows: [],    // Full scrollMessageShow command data
        textLists: [],             // textList entries
        textDataLike: [],          // Objects that look like text containers
        objectsWithTextId: [],     // Objects referencing textId
        unknownTextSource: [],     // Objects with text-like fields
        notes: []
    };

    function log(msg) {
        try { if (typeof console !== "undefined" && console.log) console.log("[OGT Structural] " + msg); } catch (e) {}
    }

    function safeStr(v) { return v === null || typeof v === "undefined" ? "" : String(v); }

    /** Build a map of key -> paths for the entire JSON structure. */
    function buildKeyPathMap(obj, basePath, depth) {
        if (!obj || typeof obj !== "object" || depth > 30) return;

        if (Object.prototype.toString.call(obj) === "[object Array]") {
            for (var i = 0; i < Math.min(obj.length, 2000); i++) {
                buildKeyPathMap(obj[i], basePath + "[" + i + "]", depth + 1);
            }
            return;
        }

        try {
            var keys = Object.keys(obj);
            for (var ki = 0; ki < Math.min(keys.length, 1000); ki++) {
                var key = keys[ki];
                var path = basePath + "." + key;

                // Record where this key appears.
                if (!STATE.keyPathMap[key]) {
                    STATE.keyPathMap[key] = [];
                }
                if (STATE.keyPathMap[key].length < 30) {
                    STATE.keyPathMap[key].push(path);
                }

                var value = obj[key];
                if (value !== null && typeof value === "object") {
                    buildKeyPathMap(value, path, depth + 1);
                }
            }
        } catch (e) {
            STATE.notes.push("buildKeyPathMap error at " + basePath + ": " + e);
        }
    }

    /** Extract all messageShow command objects with full data. */
    function extractMessageShows(obj, path, depth) {
        if (!obj || typeof obj !== "object" || depth > 30) return;

        if (Object.prototype.toString.call(obj) === "[object Array]") {
            for (var i = 0; i < obj.length; i++) {
                extractMessageShows(obj[i], path + "[" + i + "]", depth + 1);
            }
            return;
        }

        try {
            var keys = Object.keys(obj);

            // Check if this object looks like a messageShow command.
            if (keys.indexOf("messageShow") !== -1 && typeof obj.messageShow === "object") {
                STATE.messageShows.push({
                    path: path + ".messageShow",
                    data: JSON.parse(JSON.stringify(obj.messageShow))
                });
            }

            // Check for scrollMessageShow.
            if (keys.indexOf("scrollMessageShow") !== -1 && typeof obj.scrollMessageShow === "object") {
                STATE.scrollMessageShows.push({
                    path: path + ".scrollMessageShow",
                    data: JSON.parse(JSON.stringify(obj.scrollMessageShow))
                });
            }

            // Collect objects that have "textId" field.
            if (typeof obj.textId !== "undefined") {
                STATE.objectsWithTextId.push({
                    path: path,
                    textId: obj.textId,
                    textFlag: obj.textFlag,
                    sample: JSON.parse(JSON.stringify(obj))
                });
            }

            // Collect objects that look like text data containers.
            if (typeof obj.text === "string" && obj.text.length > 0) {
                STATE.textDataLike.push({
                    path: path,
                    text: obj.text.length > 200 ? obj.text.slice(0, 200) + "..." : obj.text,
                    keys: keys.slice(0, 20)
                });
            }

            // Collect textList entries.
            if (path.indexOf("textList") !== -1 && typeof obj === "object" && !Array.isArray(obj)) {
                STATE.textLists.push({
                    path: path,
                    keys: keys,
                    sample: JSON.parse(JSON.stringify(obj))
                });
            }

            for (var ki = 0; ki < Math.min(keys.length, 1000); ki++) {
                var key = keys[ki];
                var value = obj[key];
                if (value !== null && typeof value === "object") {
                    extractMessageShows(value, path + "." + key, depth + 1);
                }
            }
        } catch (e) {
            STATE.notes.push("extractMessageShows error at " + path + ": " + e);
        }
    }

    /** Find AGTK-specific text sources in runtime objects. */
    function scanAgtkRuntime() {
        try {
            // Try to access AGTK's text system through JS bindings.
            if (GLOBAL.Agtk) {
                STATE.notes.push("Agtk global present, keys: " + Object.keys(GLOBAL.Agtk).slice(0, 30).join(","));

                // Try to find text-related APIs.
                var agtkKeys = Object.keys(GLOBAL.Agtk);
                for (var i = 0; i < agtkKeys.length; i++) {
                    var k = agtkKeys[i];
                    try {
                        var v = GLOBAL.Agtk[k];
                        if (v && typeof v === "object") {
                            var subKeys = Object.keys(v).slice(0, 20);
                            STATE.notes.push("Agtk." + k + " keys: " + subKeys.join(","));

                            // Look for getText, getString, getData, etc.
                            for (var si = 0; si < subKeys.length; si++) {
                                if (/text|string|data/i.test(subKeys[si])) {
                                    STATE.unknownTextSource.push({
                                        path: "Agtk." + k + "." + subKeys[si],
                                        type: typeof v[subKeys[si]]
                                    });
                                }
                            }
                        }
                    } catch (e2) {
                        // Ignore access errors.
                    }
                }
            }

            // Try to find text data through cc.director.
            if (GLOBAL.cc && GLOBAL.cc.director) {
                try {
                    var scene = GLOBAL.cc.director.getRunningScene();
                    if (scene) {
                        var sceneKeys = Object.keys(scene).slice(0, 30);
                        STATE.notes.push("Running scene keys: " + sceneKeys.join(","));
                    }
                } catch (e) {
                    STATE.notes.push("getRunningScene failed: " + e);
                }
            }
        } catch (e) {
            STATE.notes.push("scanAgtkRuntime failed: " + e);
        }
    }

    /** Find the ProjectData or text data accessor in the game's JS global scope. */
    function scanGlobalForTextApis() {
        try {
            // Walk name-like keys at global scope.
            var globalKeys = Object.keys(GLOBAL);
            for (var i = 0; i < Math.min(globalKeys.length, 100); i++) {
                var k = globalKeys[i];
                try {
                    if (k === "JSON" || k === "console" || k === "Math" || k === "Date" ||
                        k === "Array" || k === "Object" || k === "String" || k === "Number" ||
                        k === "Boolean" || k === "RegExp" || k === "Error" || k === "Function" ||
                        k === "parseInt" || k === "parseFloat" || k === "isNaN" || k === "isFinite" ||
                        k === "undefined" || k === "NaN" || k === "Infinity" || k === "Intl") {
                        continue;
                    }

                    var v = GLOBAL[k];
                    if (v && typeof v === "object") {
                        try {
                            var subKeys = Object.keys(v).slice(0, 15);
                            // Check if this object has text/data related methods.
                            var hasTextApi = subKeys.some(function(sk) {
                                return /text|string|data|message|get/i.test(sk);
                            });
                            if (hasTextApi) {
                                STATE.unknownTextSource.push({
                                    path: "GLOBAL." + k,
                                    keys: subKeys
                                });
                            }
                        } catch (e2) {}
                    }

                    if (typeof v === "function") {
                        var fnName = v.name || k;
                        if (/text|data|string|message/i.test(fnName)) {
                            STATE.unknownTextSource.push({
                                path: "GLOBAL." + k + " (function " + fnName + ")",
                                type: "function"
                            });
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            STATE.notes.push("scanGlobalForTextApis failed: " + e);
        }
    }

    /** Hook getStringFromFile to intercept project.json reads and deep-analyze. */
    function installJsonDeepScanHook() {
        var fileUtils = null;
        if (GLOBAL.jsb && GLOBAL.jsb.fileUtils) fileUtils = GLOBAL.jsb.fileUtils;
        else if (GLOBAL.cc && GLOBAL.cc.fileUtils) fileUtils = GLOBAL.cc.fileUtils;
        if (!fileUtils || !fileUtils.getStringFromFile) return;

        var origGetString = fileUtils.getStringFromFile;

        fileUtils.getStringFromFile = function () {
            var filePath = safeStr(arguments[0]);
            var result = origGetString.apply(this, arguments);

            // When project.json is read, deep-analyze its structure.
            if (/project\.json/i.test(filePath) && typeof result === "string") {
                try {
                    STATE.notes.push("project.json read, length=" + result.length);
                    var parsed = JSON.parse(result);
                    STATE.projectKeys = Object.keys(parsed).sort();

                    // Build structural map.
                    buildKeyPathMap(parsed, "project", 0);

                    // Extract all message-related data.
                    extractMessageShows(parsed, "project", 0);

                    STATE.notes.push("messageShows found: " + STATE.messageShows.length);
                    STATE.notes.push("scrollMessageShows found: " + STATE.scrollMessageShows.length);
                    STATE.notes.push("objectsWithTextId found: " + STATE.objectsWithTextId.length);
                    STATE.notes.push("textDataLike found: " + STATE.textDataLike.length);
                } catch (e) {
                    STATE.notes.push("project.json analysis failed: " + e);
                }
            }

            return result;
        };
    }

    function flushResults() {
        var fileUtils = null;
        if (GLOBAL.jsb && GLOBAL.jsb.fileUtils) fileUtils = GLOBAL.jsb.fileUtils;
        else if (GLOBAL.cc && GLOBAL.cc.fileUtils) fileUtils = GLOBAL.cc.fileUtils;
        if (!fileUtils) return;

        try {
            fileUtils.createDirectory && fileUtils.createDirectory("OpenGameTranslator/output");
        } catch (e) {}

        var outputText = JSON.stringify(STATE, null, 2);
        var paths = [
            "OpenGameTranslator/output/opengametranslator-structural.json",
            "Resources/OpenGameTranslator/output/opengametranslator-structural.json"
        ];

        for (var i = 0; i < paths.length; i++) {
            try {
                var ok = fileUtils.writeStringToFile(outputText, paths[i]);
                if (ok) {
                    log("Structural analysis written to " + paths[i]);
                    return;
                }
            } catch (e) {}
        }
    }

    try {
        log("installing structural probe");
        installJsonDeepScanHook();

        // Phase 1: scan after game loads project.json (~3 seconds).
        if (typeof setTimeout === "function") {
            setTimeout(function () {
                scanAgtkRuntime();
                scanGlobalForTextApis();
                flushResults();
            }, 5000);

            // Phase 2: deeper scan after game fully initializes.
            setTimeout(function () {
                scanAgtkRuntime();
                scanGlobalForTextApis();
                flushResults();
            }, 15000);
        }

        log("structural probe installed");
    } catch (e) {
        log("structural probe failed: " + e);
    }
}());
