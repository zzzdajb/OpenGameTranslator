// Image request logger and injection engine.
// Hooks ALL texture/image loading entry points to catch dialogue images
// regardless of which JS path (or C++ binding) they come through.
//
// Entry points hooked:
//   jsb.fileUtils.getDataFromFile — for loadBinary/loadBinarySync
//   cc.loader.loadImg             — JS-side image loader
//   cc.TextureCache._addImage     — C++ native (sync)
//   cc.TextureCache._addImageAsync — C++ native (async)
//   cc.TextureCache.addImageAsync  — JS wrapper (may be overwritten)
//
// Replacement images go in OpenGameTranslator/translated-img/<basename>
// Read from replacement via original C++ bindings (no recursion).
(function () {
    "use strict";

    var GLOBAL = typeof window !== "undefined" ? window : this;
    var LOG_OUTPUT_PATHS = [
        "OpenGameTranslator/output/image-requests.jsonl",
        "Resources/OpenGameTranslator/output/image-requests.jsonl"
    ];
    var REPLACEMENT_DIR = "OpenGameTranslator/translated-img";
    var FLUSH_INTERVAL_ENTRIES = 100;

    var logEntries = [];
    var totalPngRequests = 0;
    var injectedCount = 0;
    var hookStats = {
        getDataFromFile: 0,
        loadImg: 0,
        addImage: 0,
        addImageAsync: 0
    };
    var _originalGetDataFromFile = null;
    var _originalAddImage = null;
    var _originalAddImageAsync = null;
    var _originalLoadImg = null;

    function getFileUtils() {
        if (GLOBAL.jsb && GLOBAL.jsb.fileUtils) return GLOBAL.jsb.fileUtils;
        return null;
    }

    function getCC() {
        return GLOBAL.cc || null;
    }

    function basename(filePath) {
        var s = String(filePath || "");
        var idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return idx < 0 ? s : s.slice(idx + 1);
    }

    function dirname(filePath) {
        var s = String(filePath || "");
        var idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return idx < 0 ? "" : s.slice(0, idx);
    }

    function formatTimestamp() {
        try {
            return new Date().toISOString();
        } catch (e) {
            return String(new Date());
        }
    }

    function flushLog() {
        if (logEntries.length === 0) return;
        var fileUtils = getFileUtils();
        if (!fileUtils || typeof fileUtils.writeStringToFile !== "function") return;

        var lines = "";
        for (var i = 0; i < logEntries.length; i += 1) {
            lines += JSON.stringify(logEntries[i]) + "\n";
        }
        logEntries.length = 0;

        for (var pi = 0; pi < LOG_OUTPUT_PATHS.length; pi += 1) {
            try {
                fileUtils.createDirectory && fileUtils.createDirectory(dirname(LOG_OUTPUT_PATHS[pi]));
                fileUtils.writeStringToFile(lines, LOG_OUTPUT_PATHS[pi]);
                return;
            } catch (e) {
                // Try next path.
            }
        }
    }

    function appendLog(entry) {
        logEntries.push(entry);
        if (logEntries.length >= FLUSH_INTERVAL_ENTRIES) {
            flushLog();
        }
    }

    // Check if a replacement PNG exists for the given original path.
    // Uses the ORIGINAL getDataFromFile to avoid recursion.
    function readReplacement(originalPath) {
        if (!_originalGetDataFromFile) return null;
        if (!/\.png$/i.test(String(originalPath || ""))) return null;

        var replPath = REPLACEMENT_DIR + "/" + basename(originalPath);
        try {
            var data = _originalGetDataFromFile.call(getFileUtils(), replPath);
            if (data && data.length > 0) {
                return { data: data, path: replPath };
            }
        } catch (e) {
            // Not found or read error.
        }
        return null;
    }

    // ---- Hook 1: jsb.fileUtils.getDataFromFile ----
    function installGetDataFromFileHook() {
        var fileUtils = getFileUtils();
        if (!fileUtils || typeof fileUtils.getDataFromFile !== "function") return;
        if (fileUtils.getDataFromFile.__openGameTranslatorImageInjector) return;

        _originalGetDataFromFile = fileUtils.getDataFromFile;

        fileUtils.getDataFromFile = function (filePath) {
            var pathStr = String(filePath || "");

            if (/\.png$/i.test(pathStr)) {
                hookStats.getDataFromFile += 1;
                totalPngRequests += 1;

                var replacement = readReplacement(pathStr);
                if (replacement) {
                    injectedCount += 1;
                    appendLog({
                        path: pathStr,
                        source: "getDataFromFile",
                        action: "injected",
                        replacement: replacement.path,
                        size: replacement.data.length,
                        ts: formatTimestamp()
                    });
                    return replacement.data;
                }

                var result = _originalGetDataFromFile.apply(fileUtils, arguments);
                appendLog({
                    path: pathStr,
                    source: "getDataFromFile",
                    action: "original",
                    size: result ? result.length : 0,
                    ts: formatTimestamp()
                });
                return result;
            }

            return _originalGetDataFromFile.apply(fileUtils, arguments);
        };

        fileUtils.getDataFromFile.__openGameTranslatorImageInjector = true;
    }

    // ---- Hook 2: cc.loader.loadImg ----
    function installLoadImgHook() {
        var cc = getCC();
        if (!cc || !cc.loader || typeof cc.loader.loadImg !== "function") return;
        if (cc.loader.loadImg.__openGameTranslatorImageInjector) return;

        _originalLoadImg = cc.loader.loadImg;

        cc.loader.loadImg = function (url, option, cb) {
            var pathStr = String(url || "");
            hookStats.loadImg += 1;

            if (/\.png$/i.test(pathStr)) {
                totalPngRequests += 1;
                appendLog({
                    path: pathStr,
                    source: "loadImg",
                    action: "seen",
                    ts: formatTimestamp()
                });
            }

            return _originalLoadImg.apply(this, arguments);
        };

        cc.loader.loadImg.__openGameTranslatorImageInjector = true;
    }

    // ---- Hook 3: cc.TextureCache._addImage (C++ sync binding) ----
    function installAddImageHook() {
        var cc = getCC();
        if (!cc || !cc.TextureCache || !cc.TextureCache.prototype) return;

        var proto = cc.TextureCache.prototype;
        var target = proto._addImage || proto.addImage;
        if (!target || typeof target !== "function") return;
        if (target.__openGameTranslatorImageInjector) return;

        _originalAddImage = target;

        // Hook whichever one exists: _addImage is saved by jsb_boot.js before wrapping addImage.
        // We hook the saved native (_addImage) if available; otherwise hook addImage directly.
        var hookTarget = proto._addImage ? "_addImage" : "addImage";

        proto[hookTarget] = function (url, cb) {
            var pathStr = String(url || "");
            hookStats.addImage += 1;

            if (/\.png$/i.test(pathStr)) {
                totalPngRequests += 1;

                var replacement = readReplacement(pathStr);
                if (replacement) {
                    injectedCount += 1;
                    appendLog({
                        path: pathStr,
                        source: hookTarget,
                        action: "injected-texture",
                        replacement: replacement.path,
                        ts: formatTimestamp()
                    });
                    // Call original with replacement path.
                    return _originalAddImage.call(this, replacement.path, cb);
                }

                appendLog({
                    path: pathStr,
                    source: hookTarget,
                    action: "original-texture",
                    ts: formatTimestamp()
                });
            }

            return _originalAddImage.call(this, url, cb);
        };

        proto[hookTarget].__openGameTranslatorImageInjector = true;
    }

    // ---- Hook 4: cc.TextureCache._addImageAsync (C++ async binding) ----
    function installAddImageAsyncHook() {
        var cc = getCC();
        if (!cc || !cc.TextureCache || !cc.TextureCache.prototype) return;

        var proto = cc.TextureCache.prototype;
        var target = proto._addImageAsync || proto.addImageAsync;
        if (!target || typeof target !== "function") return;
        if (target.__openGameTranslatorImageInjector) return;

        _originalAddImageAsync = target;

        var hookTarget = proto._addImageAsync ? "_addImageAsync" : "addImageAsync";

        proto[hookTarget] = function (url, cb) {
            var pathStr = String(url || "");
            hookStats.addImageAsync += 1;

            if (/\.png$/i.test(pathStr)) {
                totalPngRequests += 1;

                var replacement = readReplacement(pathStr);
                if (replacement) {
                    injectedCount += 1;
                    appendLog({
                        path: pathStr,
                        source: hookTarget,
                        action: "injected-texture-async",
                        replacement: replacement.path,
                        ts: formatTimestamp()
                    });
                    return _originalAddImageAsync.call(this, replacement.path, cb);
                }

                appendLog({
                    path: pathStr,
                    source: hookTarget,
                    action: "original-texture-async",
                    ts: formatTimestamp()
                });
            }

            return _originalAddImageAsync.call(this, url, cb);
        };

        proto[hookTarget].__openGameTranslatorImageInjector = true;
    }

    function startFlushTimer() {
        try {
            if (typeof setInterval === "function") {
                setInterval(flushLog, 10000);
            }
        } catch (e) {
            // setInterval not available.
        }
    }

    function writeStatus() {
        var fileUtils = getFileUtils();
        if (!fileUtils || typeof fileUtils.writeStringToFile !== "function") return;

        var status = {
            formatVersion: 1,
            engineId: "cocos2d-js",
            mode: "image-injector",
            totalPngRequests: totalPngRequests,
            injectedCount: injectedCount,
            hookStats: hookStats,
            hookInstalled: {
                getDataFromFile: _originalGetDataFromFile !== null,
                loadImg: _originalLoadImg !== null,
                addImage: _originalAddImage !== null,
                addImageAsync: _originalAddImageAsync !== null
            },
            at: formatTimestamp()
        };

        var statusText = JSON.stringify(status, null, 2);
        var statusPaths = [
            "OpenGameTranslator/output/image-injector-status.json",
            "Resources/OpenGameTranslator/output/image-injector-status.json"
        ];

        for (var spi = 0; spi < statusPaths.length; spi += 1) {
            try {
                fileUtils.createDirectory && fileUtils.createDirectory(dirname(statusPaths[spi]));
                fileUtils.writeStringToFile(statusText, statusPaths[spi]);
            } catch (e) {
                // Best-effort.
            }
        }
    }

    // --- Main ---
    // Install the getDataFromFile hook immediately (it only depends on jsb.fileUtils).
    installGetDataFromFileHook();

    // TextureCache hooks need the engine to be initialized first.
    // If cc.initEngine exists, wrap it; otherwise try immediately.
    var cc = getCC();
    if (cc && cc.initEngine && !cc.initEngine.__openGameTranslatorImageInjector) {
        var originalInitEngine = cc.initEngine;
        cc.initEngine = function () {
            var result = originalInitEngine.apply(this, arguments);
            installLoadImgHook();
            installAddImageHook();
            installAddImageAsyncHook();
            startFlushTimer();
            writeStatus();
            return result;
        };
        cc.initEngine.__openGameTranslatorImageInjector = true;
    } else {
        installLoadImgHook();
        installAddImageHook();
        installAddImageAsyncHook();
        startFlushTimer();
        writeStatus();
    }

    // Flush on JS shutdown if possible.
    try {
        if (GLOBAL.process && typeof GLOBAL.process.on === "function") {
            GLOBAL.process.on("exit", function () {
                flushLog();
                writeStatus();
            });
        }
    } catch (e) {
        // Not a Node.js environment.
    }

    // Expose debug API.
    GLOBAL.OpenGameTranslatorImageInjector = {
        getStats: function () {
            return {
                totalPngRequests: totalPngRequests,
                injectedCount: injectedCount,
                hookStats: hookStats
            };
        },
        flushLog: flushLog,
        writeStatus: writeStatus
    };
})();
