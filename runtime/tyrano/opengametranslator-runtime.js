(function () {
    "use strict";

    var DEFAULT_PACKAGE_PATH = "./data/others/opengametranslator.package.json";
    var RETRY_DELAY_MS = 300;
    var TAG_ATTRIBUTE_RULES = [
        { tagName: "ptext", fieldName: "text" },
        { tagName: "mtext", fieldName: "text" },
        { tagName: "glink", fieldName: "text" },
        { tagName: "button", fieldName: "hint" },
        { tagName: "chara_new", fieldName: "jname" }
    ];

    var state = {
        isLoaded: false,
        isHookInstalled: false,
        tagHookCount: 0,
        packagePath: "",
        translations: Object.create(null),
        translationCount: 0
    };

    function start() {
        loadPackage();
        installHookWhenReady();
        exposeDebugApi();
    }

    function loadPackage() {
        var packagePath = getPackagePath();
        state.packagePath = packagePath;

        try {
            var packageText = readTextFile(packagePath);

            if (packageText === null) {
                warn("Translation package was not found: " + packagePath);
                return;
            }

            var packageData = JSON.parse(packageText);
            state.translations = createTranslationMap(packageData);
            state.translationCount = Object.keys(state.translations).length;
            state.isLoaded = true;
            info("Loaded translation package entries: " + state.translationCount);
        } catch (error) {
            warn("Failed to load translation package. Original text will be used.");
            warn(getErrorMessage(error));
        }
    }

    function getPackagePath() {
        var config = window.OpenGameTranslatorConfig || {};

        if (typeof config.packagePath === "string" && config.packagePath.length > 0) {
            return config.packagePath;
        }

        return DEFAULT_PACKAGE_PATH;
    }

    function readTextFile(packagePath) {
        var fileText = readTextFileWithNode(packagePath);

        if (fileText !== null) {
            return fileText;
        }

        return readTextFileWithRequest(packagePath);
    }

    function readTextFileWithNode(packagePath) {
        if (typeof require !== "function") {
            return null;
        }

        try {
            var fs = require("fs");
            var filePath = resolvePackageFilePath(packagePath);

            if (filePath === null || !fs.existsSync(filePath)) {
                return null;
            }

            return fs.readFileSync(filePath, "utf8");
        } catch (error) {
            warn(getErrorMessage(error));
            return null;
        }
    }

    function resolvePackageFilePath(packagePath) {
        var packageUrl = new URL(packagePath, window.location.href);

        if (packageUrl.protocol !== "file:") {
            return null;
        }

        var filePath = decodeURIComponent(packageUrl.pathname);

        if (isWindowsFilePath(filePath)) {
            return filePath.slice(1);
        }

        return filePath;
    }

    function isWindowsFilePath(filePath) {
        return /^\/[A-Za-z]:\//.test(filePath);
    }

    function readTextFileWithRequest(packagePath) {
        try {
            var request = new XMLHttpRequest();
            request.open("GET", packagePath, false);
            request.send(null);

            if (request.status === 200 || request.status === 0) {
                return request.responseText;
            }
        } catch (error) {
            warn(getErrorMessage(error));
        }

        return null;
    }

    function createTranslationMap(packageData) {
        var translations = Object.create(null);

        if (!packageData || packageData.formatVersion !== 1 || !Array.isArray(packageData.entries)) {
            warn("Unsupported translation package format.");
            return translations;
        }

        for (var index = 0; index < packageData.entries.length; index++) {
            var entry = packageData.entries[index];

            if (!entry || typeof entry.sourceText !== "string" || typeof entry.translatedText !== "string") {
                continue;
            }

            if (entry.sourceText.length === 0 || entry.translatedText.length === 0) {
                continue;
            }

            translations[entry.sourceText] = entry.translatedText;
        }

        return translations;
    }

    function installHookWhenReady() {
        if (tryInstallHooks()) {
            return;
        }

        window.setTimeout(installHookWhenReady, RETRY_DELAY_MS);
    }

    function tryInstallHooks() {
        var isMessageHookInstalled = tryInstallShowMessageHook();
        installTagAttributeHooks();
        return isMessageHookInstalled;
    }

    function tryInstallShowMessageHook() {
        var textTag = getTextTag();

        if (textTag === null || typeof textTag.showMessage !== "function") {
            return false;
        }

        if (textTag.__openGameTranslatorInstalled === true) {
            return true;
        }

        var originalShowMessage = textTag.showMessage;

        textTag.showMessage = function (messageText, pm, isVertical) {
            var translatedMessageText = translateMessageSafely(messageText);
            return originalShowMessage.call(this, translatedMessageText, pm, isVertical);
        };

        textTag.__openGameTranslatorInstalled = true;
        state.isHookInstalled = true;
        info("Installed TyranoScript showMessage hook.");
        return true;
    }

    function installTagAttributeHooks() {
        for (var index = 0; index < TAG_ATTRIBUTE_RULES.length; index++) {
            installTagAttributeHook(TAG_ATTRIBUTE_RULES[index]);
        }
    }

    function installTagAttributeHook(rule) {
        var tag = getKagTag(rule.tagName);

        if (tag === null || typeof tag.start !== "function") {
            return;
        }

        var installedFlagName = "__openGameTranslator_" + rule.fieldName + "_Installed";

        if (tag[installedFlagName] === true) {
            return;
        }

        var originalStart = tag.start;

        tag.start = function (pm) {
            var translatedPm = translateTagParameterSafely(pm, rule.fieldName);
            return originalStart.call(this, translatedPm);
        };

        tag[installedFlagName] = true;
        state.tagHookCount++;
    }

    function getTextTag() {
        if (!window.tyrano
            || !window.tyrano.plugin
            || !window.tyrano.plugin.kag
            || !window.tyrano.plugin.kag.tag
            || !window.tyrano.plugin.kag.tag.text) {
            return null;
        }

        return window.tyrano.plugin.kag.tag.text;
    }

    function getKagTag(tagName) {
        if (!window.tyrano
            || !window.tyrano.plugin
            || !window.tyrano.plugin.kag
            || !window.tyrano.plugin.kag.tag
            || !window.tyrano.plugin.kag.tag[tagName]) {
            return null;
        }

        return window.tyrano.plugin.kag.tag[tagName];
    }

    function translateTagParameterSafely(pm, fieldName) {
        try {
            if (!pm || typeof pm[fieldName] !== "string") {
                return pm;
            }

            var translatedPm = clonePlainObject(pm);
            translatedPm[fieldName] = translateMessage(pm[fieldName]);
            return translatedPm;
        } catch (error) {
            warn(getErrorMessage(error));
            return pm;
        }
    }

    function clonePlainObject(source) {
        var target = {};

        for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                target[key] = source[key];
            }
        }

        return target;
    }

    function translateMessageSafely(messageText) {
        try {
            if (typeof messageText !== "string") {
                return messageText;
            }

            return translateMessage(messageText);
        } catch (error) {
            warn(getErrorMessage(error));
            return messageText;
        }
    }

    function translateMessage(messageText) {
        var parts = splitTextFromCode(messageText);
        var translatedParts = [];

        for (var index = 0; index < parts.length; index++) {
            var part = parts[index];

            if (isCodePart(part)) {
                translatedParts.push(part);
            } else {
                translatedParts.push(translateTextPart(part));
            }
        }

        return translatedParts.join("");
    }

    function splitTextFromCode(messageText) {
        return messageText.split(/(\[[^\]]+\]|<[^>]+>|┻+|\r\n|\n|\r)/g);
    }

    function isCodePart(textPart) {
        return textPart.length === 0
            || /^\[[^\]]+\]$/.test(textPart)
            || /^<[^>]+>$/.test(textPart)
            || /^┻+$/.test(textPart)
            || /^(\r\n|\n|\r)$/.test(textPart);
    }

    function translateTextPart(textPart) {
        var leadingWhitespace = textPart.match(/^\s*/)[0];
        var trailingWhitespace = textPart.match(/\s*$/)[0];
        var sourceText = textPart.trim();
        var translatedText = state.translations[sourceText];

        if (typeof translatedText !== "string" || translatedText.length === 0) {
            return textPart;
        }

        return leadingWhitespace + translatedText + trailingWhitespace;
    }

    function exposeDebugApi() {
        window.OpenGameTranslator = {
            getState: getState,
            reload: reload,
            translateMessage: translateMessage
        };
    }

    function getState() {
        return {
            isLoaded: state.isLoaded,
            isHookInstalled: state.isHookInstalled,
            tagHookCount: state.tagHookCount,
            packagePath: state.packagePath,
            translationCount: state.translationCount
        };
    }

    function reload() {
        loadPackage();
        return getState();
    }

    function info(message) {
        if (window.console && typeof window.console.info === "function") {
            window.console.info("[OpenGameTranslator] " + message);
        }
    }

    function warn(message) {
        if (window.console && typeof window.console.warn === "function") {
            window.console.warn("[OpenGameTranslator] " + message);
        }
    }

    function getErrorMessage(error) {
        if (error && typeof error.message === "string") {
            return error.message;
        }

        return String(error);
    }

    start();
}());
