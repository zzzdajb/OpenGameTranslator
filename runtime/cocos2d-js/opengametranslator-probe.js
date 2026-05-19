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
    var focusedAnimationIds = {};

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

    function recordMessageVariableId(messageShow, path) {
        if (!messageShow || typeof messageShow.variableId !== "number") {
            return;
        }

        var variableId = String(messageShow.variableId);
        if (!structuralData.messageVariableIds[variableId]) {
            structuralData.messageVariableIds[variableId] = {
                variableId: messageShow.variableId,
                count: 0,
                paths: []
            };
        }

        structuralData.messageVariableIds[variableId].count += 1;
        if (structuralData.messageVariableIds[variableId].paths.length < 30) {
            structuralData.messageVariableIds[variableId].paths.push(path);
        }
    }

    function recordVariableDefinition(obj, basePath) {
        if (structuralData.variableDefinitions.length >= 10000) {
            return;
        }

        structuralData.variableDefinitions.push({
            path: basePath,
            id: typeof obj.id === "number" ? obj.id : null,
            name: typeof obj.name === "string" ? obj.name : "",
            memo: typeof obj.memo === "string" ? limitText(obj.memo, 300) : "",
            initialValue: primitiveValue(obj.initialValue),
            toBeSaved: typeof obj.toBeSaved === "boolean" ? obj.toBeSaved : null,
            folder: typeof obj.folder === "boolean" ? obj.folder : null
        });
    }

    function recordSwitchDefinition(obj, basePath) {
        if (structuralData.switchDefinitions.length >= 12000) {
            return;
        }

        structuralData.switchDefinitions.push({
            path: basePath,
            id: typeof obj.id === "number" ? obj.id : null,
            name: typeof obj.name === "string" ? obj.name : "",
            memo: typeof obj.memo === "string" ? limitText(obj.memo, 300) : "",
            initialValue: typeof obj.initialValue === "boolean" ? obj.initialValue : null,
            toBeSaved: typeof obj.toBeSaved === "boolean" ? obj.toBeSaved : null,
            folder: typeof obj.folder === "boolean" ? obj.folder : null
        });
    }

    function recordImageDefinition(obj, basePath) {
        if (structuralData.imageDefinitions.length >= 20000) {
            return;
        }

        if (typeof obj.id !== "number" &&
                typeof obj.name !== "string" &&
                typeof obj.filename !== "string" &&
                typeof obj.srcFilename !== "string") {
            return;
        }

        structuralData.imageDefinitions.push({
            path: basePath,
            id: typeof obj.id === "number" ? obj.id : null,
            name: typeof obj.name === "string" ? obj.name : "",
            filename: typeof obj.filename === "string" ? obj.filename : "",
            srcFilename: typeof obj.srcFilename === "string" ? obj.srcFilename : "",
            memo: typeof obj.memo === "string" ? limitText(obj.memo, 300) : ""
        });
    }

    function recordSwitchVariableChange(obj, basePath) {
        if (!obj || typeof obj.switchVariableChange !== "object" || obj.switchVariableChange === null) {
            return;
        }

        if (structuralData.switchVariableChanges.length >= 20000) {
            return;
        }

        var change = obj.switchVariableChange;
        structuralData.switchVariableChanges.push({
            path: basePath + ".switchVariableChange",
            commandType: primitiveValue(obj.commandType),
            variableId: primitiveValue(change.variableId),
            variableObjectId: primitiveValue(change.variableObjectId),
            variableQualifierId: primitiveValue(change.variableQualifierId),
            variableAssignOperator: primitiveValue(change.variableAssignOperator),
            variableAssignValueType: primitiveValue(change.variableAssignValueType),
            assignValue: primitiveValue(change.assignValue),
            assignVariableId: primitiveValue(change.assignVariableId),
            assignVariableObjectId: primitiveValue(change.assignVariableObjectId),
            assignVariableQualifierId: primitiveValue(change.assignVariableQualifierId),
            javaScript: typeof change.javaScript === "string" ? limitText(change.javaScript, 1000) : "",
            assignScript: typeof change.assignScript === "string" ? limitText(change.assignScript, 1000) : "",
            keys: Object.keys(change).slice(0, 40)
        });
    }

    function refreshMessageVariableLinks() {
        var ids = structuralData.messageVariableIds || {};
        var definitions = [];
        var assignments = [];
        var i;
        var item;

        for (i = 0; i < structuralData.variableDefinitions.length; i += 1) {
            item = structuralData.variableDefinitions[i];
            if (item.id !== null && ids[String(item.id)]) {
                definitions.push(item);
            }
        }

        for (i = 0; i < structuralData.switchVariableChanges.length; i += 1) {
            item = structuralData.switchVariableChanges[i];
            if (item.variableId !== null && ids[String(item.variableId)]) {
                assignments.push(item);
            }
        }

        structuralData.messageVariableDefinitions = definitions;
        structuralData.messageVariableAssignments = assignments;
    }

    function primitiveValue(value) {
        if (value === null || typeof value === "undefined") {
            return null;
        }

        if (typeof value === "string") {
            return limitText(value, 300);
        }

        if (typeof value === "number" || typeof value === "boolean") {
            return value;
        }

        return "[object]";
    }

    function limitText(text, maxLength) {
        if (text.length <= maxLength) {
            return text;
        }

        return text.slice(0, maxLength) + "...";
    }

    function collectActionGroups(parsed) {
        structuralData.actionGroups = [];
        structuralData.focusedActionGroups = [];
        focusedAnimationIds = {};
        scanActionGroupCandidates(parsed, "", 0);
    }

    function scanActionGroupCandidates(value, basePath, depth) {
        if (!value || typeof value !== "object" || depth > 30) return;

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < Math.min(value.length, 5000); i += 1) {
                scanActionGroupCandidates(value[i], basePath + "[" + i + "]", depth + 1);
            }
            return;
        }

        try {
            if (Object.prototype.toString.call(value.actionList) === "[object Array]") {
                recordActionGroup(value, basePath);
            }

            var keys = Object.keys(value);
            for (var ki = 0; ki < Math.min(keys.length, 1000); ki += 1) {
                var key = keys[ki];
                var child = value[key];
                if (child !== null && typeof child === "object") {
                    scanActionGroupCandidates(child, basePath ? basePath + "." + key : key, depth + 1);
                }
            }
        } catch (e) {
            structuralData.notes.push("scanActionGroupCandidates error at " + basePath + ": " + e);
        }
    }

    function recordActionGroup(owner, basePath) {
        if (structuralData.actionGroups.length >= 5000) {
            return;
        }

        var actions = [];
        var actionList = owner.actionList || [];
        for (var ai = 0; ai < Math.min(actionList.length, 300); ai += 1) {
            var action = actionList[ai];
            if (!action || typeof action !== "object") continue;

            actions.push(summarizeAction(action, ai));
        }

        if (actions.length === 0) {
            return;
        }

        var textLikeCount = 0;
        var displayRelatedCount = 0;
        var commandTotal = 0;
        for (var si = 0; si < actions.length; si += 1) {
            if (isActionNameTextLike(actions[si].name)) textLikeCount += 1;
            if (isActionNameDisplayRelated(actions[si].name)) displayRelatedCount += 1;
            commandTotal += actions[si].commandCount;
        }

        structuralData.actionGroups.push({
            path: basePath,
            objectId: primitiveValue(owner.id),
            objectName: typeof owner.name === "string" ? limitText(owner.name, 120) : "",
            actionCount: actionList.length,
            sampledActionCount: actions.length,
            commandTotal: commandTotal,
            textLikeActionNameCount: textLikeCount,
            displayRelatedActionNameCount: displayRelatedCount,
            actions: actions
        });

        if (isFocusedActionGroup(owner, actions) && structuralData.focusedActionGroups.length < 120) {
            structuralData.focusedActionGroups.push({
                path: basePath,
                objectId: primitiveValue(owner.id),
                objectName: typeof owner.name === "string" ? limitText(owner.name, 120) : "",
                ownerFields: pickPrimitiveFields(owner, 120),
                actionCount: actionList.length,
                commandTotal: commandTotal,
                actions: summarizeFocusedActions(actionList)
            });

            if (typeof owner.animationId === "number") {
                focusedAnimationIds[String(owner.animationId)] = true;
            }
        }
    }

    function summarizeAction(action, actionIndex) {
        var commandSummary = collectActionCommands(action);

        return {
            index: actionIndex,
            id: primitiveValue(action.id),
            name: typeof action.name === "string" ? limitText(action.name, 160) : "",
            keys: Object.keys(action).slice(0, 30),
            commandCount: commandSummary.commandCount,
            commandTypeCounts: commandSummary.commandTypeCounts,
            commandKinds: commandSummary.commandKinds,
            messageVariableIds: commandSummary.messageVariableIds,
            switchVariableIds: commandSummary.switchVariableIds,
            scripts: commandSummary.scripts
        };
    }

    function collectActionCommands(action) {
        var summary = {
            commandCount: 0,
            commandTypeCounts: {},
            commandKinds: {},
            messageVariableIds: [],
            switchVariableIds: [],
            scripts: []
        };

        collectCommandsFromValue(action.objCommandList, summary, 0);
        collectCommandsFromValue(action.commonActionCommandList, summary, 0);
        collectCommandsFromValue(action.actionCommandListObject, summary, 0);

        return summary;
    }

    function isFocusedActionGroup(owner, actions) {
        var objectName = typeof owner.name === "string" ? owner.name : "";
        if (/Opening|Ending|ending|エンディング|day|event|テキスト/.test(objectName)) {
            return true;
        }

        for (var i = 0; i < actions.length; i += 1) {
            if (/テキストフィールド表示|繰り返し|アニメーション変数|終了・次へ|テキスト表示|テキスト枠表示|次のテキスト|消すテンプレ|出現テンプレ/.test(actions[i].name)) {
                return true;
            }
        }

        return false;
    }

    function summarizeFocusedActions(actionList) {
        var actions = [];

        for (var i = 0; i < Math.min(actionList.length, 140); i += 1) {
            var action = actionList[i];
            if (!action || typeof action !== "object") continue;

            actions.push({
                index: i,
                id: primitiveValue(action.id),
                name: typeof action.name === "string" ? limitText(action.name, 160) : "",
                commandSamples: collectFocusedCommandSamples(action, 80)
            });
        }

        return actions;
    }

    function collectFocusedCommandSamples(action, maxSamples) {
        var samples = [];

        collectFocusedCommandsFromValue(action.objCommandList, "objCommandList", samples, 0, maxSamples);
        collectFocusedCommandsFromValue(action.commonActionCommandList, "commonActionCommandList", samples, 0, maxSamples);
        collectFocusedCommandsFromValue(action.actionCommandListObject, "actionCommandListObject", samples, 0, maxSamples);

        return samples;
    }

    function collectFocusedCommandsFromValue(value, path, samples, depth, maxSamples) {
        if (!value || typeof value !== "object" || depth > 8 || samples.length >= maxSamples) {
            return;
        }

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < Math.min(value.length, 200) && samples.length < maxSamples; i += 1) {
                collectFocusedCommandsFromValue(value[i], path + "[" + i + "]", samples, depth + 1, maxSamples);
            }
            return;
        }

        try {
            if (isCommandLikeObject(value)) {
                samples.push(makeCommandSample(value, path));
                if (samples.length >= maxSamples) {
                    return;
                }
            }

            var keys = Object.keys(value);
            for (var ki = 0; ki < Math.min(keys.length, 160) && samples.length < maxSamples; ki += 1) {
                var key = keys[ki];
                var child = value[key];
                if (child !== null && typeof child === "object") {
                    collectFocusedCommandsFromValue(child, path + "." + key, samples, depth + 1, maxSamples);
                }
            }
        } catch (e) {
            // Focused command dumps are diagnostic only.
        }
    }

    function isCommandLikeObject(value) {
        if (typeof value.commandType !== "undefined") {
            return true;
        }

        return Boolean(value.messageShow || value.scrollMessageShow || value.switchVariableChange ||
            value.objectCreate || value.objectDelete || value.objectAction || value.soundPlay ||
            value.sceneTerminate || value.imageShow || value.movieShow || value.particleShow ||
            value.templateMove || value.templateCreate || value.text);
    }

    function makeCommandSample(command, path) {
        var sample = {
            path: path,
            commandType: primitiveValue(command.commandType),
            keys: Object.keys(command).slice(0, 50),
            primitiveFields: pickPrimitiveFields(command, 80)
        };

        copyNestedPrimitiveObject(sample, command, "messageShow");
        copyNestedPrimitiveObject(sample, command, "scrollMessageShow");
        copyNestedPrimitiveObject(sample, command, "switchVariableChange");
        copyNestedPrimitiveObject(sample, command, "actionExec");
        copyNestedPrimitiveObject(sample, command, "objectCreate");
        copyNestedPrimitiveObject(sample, command, "objectDelete");
        copyNestedPrimitiveObject(sample, command, "objectAction");
        copyNestedPrimitiveObject(sample, command, "objectChange");
        copyNestedPrimitiveObject(sample, command, "objectMove");
        copyNestedPrimitiveObject(sample, command, "objectShow");
        copyNestedPrimitiveObject(sample, command, "objectLock");
        copyNestedPrimitiveObject(sample, command, "wait");
        copyNestedPrimitiveObject(sample, command, "soundPlay");
        copyNestedPrimitiveObject(sample, command, "sceneTerminate");
        copyNestedPrimitiveObject(sample, command, "imageShow");
        copyNestedPrimitiveObject(sample, command, "movieShow");
        copyNestedPrimitiveObject(sample, command, "particleShow");

        return sample;
    }

    function collectFocusedAnimationData(parsed) {
        structuralData.focusedAnimations = [];
        if (!parsed || typeof parsed !== "object") {
            return;
        }

        scanAnimationCandidates(parsed.animationList, "animationList", 0);
    }

    function scanAnimationCandidates(value, path, depth) {
        if (!value || typeof value !== "object" || depth > 12 || structuralData.focusedAnimations.length >= 160) {
            return;
        }

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < Math.min(value.length, 2000); i += 1) {
                scanAnimationCandidates(value[i], path + "[" + i + "]", depth + 1);
            }
            return;
        }

        try {
            var id = typeof value.id === "number" ? value.id : null;
            var name = typeof value.name === "string" ? value.name : "";
            var isFocused = id !== null && focusedAnimationIds[String(id)];
            var isTextNamed = /テキスト|event|Opening|Ending|エンディング|day/.test(name);

            if ((isFocused || isTextNamed) && Object.prototype.toString.call(value.motionList) === "[object Array]") {
                structuralData.focusedAnimations.push(summarizeAnimation(value, path));
            }

            var keys = Object.keys(value);
            for (var ki = 0; ki < Math.min(keys.length, 300); ki += 1) {
                var key = keys[ki];
                var child = value[key];
                if (child !== null && typeof child === "object") {
                    scanAnimationCandidates(child, path + "." + key, depth + 1);
                }
            }
        } catch (e) {
            structuralData.notes.push("scanAnimationCandidates error at " + path + ": " + e);
        }
    }

    function summarizeAnimation(animation, path) {
        var summary = {
            path: path,
            id: primitiveValue(animation.id),
            name: typeof animation.name === "string" ? limitText(animation.name, 160) : "",
            primitiveFields: pickPrimitiveFields(animation, 80),
            resourceInfoList: [],
            motionList: []
        };

        if (Object.prototype.toString.call(animation.resourceInfoList) === "[object Array]") {
            for (var ri = 0; ri < Math.min(animation.resourceInfoList.length, 120); ri += 1) {
                var resource = animation.resourceInfoList[ri];
                if (resource && typeof resource === "object") {
                    summary.resourceInfoList.push(pickPrimitiveFields(resource, 80));
                }
            }
        }

        if (Object.prototype.toString.call(animation.motionList) === "[object Array]") {
            for (var mi = 0; mi < Math.min(animation.motionList.length, 180); mi += 1) {
                var motion = animation.motionList[mi];
                if (motion && typeof motion === "object") {
                    summary.motionList.push(summarizeMotion(motion));
                }
            }
        }

        return summary;
    }

    function summarizeMotion(motion) {
        var summary = {
            id: primitiveValue(motion.id),
            name: typeof motion.name === "string" ? limitText(motion.name, 160) : "",
            primitiveFields: pickPrimitiveFields(motion, 80),
            directionList: []
        };

        if (Object.prototype.toString.call(motion.directionList) === "[object Array]") {
            for (var di = 0; di < Math.min(motion.directionList.length, 16); di += 1) {
                var direction = motion.directionList[di];
                if (direction && typeof direction === "object") {
                    summary.directionList.push(summarizeDirection(direction));
                }
            }
        }

        return summary;
    }

    function summarizeDirection(direction) {
        var summary = {
            id: primitiveValue(direction.id),
            name: typeof direction.name === "string" ? limitText(direction.name, 160) : "",
            animationName: typeof direction.animationName === "string" ? limitText(direction.animationName, 160) : "",
            primitiveFields: pickPrimitiveFields(direction, 80),
            frameList: []
        };

        if (Object.prototype.toString.call(direction.frameList) === "[object Array]") {
            for (var fi = 0; fi < Math.min(direction.frameList.length, 80); fi += 1) {
                var frame = direction.frameList[fi];
                if (frame && typeof frame === "object") {
                    summary.frameList.push(pickPrimitiveFields(frame, 80));
                }
            }
        }

        return summary;
    }

    function exportFocusedImageResources() {
        structuralData.decryptedImageExports = [];

        var fileUtils = getFileUtils();
        if (!fileUtils || typeof fileUtils.getDataFromFile !== "function" ||
                typeof fileUtils.writeDataToFile !== "function") {
            structuralData.notes.push("Binary image export skipped: getDataFromFile/writeDataToFile not available");
            return;
        }

        var imageDefinitionsById = {};
        for (var ii = 0; ii < structuralData.imageDefinitions.length; ii += 1) {
            var imageDefinition = structuralData.imageDefinitions[ii];
            if (typeof imageDefinition.id === "number") {
                imageDefinitionsById[String(imageDefinition.id)] = imageDefinition;
            }
        }

        var imageIds = {};
        for (var ai = 0; ai < structuralData.focusedAnimations.length; ai += 1) {
            var animation = structuralData.focusedAnimations[ai];
            var resources = animation.resourceInfoList || [];
            for (var ri = 0; ri < resources.length; ri += 1) {
                // AGTK uses "image" for resource-to-image-definition mapping.
                var imageId = resources[ri].image;
                if (typeof imageId !== "number") {
                    imageId = resources[ri].imageId;
                }
                if (typeof imageId === "number" && imageId > 0) {
                    imageIds[String(imageId)] = true;
                }
            }
        }

        var ids = Object.keys(imageIds).sort(function (a, b) {
            return Number(a) - Number(b);
        });

        tryCreateDirectory(fileUtils, "OpenGameTranslator/output");
        tryCreateDirectory(fileUtils, "OpenGameTranslator/output/decrypted-img");
        tryCreateDirectory(fileUtils, "Resources/OpenGameTranslator/output");
        tryCreateDirectory(fileUtils, "Resources/OpenGameTranslator/output/decrypted-img");

        for (var idIndex = 0; idIndex < Math.min(ids.length, 220); idIndex += 1) {
            var id = ids[idIndex];
            var definition = imageDefinitionsById[id];
            var filename = definition && definition.filename ? definition.filename : "";
            if (!filename) {
                structuralData.decryptedImageExports.push({
                    imageId: Number(id),
                    ok: false,
                    reason: "missing filename"
                });
                continue;
            }

            var exportEntry = {
                imageId: Number(id),
                name: definition.name || "",
                filename: filename,
                ok: false,
                outputPath: "",
                data: null,
                reason: ""
            };

            try {
                var data = fileUtils.getDataFromFile(filename);
                exportEntry.data = describeBinaryData(data);
                var outputFilename = basename(filename);
                var outputPaths = [
                    "OpenGameTranslator/output/decrypted-img/" + outputFilename,
                    "Resources/OpenGameTranslator/output/decrypted-img/" + outputFilename
                ];

                for (var pi = 0; pi < outputPaths.length; pi += 1) {
                    try {
                        if (fileUtils.writeDataToFile(data, outputPaths[pi])) {
                            exportEntry.ok = true;
                            exportEntry.outputPath = outputPaths[pi];
                            break;
                        }
                    } catch (writeError) {
                        exportEntry.reason = "write failed: " + writeError;
                    }
                }

                if (!exportEntry.ok && !exportEntry.reason) {
                    exportEntry.reason = "writeDataToFile returned false";
                }
            } catch (readError) {
                exportEntry.reason = "read failed: " + readError;
            }

            structuralData.decryptedImageExports.push(exportEntry);
        }
    }

    function describeBinaryData(data) {
        var description = {
            type: Object.prototype.toString.call(data),
            length: null,
            firstBytes: [],
            formatHint: "unknown"
        };

        if (!data) {
            return description;
        }

        if (typeof data.length === "number") {
            description.length = data.length;
        } else if (typeof data.byteLength === "number") {
            description.length = data.byteLength;
        }

        var count = Math.min(description.length || 0, 32);
        for (var i = 0; i < count; i += 1) {
            try {
                description.firstBytes.push(Number(data[i]));
            } catch (e) {
                break;
            }
        }

        // Detect file format from magic bytes.
        var fb = description.firstBytes;
        if (fb.length >= 8) {
            // PNG: 89 50 4E 47 0D 0A 1A 0A
            if (fb[0] === 137 && fb[1] === 80 && fb[2] === 78 && fb[3] === 71) {
                description.formatHint = "PNG";
                // Check for PNG text chunks by scanning the first 1024 bytes for tEXt/iTXt/zTXt
                try {
                    var chunkSearch = new Uint8Array(Array.prototype.slice.call(data, 0, Math.min(1024, description.length || 0)));
                    var chunkStr = "";
                    for (var ci = 0; ci < chunkSearch.length; ci += 1) {
                        chunkStr += String.fromCharCode(chunkSearch[ci]);
                    }
                    var textChunkIdx = chunkStr.indexOf("tEXt");
                    if (textChunkIdx < 0) textChunkIdx = chunkStr.indexOf("iTXt");
                    if (textChunkIdx < 0) textChunkIdx = chunkStr.indexOf("zTXt");
                    if (textChunkIdx >= 0) {
                        description.formatHint = "PNG+textChunk@" + textChunkIdx;
                        // Try to extract keyword+text from the chunk.
                        try {
                            var kwEnd = chunkStr.indexOf("\0", textChunkIdx + 4);
                            if (kwEnd > textChunkIdx) {
                                var keyword = chunkStr.slice(textChunkIdx + 4, kwEnd);
                                var textStart = kwEnd + 1;
                                var textEnd = chunkStr.indexOf("IEND", textStart);
                                if (textEnd < 0) textEnd = chunkStr.length;
                                description.embeddedKeyword = safeStr(keyword);
                                description.embeddedText = safeStr(chunkStr.slice(textStart, textEnd).replace(/[^\x20-\x7E぀-ゟ゠-ヿ一-鿿]/g, "?")).slice(0, 500);
                            }
                        } catch (ex) {
                            description.embeddedText = "extract error: " + ex;
                        }
                    }
                } catch (csErr) {
                    description.formatHint += "+chunkScanErr:" + csErr;
                }
            }
            // JPEG: FF D8 FF
            else if (fb[0] === 255 && fb[1] === 216 && fb[2] === 255) {
                description.formatHint = "JPEG";
            }
            // WebP: 52 49 46 46 ... 57 45 42 50
            else if (fb[0] === 82 && fb[1] === 73 && fb[2] === 70 && fb[3] === 70) {
                description.formatHint = (fb[8] === 87 && fb[9] === 69 && fb[10] === 66 && fb[11] === 80) ? "WebP" : "RIFF";
            }
            // BMP: 42 4D
            else if (fb[0] === 66 && fb[1] === 77) {
                description.formatHint = "BMP";
            }
            // Gzip: 1F 8B
            else if (fb[0] === 31 && fb[1] === 139) {
                description.formatHint = "Gzip";
            }
            // ZIP: 50 4B
            else if (fb[0] === 80 && fb[1] === 75) {
                description.formatHint = "ZIP";
            }
            // enc header starts with non-standard bytes — mark first 4 as hex.
            else {
                var hex4 = "";
                for (var hi = 0; hi < Math.min(fb.length, 4); hi += 1) {
                    hex4 += (fb[hi] < 16 ? "0" : "") + fb[hi].toString(16);
                }
                description.formatHint = "unknown-0x" + hex4;
            }
        }

        return description;
    }

    function tryCreateDirectory(fileUtils, directoryPath) {
        try {
            fileUtils.createDirectory && fileUtils.createDirectory(directoryPath);
        } catch (e) {
            // Directory creation is best-effort for diagnostic exports.
        }
    }

    function basename(filePath) {
        var parts = String(filePath).split(/[\\/]/);
        return parts.length > 0 ? parts[parts.length - 1] : String(filePath);
    }

    function copyNestedPrimitiveObject(sample, command, key) {
        if (command[key] && typeof command[key] === "object") {
            sample[key] = pickPrimitiveFields(command[key], 80);
        }
    }

    function pickPrimitiveFields(obj, maxCount) {
        var result = {};
        var keys = Object.keys(obj);
        var count = 0;

        for (var i = 0; i < keys.length && count < maxCount; i += 1) {
            var key = keys[i];
            var value = obj[key];
            if (value === null || typeof value === "undefined" ||
                    typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                result[key] = primitiveValue(value);
                count += 1;
            }
        }

        return result;
    }

    function collectCommandsFromValue(value, summary, depth) {
        if (!value || typeof value !== "object" || depth > 8 || summary.commandCount >= 200) {
            return;
        }

        if (Object.prototype.toString.call(value) === "[object Array]") {
            for (var i = 0; i < Math.min(value.length, 200); i += 1) {
                collectCommandsFromValue(value[i], summary, depth + 1);
            }
            return;
        }

        try {
            var keys = Object.keys(value);
            var isCommand = false;
            if (typeof value.commandType !== "undefined") {
                isCommand = true;
                incrementPlainObject(summary.commandTypeCounts, String(value.commandType));
            }

            for (var ki = 0; ki < keys.length; ki += 1) {
                var key = keys[ki];
                if (/messageShow|scrollMessageShow|switchVariableChange|objectCreate|objectDelete|objectAction|soundPlay|particleShow|imageShow|movieShow|scriptEvaluate|sceneTerminate|template|text/i.test(key)) {
                    incrementPlainObject(summary.commandKinds, key);
                    isCommand = true;
                }
            }

            if (typeof value.messageShow === "object" && value.messageShow !== null) {
                pushUniqueLimited(summary.messageVariableIds, value.messageShow.variableId, 30);
            }

            if (typeof value.switchVariableChange === "object" && value.switchVariableChange !== null) {
                pushUniqueLimited(summary.switchVariableIds, value.switchVariableChange.variableId, 30);
                if (typeof value.switchVariableChange.assignScript === "string" && value.switchVariableChange.assignScript.length > 0) {
                    pushUniqueLimited(summary.scripts, limitText(value.switchVariableChange.assignScript, 120), 20);
                }
                if (typeof value.switchVariableChange.javaScript === "string" && value.switchVariableChange.javaScript.length > 0) {
                    pushUniqueLimited(summary.scripts, limitText(value.switchVariableChange.javaScript, 120), 20);
                }
            }

            if (isCommand) {
                summary.commandCount += 1;
            }

            for (var kj = 0; kj < Math.min(keys.length, 120); kj += 1) {
                var child = value[keys[kj]];
                if (child !== null && typeof child === "object") {
                    collectCommandsFromValue(child, summary, depth + 1);
                }
            }
        } catch (e) {
            // Command summaries are diagnostic only.
        }
    }

    function incrementPlainObject(target, key) {
        target[key] = (target[key] || 0) + 1;
    }

    function pushUniqueLimited(target, value, maxCount) {
        if (value === null || typeof value === "undefined") {
            return;
        }

        var text = String(value);
        for (var i = 0; i < target.length; i += 1) {
            if (String(target[i]) === text) {
                return;
            }
        }

        if (target.length < maxCount) {
            target.push(value);
        }
    }

    function isActionNameTextLike(name) {
        return typeof name === "string" && /[ぁ-んァ-ヶ]/.test(name) && /[「」『』。、！？?？]/.test(name);
    }

    function isActionNameDisplayRelated(name) {
        return typeof name === "string" && /テキスト|文字|字幕|会話|セリフ|台詞|吹き出し|表示|消す|出現|音声テキスト/.test(name);
    }

    /* === Structural Analysis for project.json === */
    var structuralData = {
        projectKeys: [],
        keyPathMap: {},
        messageShows: [],
        scrollMessageShows: [],
        objectsWithTextId: [],
        textListEntries: [],
        objectsWithTextField: [],
        variableList: [],
        variableDefinitions: [],
        switchDefinitions: [],
        imageDefinitions: [],
        messageVariableIds: {},
        switchVariableChanges: [],
        messageVariableDefinitions: [],
        messageVariableAssignments: [],
        actionGroups: [],
        focusedActionGroups: [],
        focusedAnimations: [],
        decryptedImageExports: [],
        textIdToPath: {},
        fontData: [],
        glyphDecodeResults: [],
        notes: []
    };

    function structuralScanJson(obj, source, basePath, depth) {
        if (!obj || typeof obj !== "object" || depth > 25) return;
        if (basePath === undefined) basePath = "";
        if (depth === undefined) depth = 0;

        if (Object.prototype.toString.call(obj) === "[object Array]") {
            for (var i = 0; i < Math.min(obj.length, 5000); i++) {
                structuralScanJson(obj[i], source, basePath + "[" + i + "]", depth + 1);
            }
            return;
        }

        try {
            var keys = Object.keys(obj);

            // Build key path map.
            for (var ki = 0; ki < Math.min(keys.length, 200); ki++) {
                var k = keys[ki];
                var path = basePath + "." + k;
                if (!structuralData.keyPathMap[k]) structuralData.keyPathMap[k] = [];
                if (structuralData.keyPathMap[k].length < 15) structuralData.keyPathMap[k].push(path);
            }

            // Detect messageShow commands.
            if (typeof obj.messageShow === "object" && obj.messageShow !== null) {
                recordMessageVariableId(obj.messageShow, basePath + ".messageShow");
                structuralData.messageShows.push({
                    path: basePath + ".messageShow",
                    data: JSON.parse(JSON.stringify(obj.messageShow))
                });
            }

            // Detect scrollMessageShow commands.
            if (typeof obj.scrollMessageShow === "object" && obj.scrollMessageShow !== null) {
                structuralData.scrollMessageShows.push({
                    path: basePath + ".scrollMessageShow",
                    data: JSON.parse(JSON.stringify(obj.scrollMessageShow))
                });
            }

            // Collect objects with textId.
            if (obj.hasOwnProperty("textId")) {
                var entry = { path: basePath, textId: obj.textId, textFlag: obj.textFlag };
                // Deep-copy all fields for first 30 entries.
                if (structuralData.objectsWithTextId.length < 30) {
                    entry.sample = JSON.parse(JSON.stringify(obj));
                }
                structuralData.objectsWithTextId.push(entry);
                // Map textId -> path.
                if (!structuralData.textIdToPath[String(obj.textId)]) {
                    structuralData.textIdToPath[String(obj.textId)] = [];
                }
                if (structuralData.textIdToPath[String(obj.textId)].length < 10) {
                    structuralData.textIdToPath[String(obj.textId)].push(basePath);
                }
            }

            // Collect textList data.
            if (basePath.indexOf("textList") !== -1 && !Array.isArray(obj)) {
                structuralData.textListEntries.push({
                    path: basePath,
                    keys: keys.slice(0, 30),
                    sample: JSON.parse(JSON.stringify(obj))
                });
            }

            // Collect variableList data.
            if (basePath.indexOf("variableList") !== -1 && !Array.isArray(obj)) {
                if (structuralData.variableList.length < 200) {
                    structuralData.variableList.push({
                        path: basePath,
                        keys: keys.slice(0, 20),
                        sample: JSON.parse(JSON.stringify(obj))
                    });
                }

                recordVariableDefinition(obj, basePath);
            }

            // Collect switch definitions so focused command dumps can be mapped back to readable names.
            if (basePath.indexOf("switchList") !== -1 && !Array.isArray(obj)) {
                recordSwitchDefinition(obj, basePath);
            }

            if (basePath.indexOf("imageList") !== -1 && !Array.isArray(obj)) {
                recordImageDefinition(obj, basePath);
            }

            // Variable text in AGTK often travels through switchVariableChange before messageShow displays it.
            recordSwitchVariableChange(obj, basePath);

            // Collect any object with a "text" field (potential dialogue container).
            if (typeof obj.text === "string" && obj.text.length > 0) {
                if (structuralData.objectsWithTextField.length < 500) {
                    structuralData.objectsWithTextField.push({
                        path: basePath,
                        textLen: obj.text.length,
                        textPreview: obj.text.length > 100 ? obj.text.slice(0, 100) + "..." : obj.text,
                        keys: keys.slice(0, 15)
                    });
                }
            }

            // Recurse.
            for (var kj = 0; kj < Math.min(keys.length, 1000); kj++) {
                var key = keys[kj];
                var val = obj[key];
                if (val !== null && typeof val === "object") {
                    structuralScanJson(val, source, basePath + "." + key, depth + 1);
                }
            }
        } catch (e) {
            structuralData.notes.push("Error at " + basePath + ": " + e);
        }
    }

    /* === Image-Font Glyph Index Scanner ===

       For AGTK games with imageFontFlag=true, dialogue text may be stored as glyph
       index arrays rather than as readable strings.  This scanner walks every array
       in the parsed project.json, checks whether all elements are integers that fall
       inside a font's letterLayout range, and tries to decode the sequence into
       readable Japanese using the per-font letterLayout character map.
    */
    function extractFontData(parsed) {
        var fonts = [];
        var fontList = parsed && parsed.fontList;
        if (!fontList || !Array.isArray(fontList)) {
            structuralData.notes.push("fontList not found or not an array");
            return fonts;
        }

        for (var fi = 0; fi < fontList.length; fi += 1) {
            var f = fontList[fi];
            if (!f || typeof f !== "object") continue;

            var layout = (f.letterLayout || "").replace(/\r/g, "");
            var jaSettings = (f.localeSettings && f.localeSettings.ja_JP) || {};
            var jaLayout = (jaSettings.letterLayout || "").replace(/\r/g, "");

            fonts.push({
                id: typeof f.id === "number" ? f.id : fi,
                name: typeof f.name === "string" ? f.name : "",
                imageFontFlag: !!f.imageFontFlag,
                imageId: typeof f.imageId === "number" ? f.imageId : -1,
                letterLayoutLength: layout.length,
                jaLetterLayoutLength: jaLayout.length,
                letterLayout: layout,
                jaLetterLayout: jaLayout || layout
            });
        }

        return fonts;
    }

    function decodeGlyphArray(values, layout) {
        if (!layout || layout.length === 0) return null;

        var result = "";
        var kanaCount = 0;
        var skippedCount = 0;
        var maxIdx = layout.length - 1;

        for (var vi = 0; vi < values.length; vi += 1) {
            var idx = values[vi];
            // Skip non-integer or out-of-range values (may be control codes / separators)
            if (typeof idx !== "number" || Math.floor(idx) !== idx || idx < 0 || idx > maxIdx) {
                skippedCount += 1;
                continue;
            }
            var ch = layout.charAt(idx);
            if (ch === "\n") ch = " ";
            result += ch;
            if (/[぀-ヿ]/.test(ch)) kanaCount += 1;
        }

        // Require at least 3 kana characters and at least 30% of values decoded as text
        if (kanaCount < 3) return null;
        if (result.length < 3) return null;
        if (values.length > 0 && result.length / (values.length - skippedCount || 1) < 0.3) return null;

        return { text: result.trim(), kanaCount: kanaCount, skippedCount: skippedCount };
    }

    function scanGlyphArrays(parsed, fonts) {
        if (!fonts || fonts.length === 0) return [];

        // Only use fonts that have Japanese in their letterLayout
        var jpFonts = [];
        for (var fi = 0; fi < fonts.length; fi += 1) {
            var layout = fonts[fi].jaLetterLayout || fonts[fi].letterLayout;
            if (layout && /[぀-ヿ]/.test(layout)) {
                jpFonts.push(fonts[fi]);
            }
        }

        if (jpFonts.length === 0) {
            structuralData.notes.push("No fonts with Japanese letterLayout found for glyph scan");
            return [];
        }

        var results = [];
        var arraysChecked = 0;
        var candidateArrays = 0;
        var MAX_RESULTS = 200;
        var MAX_ARRAYS = 500000;
        var MAX_ELEMENTS_CHECK = 200;

        function walkForArrays(value, path, depth) {
            if (arraysChecked >= MAX_ARRAYS || results.length >= MAX_RESULTS) return;
            if (!value || typeof value !== "object" || depth > 30) return;

            if (Object.prototype.toString.call(value) === "[object Array]") {
                if (value.length >= 3 && value.length <= 5000) {
                    arraysChecked += 1;

                    // Quick check: are first few elements integers in a plausible glyph range?
                    var maxGlyph = 0;
                    for (var fi = 0; fi < jpFonts.length; fi += 1) {
                        var layoutLen = (jpFonts[fi].jaLetterLayout || jpFonts[fi].letterLayout).length;
                        if (layoutLen > maxGlyph) maxGlyph = layoutLen;
                    }

                    var intCount = 0;
                    var checkLen = Math.min(value.length, MAX_ELEMENTS_CHECK);
                    for (var ci = 0; ci < checkLen; ci += 1) {
                        var v = value[ci];
                        if (typeof v === "number" && Math.floor(v) === v && v >= 0 && v <= maxGlyph) {
                            intCount += 1;
                        }
                    }
                    // Require at least 30% of elements to be potential glyph indices
                    var intRatio = intCount / (checkLen || 1);

                    if (intRatio >= 0.3 && value.length >= 3) {
                        candidateArrays += 1;
                        for (var fj = 0; fj < jpFonts.length; fj += 1) {
                            if (results.length >= MAX_RESULTS) break;
                            var layout = jpFonts[fj].jaLetterLayout || jpFonts[fj].letterLayout;
                            var decoded = decodeGlyphArray(value, layout, MAX_RESULTS);
                            if (decoded) {
                                results.push({
                                    path: path,
                                    length: value.length,
                                    fontId: jpFonts[fj].id,
                                    fontName: jpFonts[fj].name,
                                    decodedText: decoded.text,
                                    kanaCount: decoded.kanaCount,
                                    sampleIndices: value.slice(0, 20)
                                });
                                break; // Only report first matching font per array
                            }
                        }
                    }
                }
                // Recurse into array elements (sampling for very large arrays)
                var sampleStep = value.length > 200 ? Math.floor(value.length / 50) : 1;
                for (var si = 0; si < Math.min(value.length, 500); si += sampleStep) {
                    walkForArrays(value[si], path + "[" + si + "]", depth + 1);
                }
                return;
            }

            // Plain object: recurse into values
            var keys = Object.keys(value);
            for (var ki = 0; ki < Math.min(keys.length, 200); ki += 1) {
                try {
                    walkForArrays(value[keys[ki]], path + "." + keys[ki], depth + 1);
                } catch (e) {}
            }
        }

        walkForArrays(parsed, "$", 0);
        structuralData.notes.push("Glyph scan: " + arraysChecked + " arrays checked, " +
            candidateArrays + " candidates, " + results.length + " decoded with kana");
        return results;
    }

    function runGlyphIndexScan(parsed) {
        if (!parsed || typeof parsed !== "object") return;
        var fonts = extractFontData(parsed);
        structuralData.fontData = fonts;
        if (fonts.length > 0) {
            structuralData.glyphDecodeResults = scanGlyphArrays(parsed, fonts);
        }
    }

    function flushStructuralData() {
        var fileUtils = getFileUtils();
        if (!fileUtils || !fileUtils.writeStringToFile) return;

        refreshMessageVariableLinks();
        var out = JSON.stringify(structuralData, null, 2);
        var paths = [
            "OpenGameTranslator/output/opengametranslator-structural.json",
            "Resources/OpenGameTranslator/output/opengametranslator-structural.json"
        ];
        for (var pi = 0; pi < paths.length; pi++) {
            try {
                fileUtils.createDirectory && fileUtils.createDirectory("OpenGameTranslator/output");
                if (fileUtils.writeStringToFile(out, paths[pi])) return;
            } catch (e) {}
        }
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

        var hasText = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/.test(text);

        state.fileReads.push({
            path: filePath,
            length: text.length,
            hasTextCandidate: hasText,
            firstChars: text.length > 0 ? text.slice(0, 80) : ""
        });

        // When a new file with Japanese text is read, scan it as JSON too.
        if (hasText && text.length > 100 && text.length < 50 * 1024 * 1024) {
            try {
                var parsed = JSON.parse(text);
                scanJsonValue(parsed, "file:" + filePath, "", 0);
                state.notes.push("Scanned new file: " + filePath + " (" + text.length + " chars)");
            } catch (e) {
                // Not JSON \u2014 try scanning as plain text.
                scanPlainText(text, "file:" + filePath);
            }
        }

        // Flush after new non-project.json file reads so we capture scene data.
        if (state.fileReads.length > 8 && state.fileReads.length % 5 === 0) {
            flushProbeData("file-read-" + state.fileReads.length);
            flushStructuralData();
        }
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
            var parsed = JSON.parse(text);
            entry.json = "ok";

            // Structural analysis for project.json.
            if (/project\.json/i.test(source)) {
                structuralScanJson(parsed, source, "", 0);
                structuralData.projectKeys = Object.keys(parsed).sort();
                collectActionGroups(parsed);
                collectFocusedAnimationData(parsed);
                exportFocusedImageResources();
                runGlyphIndexScan(parsed);
                structuralData.notes.push("messageShows: " + structuralData.messageShows.length +
                    ", objectsWithTextId: " + structuralData.objectsWithTextId.length +
                    ", textListEntries: " + structuralData.textListEntries.length +
                    ", variableList: " + structuralData.variableList.length +
                    ", variableDefinitions: " + structuralData.variableDefinitions.length +
                    ", switchDefinitions: " + structuralData.switchDefinitions.length +
                    ", imageDefinitions: " + structuralData.imageDefinitions.length +
                    ", switchVariableChanges: " + structuralData.switchVariableChanges.length +
                    ", actionGroups: " + structuralData.actionGroups.length +
                    ", focusedActionGroups: " + structuralData.focusedActionGroups.length +
                    ", focusedAnimations: " + structuralData.focusedAnimations.length +
                    ", decryptedImageExports: " + structuralData.decryptedImageExports.length +
                    ", objectsWithTextField: " + structuralData.objectsWithTextField.length +
                    ", fontData: " + structuralData.fontData.length +
                    ", glyphDecodeResults: " + structuralData.glyphDecodeResults.length);
            }

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
                flushStructuralData();
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
                flushStructuralData();
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
        dumpModuleInfo();
        scheduleGlobalObjectScan();
        flushProbeData("startup");
        flushStructuralData();
        log("runtime probe installed");
    } catch (error) {
        log("runtime probe failed: " + error);
    }
}());
