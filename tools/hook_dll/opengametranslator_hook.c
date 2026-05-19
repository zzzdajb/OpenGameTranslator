/**
 * OpenGameTranslator Hook DLL - Diagnostic version.
 * Proxies sqlite3.dll to hook into the AGTK game engine.
 * This version writes a diagnostic log to help find function addresses.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

static wchar_t g_logPath[MAX_PATH];
static char g_logBuf[1024 * 1024];
static int g_logLen = 0;
static LONG g_textCallCount = 0;

static void Log(const char *fmt, ...) {
    if (g_logLen >= (int)sizeof(g_logBuf) - 256) return;
    va_list args;
    va_start(args, fmt);
    int n = _vsnprintf_s(g_logBuf + g_logLen, sizeof(g_logBuf) - g_logLen - 1,
                         _TRUNCATE, fmt, args);
    va_end(args);
    if (n > 0) g_logLen += n;
}

static void FlushLog(void) {
    HANDLE h = CreateFileW(g_logPath, GENERIC_WRITE, 0, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD written;
        WriteFile(h, g_logBuf, g_logLen, &written, NULL);
        CloseHandle(h);
    }
}

static void InitLogPath(void) {
    wchar_t localAppData[MAX_PATH];
    wchar_t logDir[MAX_PATH];

    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH)) {
        _snwprintf_s(logDir, MAX_PATH, _TRUNCATE, L"%s\\player", localAppData);
        CreateDirectoryW(logDir, NULL);
        _snwprintf_s(g_logPath, MAX_PATH, _TRUNCATE,
                     L"%s\\opengametranslator_hook_diag.txt", logDir);
        return;
    }

    wcscpy_s(g_logPath, MAX_PATH, L"opengametranslator_hook_diag.txt");
}

/* ---- RTTI Scanner ---- */

#define MAX_VTABLE_SIZE 64

typedef struct {
    void *vtable;
    int vtableSize;
    void *functions[MAX_VTABLE_SIZE];
    const char *name;
} FoundVtable;

static HMODULE g_mainModule = NULL;
static BYTE *g_moduleBase = NULL;
static DWORD g_moduleSize = 0;
static FoundVtable g_foundVtables[8];
static int g_foundCount = 0;

/* ---- TextGui export hook ---- */

#define MIN_HOOK_PATCH_SIZE 5
#define MAX_HOOK_PATCH_SIZE 16
#define MAX_CAPTURED_TEXT_CALLS 300
#define MAX_CAPTURED_JS_STRING_CALLS 600
#define MAX_CAPTURED_OBJECT_PROBES 40
#define MAX_CAPTURED_GETSTRING_RESULTS 200
#define MAX_CAPTURED_MESSAGE_UI_SET_TEXT_GUI_PROBES 40
#define MAX_CAPTURED_MESSAGE_UI_UPDATE_PROBES 120
#define MAX_CAPTURED_MESSAGE_FLOW_PROBES 120
#define MAX_CAPTURED_OTHER_MESSAGE_FLOW_PROBES 20
#define MAX_CAPTURED_VALUE_HOOK_CALLS 300
#define MAX_CAPTURED_VALUE_GET_CALLS 300
#define MAX_CAPTURED_CRT_FILE_CALLS 500
#define MAX_CAPTURED_CRT_READ_CALLS 300
#define MAX_TRACKED_MESSAGE_POINTERS 128
#define MAX_TRACKED_MESSAGE_TEXT_GUI_LINKS 128
#define MESSAGE_UI_UPDATE_SAMPLE_INTERVAL 240

typedef struct {
    void *thisPtr;
    const void *textGuiPtr;
} MessageUiTextGuiLink;

typedef struct {
    const char *label;
    const char *exportName;
    void *detour;
    BYTE *target;
    BYTE *trampoline;
    BYTE original[MAX_HOOK_PATCH_SIZE];
    DWORD patchSize;
    int installed;
    LONG callCount;
    int allowNonPrologue;
    int callBased;  /* Use CALL (0xE8) instead of JMP (0xE9). Detour must CALL trampoline + RET. */
} InlineHook;

static void *g_updateText7Trampoline = NULL;
static void *g_updateText8Trampoline = NULL;
static void *g_updateTextRender7Trampoline = NULL;
static void *g_updateTextRender8Trampoline = NULL;
static void *g_textDataGetTextTrampoline = NULL;
static void *g_fontManagerCreateOrSetTrampoline = NULL;
static void *g_textLineNodeCreateTrampoline = NULL;
static void *g_textLineNodeInitTrampoline = NULL;
static void *g_textureInitWithStringFontDefTrampoline = NULL;
static void *g_textureInitWithStringFullTrampoline = NULL;
static void *g_labelSetStringTrampoline = NULL;
static void *g_labelBMFontSetStringTrampoline = NULL;
static void *g_labelTTFSetStringTrampoline = NULL;
static void *g_labelAtlasSetStringTrampoline = NULL;
static void *g_uiTextSetStringTrampoline = NULL;
static void *g_uiTextSetTextTrampoline = NULL;
static void *g_uiTextBMFontSetStringTrampoline = NULL;
static void *g_uiTextBMFontSetTextTrampoline = NULL;
static void *g_getExpandedTextTrampoline = NULL;
static void *g_execActionMessageShowTrampoline = NULL;
static void *g_execActionScrollMessageShowTrampoline = NULL;
static void *g_sqlite3ColumnTextTrampoline = NULL;
static void *g_sqlite3ColumnText16Trampoline = NULL;
static void *g_sqlite3ExecTrampoline = NULL;
static void *g_sqlite3PrepareV2Trampoline = NULL;
static void *g_sqlite3StepTrampoline = NULL;
static void *g_sqlite3OpenTrampoline = NULL;
static void *g_textGuiGetStringTrampoline = NULL;
static void *g_createFileWTrampoline = NULL;
static void *g_createFileATrampoline = NULL;
static void *g_jsNewStringCopyNTrampoline = NULL;
static void *g_jsNewStringCopyZTrampoline = NULL;
static void *g_jsNewUCStringCopyNTrampoline = NULL;
static void *g_jsNewUCStringCopyZTrampoline = NULL;
static void *g_jsNewUCStringTrampoline = NULL;
static void *g_jsInternStringTrampoline = NULL;
static void *g_jsInternStringNTrampoline = NULL;
static void *g_jsInternUCStringTrampoline = NULL;
static void *g_jsInternUCStringNTrampoline = NULL;
static void *g_jsParseJsonRawTrampoline = NULL;
static void *g_messageTextUiUpdateTrampoline = NULL;
static void *g_scrollMessageTextUiUpdateTrampoline = NULL;
static void *g_messageTextUiSetTextGuiTrampoline = NULL;
static void *g_scrollMessageTextUiSetTextGuiTrampoline = NULL;
static void *g_guiAddActionCommandMessageGui3Trampoline = NULL;
static void *g_guiAddActionCommandMessageGui2Trampoline = NULL;
static void *g_guiAddActionCommandScrollMessageGui3Trampoline = NULL;
static void *g_guiAddActionCommandScrollMessageGui2Trampoline = NULL;
static void *g_messageTextUiCreateTrampoline = NULL;
static void *g_scrollMessageTextUiCreateTrampoline = NULL;
static void *g_messageTextUiInitTrampoline = NULL;
static void *g_scrollMessageTextUiInitTrampoline = NULL;
static void *g_messageTextUiSetDataTrampoline = NULL;
static void *g_scrollMessageTextUiSetDataTrampoline = NULL;
static void *g_messageTextUiGetDataTrampoline = NULL;
static void *g_scrollMessageTextUiGetDataTrampoline = NULL;
static void *g_messageWindowNodeCreateMessageTrampoline = NULL;
static void *g_messageWindowNodeCreateScrollTrampoline = NULL;
static void *g_messageWindowNodeInitMessageTrampoline = NULL;
static void *g_messageWindowNodeInitScrollTrampoline = NULL;
static void *g_messageShowGetTextFlagTrampoline = NULL;
static void *g_messageShowGetTextIdTrampoline = NULL;
static void *g_messageShowGetVariableIdTrampoline = NULL;
static void *g_messageShowGetVariableObjectIdTrampoline = NULL;
static void *g_messageShowGetVariableQualifierIdTrampoline = NULL;
static void *g_scrollMessageShowGetTextIdTrampoline = NULL;
static void *g_messageShowSetTextIdTrampoline = NULL;
static void *g_messageShowSetTextFlagTrampoline = NULL;
static void *g_messageShowSetVariableIdTrampoline = NULL;
static void *g_messageShowSetVariableObjectIdTrampoline = NULL;
static void *g_messageShowSetVariableQualifierIdTrampoline = NULL;
static void *g_scrollMessageShowSetTextIdTrampoline = NULL;
static void *g_crtFopenOriginal = NULL;
static void *g_crtFopenSOriginal = NULL;
static void *g_crtFreadOriginal = NULL;
static LONG g_textDataGetTextCallCount = 0;
static LONG g_cStringCallCount = 0;
static LONG g_sqliteCallCount = 0;
static LONG g_fileHookCallCount = 0;
static LONG g_jsStringCallCount = 0;
static LONG g_jsStringLoggedCount = 0;
static LONG g_objectCommandProbeCallCount = 0;
static LONG g_getStringResultCount = 0;
static LONG g_messageUiProbeCallCount = 0;
static LONG g_messageUiUpdateSeenCount = 0;
static LONG g_messageUiSetTextGuiLoggedCount = 0;
static LONG g_messageUiUpdateLoggedCount = 0;
static LONG g_messageFlowProbeCallCount = 0;
static LONG g_messageFlowLoggedCount = 0;
static LONG g_messageFlowOtherLoggedCount = 0;
static LONG g_messageFlowConfirmedDataCount = 0;
static LONG g_valueHookCallCount = 0;
static LONG g_valueGetCallCount = 0;
static LONG g_crtFileCallCount = 0;
static LONG g_crtReadCallCount = 0;
static LONG g_inFileHook = 0;  /* re-entrancy guard: FlushLog() calls CreateFileW */
static void *g_messageShowDataVtable = NULL;
static void *g_scrollMessageShowDataVtable = NULL;
static void *g_observedMessageShowDataVtable = NULL;
static void *g_observedScrollMessageShowDataVtable = NULL;
static void *g_messageUiSeenPointers[MAX_TRACKED_MESSAGE_POINTERS];
static int g_messageUiSeenPointerCount = 0;
static MessageUiTextGuiLink g_messageUiTextGuiLinks[MAX_TRACKED_MESSAGE_TEXT_GUI_LINKS];
static int g_messageUiTextGuiLinkCount = 0;

static const char g_labelUpdateText7[] = "updateText-7";
static const char g_labelUpdateText8[] = "updateText-8";
static const char g_labelUpdateTextRender7[] = "updateTextRender-7";
static const char g_labelUpdateTextRender8[] = "updateTextRender-8";
static const char g_labelFontManagerCreateOrSet[] = "FontManager::createOrSetWithFontData";
static const char g_labelTextLineNodeCreate[] = "TextLineNode::create";
static const char g_labelTextLineNodeInit[] = "TextLineNode::init";
static const char g_labelTextureInitFontDef[] = "Texture2D::initWithString-fontDef";
static const char g_labelTextureInitFull[] = "Texture2D::initWithString-full";
static const char g_labelLabelSetString[] = "Label::setString";
static const char g_labelLabelBMFontSetString[] = "LabelBMFont::setString";
static const char g_labelLabelTTFSetString[] = "LabelTTF::setString";
static const char g_labelLabelAtlasSetString[] = "LabelAtlas::setString";
static const char g_labelUiTextSetString[] = "ui::Text::setString";
static const char g_labelUiTextSetText[] = "ui::Text::setText";
static const char g_labelUiTextBMFontSetString[] = "ui::TextBMFont::setString";
static const char g_labelUiTextBMFontSetText[] = "ui::TextBMFont::setText";
static const char g_labelGetExpandedText[] = "ProjectData::getExpandedText";
static const char g_labelGetExpandedTextResult[] = "ProjectData::getExpandedText-result";
static const char g_labelExecActionMessageShow[] = "ObjectAction::execActionMessageShow";
static const char g_labelExecActionScrollMessageShow[] = "ObjectAction::execActionScrollMessageShow";
static const char g_labelSqlite3ColumnText[] = "sqlite3_column_text";
static const char g_labelSqlite3ColumnTextResult[] = "sqlite3_column_text-result";
static const char g_labelSqlite3ColumnText16[] = "sqlite3_column_text16";
static const char g_labelSqlite3Exec[] = "sqlite3_exec";
static const char g_labelSqlite3PrepareV2[] = "sqlite3_prepare_v2";
static const char g_labelSqlite3Step[] = "sqlite3_step";
static const char g_labelSqlite3Open[] = "sqlite3_open";
static const char g_labelTextGuiGetString[] = "TextGui::getString";
static const char g_labelTextGuiGetStringResult[] = "TextGui::getString-result";
static const char g_labelCreateFileW[] = "CreateFileW";
static const char g_labelCreateFileA[] = "CreateFileA";
static const char g_labelJsNewStringCopyN[] = "JS_NewStringCopyN";
static const char g_labelJsNewStringCopyZ[] = "JS_NewStringCopyZ";
static const char g_labelJsNewUCStringCopyN[] = "JS_NewUCStringCopyN";
static const char g_labelJsNewUCStringCopyZ[] = "JS_NewUCStringCopyZ";
static const char g_labelJsNewUCString[] = "JS_NewUCString";
static const char g_labelJsInternString[] = "JS_InternString";
static const char g_labelJsInternStringN[] = "JS_InternStringN";
static const char g_labelJsInternUCString[] = "JS_InternUCString";
static const char g_labelJsInternUCStringN[] = "JS_InternUCStringN";
static const char g_labelJsParseJsonRaw[] = "JS_ParseJSON-raw";
static const char g_labelMessageTextUiUpdate[] = "ActionCommandMessageTextUi::update";
static const char g_labelScrollMessageTextUiUpdate[] = "ActionCommandScrollMessageTextUi::update";
static const char g_labelMessageTextUiSetTextGui[] = "ActionCommandMessageTextUi::setTextGui";
static const char g_labelScrollMessageTextUiSetTextGui[] = "ActionCommandScrollMessageTextUi::setTextGui";
static const char g_labelGuiAddActionCommandMessageGui3[] = "GuiManager::addActionCommandMessageGui-3";
static const char g_labelGuiAddActionCommandMessageGui2[] = "GuiManager::addActionCommandMessageGui-2";
static const char g_labelGuiAddActionCommandScrollMessageGui3[] = "GuiManager::addActionCommandScrollMessageGui-3";
static const char g_labelGuiAddActionCommandScrollMessageGui2[] = "GuiManager::addActionCommandScrollMessageGui-2";
static const char g_labelMessageTextUiCreate[] = "ActionCommandMessageTextUi::create";
static const char g_labelScrollMessageTextUiCreate[] = "ActionCommandScrollMessageTextUi::create";
static const char g_labelMessageTextUiInit[] = "ActionCommandMessageTextUi::init";
static const char g_labelScrollMessageTextUiInit[] = "ActionCommandScrollMessageTextUi::init";
static const char g_labelMessageTextUiSetData[] = "ActionCommandMessageTextUi::setData";
static const char g_labelScrollMessageTextUiSetData[] = "ActionCommandScrollMessageTextUi::setData";
static const char g_labelMessageTextUiGetData[] = "ActionCommandMessageTextUi::getData";
static const char g_labelScrollMessageTextUiGetData[] = "ActionCommandScrollMessageTextUi::getData";
static const char g_labelMessageWindowNodeCreateMessage[] = "MessageWindowNode::create-message";
static const char g_labelMessageWindowNodeCreateScroll[] = "MessageWindowNode::create-scroll";
static const char g_labelMessageWindowNodeInitMessage[] = "MessageWindowNode::init-message";
static const char g_labelMessageWindowNodeInitScroll[] = "MessageWindowNode::init-scroll";
static const char g_labelMessageShowGetTextFlag[] = "ObjectCommandMessageShowData::getTextFlag";
static const char g_labelMessageShowGetTextId[] = "ObjectCommandMessageShowData::getTextId";
static const char g_labelMessageShowGetVariableId[] = "ObjectCommandMessageShowData::getVariableId";
static const char g_labelMessageShowGetVariableObjectId[] = "ObjectCommandMessageShowData::getVariableObjectId";
static const char g_labelMessageShowGetVariableQualifierId[] = "ObjectCommandMessageShowData::getVariableQualifierId";
static const char g_labelScrollMessageShowGetTextId[] = "ObjectCommandScrollMessageShowData::getTextId";
static const char g_labelMessageShowSetTextId[] = "ObjectCommandMessageShowData::setTextId";
static const char g_labelMessageShowSetTextFlag[] = "ObjectCommandMessageShowData::setTextFlag";
static const char g_labelMessageShowSetVariableId[] = "ObjectCommandMessageShowData::setVariableId";
static const char g_labelMessageShowSetVariableObjectId[] = "ObjectCommandMessageShowData::setVariableObjectId";
static const char g_labelMessageShowSetVariableQualifierId[] = "ObjectCommandMessageShowData::setVariableQualifierId";
static const char g_labelScrollMessageShowSetTextId[] = "ObjectCommandScrollMessageShowData::setTextId";
static const char g_labelCrtFopen[] = "CRT::fopen";
static const char g_labelCrtFopenS[] = "CRT::fopen_s";
static const char g_labelCrtFread[] = "CRT::fread";

static void DetourUpdateText7(void);
static void DetourUpdateText8(void);
static void DetourUpdateTextRender7(void);
static void DetourUpdateTextRender8(void);
static void DetourTextDataGetText(void);
static void DetourFontManagerCreateOrSet(void);
static void DetourTextLineNodeCreate(void);
static void DetourTextLineNodeInit(void);
static void DetourTextureInitWithStringFontDef(void);
static void DetourTextureInitWithStringFull(void);
static void DetourLabelSetString(void);
static void DetourLabelBMFontSetString(void);
static void DetourLabelTTFSetString(void);
static void DetourLabelAtlasSetString(void);
static void DetourUiTextSetString(void);
static void DetourUiTextSetText(void);
static void DetourUiTextBMFontSetString(void);
static void DetourUiTextBMFontSetText(void);
static void DetourGetExpandedText(void);
static void DetourExecActionMessageShow(void);
static void DetourExecActionScrollMessageShow(void);
static void DetourSqlite3ColumnText(void);
static void DetourSqlite3ColumnText16(void);
static void DetourSqlite3Exec(void);
static void DetourSqlite3PrepareV2(void);
static void DetourSqlite3Step(void);
static void DetourSqlite3Open(void);
static void DetourTextGuiGetString(void);
static void DetourCreateFileW(void);
static void DetourCreateFileA(void);
static void DetourJsNewStringCopyN(void);
static void DetourJsNewStringCopyZ(void);
static void DetourJsNewUCStringCopyN(void);
static void DetourJsNewUCStringCopyZ(void);
static void DetourJsNewUCString(void);
static void DetourJsInternString(void);
static void DetourJsInternStringN(void);
static void DetourJsInternUCString(void);
static void DetourJsInternUCStringN(void);
static void DetourJsParseJsonRaw(void);
static void DetourMessageTextUiUpdate(void);
static void DetourScrollMessageTextUiUpdate(void);
static void DetourMessageTextUiSetTextGui(void);
static void DetourScrollMessageTextUiSetTextGui(void);
static void DetourGuiAddActionCommandMessageGui3(void);
static void DetourGuiAddActionCommandMessageGui2(void);
static void DetourGuiAddActionCommandScrollMessageGui3(void);
static void DetourGuiAddActionCommandScrollMessageGui2(void);
static void DetourMessageTextUiCreate(void);
static void DetourScrollMessageTextUiCreate(void);
static void DetourMessageTextUiInit(void);
static void DetourScrollMessageTextUiInit(void);
static void DetourMessageTextUiSetData(void);
static void DetourScrollMessageTextUiSetData(void);
static void DetourMessageTextUiGetData(void);
static void DetourScrollMessageTextUiGetData(void);
static void DetourMessageWindowNodeCreateMessage(void);
static void DetourMessageWindowNodeCreateScroll(void);
static void DetourMessageWindowNodeInitMessage(void);
static void DetourMessageWindowNodeInitScroll(void);
static void DetourMessageShowGetTextFlag(void);
static void DetourMessageShowGetTextId(void);
static void DetourMessageShowGetVariableId(void);
static void DetourMessageShowGetVariableObjectId(void);
static void DetourMessageShowGetVariableQualifierId(void);
static void DetourScrollMessageShowGetTextId(void);
static void DetourMessageShowSetTextId(void);
static void DetourMessageShowSetTextFlag(void);
static void DetourMessageShowSetVariableId(void);
static void DetourMessageShowSetVariableObjectId(void);
static void DetourMessageShowSetVariableQualifierId(void);
static void DetourScrollMessageShowSetTextId(void);
static void DetourCrtFopen(void);
static void DetourCrtFopenS(void);
static void DetourCrtFread(void);

static int CopyCStringPreview(const char *value, char *output, DWORD outputSize) {
    DWORD i;

    if (!value || !output || outputSize == 0) {
        return 0;
    }

    output[0] = '\0';

    __try {
        for (i = 0; i < outputSize - 1 && i < 2048; i++) {
            unsigned char ch = (unsigned char)value[i];

            if (ch == '\0') {
                break;
            }

            if (ch == '\r' || ch == '\n' || ch == '\t') {
                output[i] = ' ';
            } else if (ch < 0x20) {
                output[i] = '.';
            } else {
                output[i] = (char)ch;
            }
        }

        output[i] = '\0';
        return i > 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        output[0] = '\0';
        return 0;
    }
}

static int CopyCStringNPreview(const char *value, DWORD length, char *output, DWORD outputSize) {
    DWORD i;
    DWORD maxLength = length;

    if (!value || !output || outputSize == 0) {
        return 0;
    }

    if (maxLength > 2048) {
        maxLength = 2048;
    }

    output[0] = '\0';

    __try {
        for (i = 0; i < outputSize - 1 && i < maxLength; i++) {
            unsigned char ch = (unsigned char)value[i];

            if (ch == '\0') {
                break;
            }

            if (ch == '\r' || ch == '\n' || ch == '\t') {
                output[i] = ' ';
            } else if (ch < 0x20) {
                output[i] = '.';
            } else {
                output[i] = (char)ch;
            }
        }

        output[i] = '\0';
        return i > 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        output[0] = '\0';
        return 0;
    }
}

static int CopyWideStringNPreview(const wchar_t *value, DWORD length,
                                  char *output, DWORD outputSize) {
    wchar_t temp[256];
    DWORD i;
    DWORD maxLength = length;
    int converted;

    if (!value || !output || outputSize == 0) {
        return 0;
    }

    if (maxLength >= (DWORD)(sizeof(temp) / sizeof(temp[0]))) {
        maxLength = (DWORD)(sizeof(temp) / sizeof(temp[0])) - 1;
    }

    output[0] = '\0';

    __try {
        for (i = 0; i < maxLength; i++) {
            wchar_t ch = value[i];

            if (ch == L'\0') {
                break;
            }

            if (ch == L'\r' || ch == L'\n' || ch == L'\t') {
                temp[i] = L' ';
            } else if (ch < 0x20) {
                temp[i] = L'.';
            } else {
                temp[i] = ch;
            }
        }
        temp[i] = L'\0';
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        output[0] = '\0';
        return 0;
    }

    if (i == 0) {
        return 0;
    }

    converted = WideCharToMultiByte(CP_UTF8, 0, temp, -1,
                                    output, (int)outputSize - 1, NULL, NULL);
    if (converted <= 0) {
        output[0] = '\0';
        return 0;
    }

    output[outputSize - 1] = '\0';
    return 1;
}

static int CopyWideStringPreview(const wchar_t *value, char *output, DWORD outputSize) {
    return CopyWideStringNPreview(value, 255, output, outputSize);
}

static int PreviewLooksInteresting(const char *preview) {
    const unsigned char *p;
    int printable = 0;
    int highBit = 0;
    int dot = 0;
    int length = 0;

    if (!preview) {
        return 0;
    }

    for (p = (const unsigned char *)preview; *p; p++) {
        length++;
        if (*p >= 0x80) {
            highBit++;
        } else if (*p >= 0x20 && *p <= 0x7E) {
            printable++;
            if (*p == '.') {
                dot++;
            }
        }
    }

    if (length == 0) {
        return 0;
    }

    /* Japanese text encoded as UTF-8 or Shift-JIS will normally contain high-bit bytes. */
    if (highBit > 0) {
        return 1;
    }

    return length >= 3 && printable * 4 >= length * 3 && dot * 3 < length;
}

static int PreviewHasHighBit(const char *preview) {
    const unsigned char *p;

    if (!preview) {
        return 0;
    }

    for (p = (const unsigned char *)preview; *p; p++) {
        if (*p >= 0x80) {
            return 1;
        }
    }

    return 0;
}

static int PreviewContainsKeyword(const char *preview) {
    if (!preview) {
        return 0;
    }

    return strstr(preview, "project.json") ||
           strstr(preview, "messageShow") ||
           strstr(preview, "textId") ||
           strstr(preview, "textFlag") ||
           strstr(preview, "variableId") ||
           strstr(preview, "TextGui") ||
           strstr(preview, "ActionCommand") ||
           strstr(preview, "Agtk") ||
           strstr(preview, "JSON.parse");
}

static int ShouldLogJsPreview(LONG seenNo, const char *preview,
                              DWORD length, DWORD hasLength) {
    if (seenNo <= 20) {
        return 1;
    }

    if (!preview || preview[0] == '\0') {
        return 0;
    }

    if (PreviewHasHighBit(preview)) {
        return 1;
    }

    /* Large buffers are rare and useful: project.json enters SpiderMonkey this way. */
    if (hasLength && length >= 512) {
        return 1;
    }

    return PreviewContainsKeyword(preview);
}

static int TryReadDword(const void *address, DWORD *value) {
    if (!address || !value) {
        return 0;
    }

    __try {
        *value = *(const DWORD *)address;
        return 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

static int IsLikelyUserPointer(DWORD value) {
    return value >= 0x10000 && value < 0x7FFF0000;
}

static int ReadMsvcStdString(const void *stringArg, char *output, DWORD outputSize,
                             DWORD *outSize, DWORD *outCapacity) {
    if (!stringArg || !output || outputSize == 0) {
        return 0;
    }

    output[0] = '\0';

    __try {
        const BYTE *objectBytes = (const BYTE *)stringArg;
        DWORD size = *(const DWORD *)(objectBytes + 16);
        DWORD capacity = *(const DWORD *)(objectBytes + 20);
        const char *data = NULL;
        DWORD copyLength;

        if (outSize) *outSize = size;
        if (outCapacity) *outCapacity = capacity;

        if (size > 2048 || capacity < size || capacity > 1024 * 1024) {
            return 0;
        }

        /* MSVC x86 std::string is 24 bytes: local buffer/pointer + size + capacity. */
        if (capacity < 16) {
            data = (const char *)objectBytes;
        } else {
            data = *(const char * const *)objectBytes;
        }

        if (!data) {
            return 0;
        }

        copyLength = size;
        if (copyLength >= outputSize) {
            copyLength = outputSize - 1;
        }

        for (DWORD i = 0; i < copyLength; i++) {
            unsigned char ch = (unsigned char)data[i];

            if (ch == '\r' || ch == '\n' || ch == '\t') {
                output[i] = ' ';
            } else if (ch < 0x20) {
                output[i] = '.';
            } else {
                output[i] = (char)ch;
            }
        }

        output[copyLength] = '\0';
        return 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

/* Decode a single x86 instruction and return its length. Returns 0 on failure. */
static int GetX86InstructionLength(const BYTE *code) {
    BYTE b = code[0];

    /* Single-byte: push/pop reg (50-5F), inc/dec reg (40-4F), etc. */
    if ((b >= 0x50 && b <= 0x5F) || (b >= 0x40 && b <= 0x47)) {
        return 1;
    }

    /* push/pop segment registers */
    if (b == 0x06 || b == 0x07 || b == 0x0E || b == 0x16 ||
        b == 0x17 || b == 0x1E || b == 0x1F) {
        return 1;
    }

    /* Conditional jumps (short): 70-7F */
    if (b >= 0x70 && b <= 0x7F) return 2;
    /* LOOP / LOOPZ / LOOPNZ */
    if (b == 0xE2 || b == 0xE1 || b == 0xE0) return 2;
    /* JMP short */
    if (b == 0xEB) return 2;
    /* CALL/JMP near relative */
    if (b == 0xE8 || b == 0xE9) return 5;
    /* PUSH imm8 */
    if (b == 0x6A) return 2;
    /* PUSH imm32 */
    if (b == 0x68) return 5;
    /* RET / RET imm16 */
    if (b == 0xC3) return 1;
    if (b == 0xC2) return 3;

    /* Two-byte opcodes */
    if (b == 0x0F) {
        BYTE b2 = code[1];
        if (b2 >= 0x80 && b2 <= 0x8F) return 6;  /* Jcc near */
        return 2;  /* conservative for other 0F opcodes */
    }

    /* Decode ModR/M byte (0x80-0x8F, 0x88-0x8B, etc.) */
    if (b >= 0x80) {
        BYTE modrm = code[1];
        BYTE mod = (modrm >> 6) & 3;
        BYTE rm = modrm & 7;

        int baseLen = 2;  /* opcode + modrm */

        /* Check for SIB byte */
        if (mod != 3 && rm == 4) baseLen++;

        /* Displacement */
        if (mod == 1) baseLen += 1;      /* disp8 */
        else if (mod == 2) baseLen += 4; /* disp32 */
        else if (mod == 0 && rm == 5) baseLen += 4; /* [disp32] */

        /* Immediate: GROUP 1 (80-83): imm8 for 80/82/83, imm32 for 81 */
        if (b == 0x80 || b == 0x82 || b == 0x83) baseLen += 1;
        else if (b == 0x81) baseLen += 4;
        /* MOV [mem], imm: imm8 for C6, imm32 for C7 */
        else if (b == 0xC6 || b == 0xC7) baseLen += (b == 0xC6) ? 1 : 4;

        return baseLen;
    }

    /* MOV / LEA with 16/32-bit immediate address (A0-A3) */
    if (b >= 0xA0 && b <= 0xA3) return 5;
    /* TEST / MOV / etc. with imm8/imm32 to AL/AX/EAX */
    if ((b >= 0xA8 && b <= 0xA9) || (b >= 0xB0 && b <= 0xBF)) return 2;
    /* MOV reg, imm32 */
    if (b >= 0xB8 && b <= 0xBF) return 5;
    /* INT3 */
    if (b == 0xCC) return 1;

    return 0;  /* Unknown */
}

/*
 * Calculate safe patch size for an MSVC x86 function prologue.
 * Decodes x86 instructions from the target address until we cover >= 5 bytes,
 * stopping at an instruction boundary. Skips tail-call thunks (pop ebp + jmp).
 * Returns 0 if the function doesn't look like a safe-to-hook MSVC prologue.
 */
static int GetProloguePatchSize(const BYTE *target) {
    int start = 0;

    /* Windows hotpatch prefix: 8B FF = mov edi, edi (2-byte NOP).
     * Skip it so we can hook kernel32 and other system DLLs. */
    if (target[0] == 0x8B && target[1] == 0xFF) {
        start = 2;
    }

    /* All MSVC x86 prologues start with: push ebp; mov ebp, esp */
    if (target[start] != 0x55 || target[start + 1] != 0x8B || target[start + 2] != 0xEC) {
        return 0;
    }

    int offset = start + 3;  /* After push ebp; mov ebp, esp */

    while (offset < MAX_HOOK_PATCH_SIZE) {
        /* Detect tail-call thunk: pop ebp followed by jmp */
        if (target[offset] == 0x5D) {
            /* pop ebp — this is a thunk, not a real function */
            return 0;
        }

        /* Detect __security_check_cookie thunks — they call __security_check_cookie then ret */
        if (target[offset] == 0xE8) {
            /* call rel32 in prologue = likely security cookie, but this means the function
               is real. Allow it but stop here to avoid relocating the call. */
            return offset;  /* patch before the call, if >= 5 */
        }

        int instrLen = GetX86InstructionLength(target + offset);
        if (instrLen <= 0) {
            /* Unknown instruction — if we have enough bytes, stop here;
               otherwise fail to avoid corrupting instructions. */
            if (offset >= MIN_HOOK_PATCH_SIZE) return offset;
            return 0;
        }

        offset += instrLen;

        if (offset >= MIN_HOOK_PATCH_SIZE && offset <= MAX_HOOK_PATCH_SIZE) {
            return offset;
        }
    }

    return 0;
}

static int HasRelativeControlFlow(const BYTE *instruction) {
    BYTE b = instruction[0];

    if (b == 0xE8 || b == 0xE9 || b == 0xEB) {
        return 1;
    }

    if (b >= 0x70 && b <= 0x7F) {
        return 1;
    }

    if (b == 0x0F) {
        BYTE b2 = instruction[1];
        if (b2 >= 0x80 && b2 <= 0x8F) {
            return 1;
        }
    }

    return 0;
}

static int GetSequentialPatchSize(const BYTE *target) {
    int offset = 0;

    while (offset < MAX_HOOK_PATCH_SIZE) {
        int instrLen;

        if (HasRelativeControlFlow(target + offset)) {
            return 0;
        }

        instrLen = GetX86InstructionLength(target + offset);
        if (instrLen <= 0) {
            return 0;
        }

        offset += instrLen;
        if (offset >= MIN_HOOK_PATCH_SIZE && offset <= MAX_HOOK_PATCH_SIZE) {
            return offset;
        }
    }

    return 0;
}

static void __cdecl LogTextCall(const char *label, const void *stringArg) {
    LONG callNo = InterlockedIncrement(&g_textCallCount);
    char text[512];
    DWORD size = 0;
    DWORD capacity = 0;

    if (callNo > MAX_CAPTURED_TEXT_CALLS) {
        return;
    }

    if (ReadMsvcStdString(stringArg, text, sizeof(text), &size, &capacity)) {
        Log("[TextHook:%ld] %s size=%lu capacity=%lu text=%s\n",
            callNo, label, size, capacity, text);
    } else {
        /* Log raw bytes of the supposed std::string for diagnosis. */
        const BYTE *obj = (const BYTE *)stringArg;
        DWORD rawSize = 0, rawCap = 0;
        __try {
            rawSize = *(const DWORD *)(obj + 16);
            rawCap = *(const DWORD *)(obj + 20);
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        Log("[TextHook:%ld] %s decode-failed ptr=0x%p rawSize=%lu rawCap=%lu bytes=%02X%02X%02X%02X...\n",
            callNo, label, stringArg, rawSize, rawCap,
            obj[0] & 0xFF, obj[1] & 0xFF, obj[2] & 0xFF, obj[3] & 0xFF);
    }

    if (callNo == MAX_CAPTURED_TEXT_CALLS) {
        Log("[TextHook] capture limit reached; further calls are ignored.\n");
    }

    FlushLog();
}

static void __cdecl LogCStringCall(const char *label, const char *text) {
    LONG callNo = InterlockedIncrement(&g_cStringCallCount);
    char preview[512];

    if (callNo > MAX_CAPTURED_TEXT_CALLS) {
        return;
    }

    if (CopyCStringPreview(text, preview, sizeof(preview))) {
        Log("[CStringHook:%ld] %s text=%s\n", callNo, label, preview);
    } else {
        Log("[CStringHook:%ld] %s text=<empty-or-unreadable> ptr=0x%p\n",
            callNo, label, text);
    }

    if (callNo == MAX_CAPTURED_TEXT_CALLS) {
        Log("[CStringHook] capture limit reached; further calls are ignored.\n");
    }

    FlushLog();
}

static void __cdecl LogFileOpenW(const wchar_t *filename) {
    LONG callNo = InterlockedIncrement(&g_fileHookCallCount);
    char narrow[MAX_PATH * 4];
    int len;

    if (callNo > 500) {
        if (callNo == 501) {
            Log("[FileHook] capture limit reached; further calls are ignored.\n");
            /* Cannot FlushLog here — FlushLog calls CreateFileW */
        }
        return;
    }

    len = WideCharToMultiByte(CP_UTF8, 0, filename, -1,
                               narrow, (int)sizeof(narrow) - 1, NULL, NULL);
    if (len <= 0) {
        narrow[0] = '?';
        narrow[1] = 0;
    } else {
        narrow[len] = 0;
    }
    Log("[FileHook:%ld] CreateFileW: %s\n", callNo, narrow);
    /* Do NOT flush — FlushLog() calls CreateFileW which would recurse. */
}

static void __cdecl LogFileOpenA(const char *filename) {
    LONG callNo = InterlockedIncrement(&g_fileHookCallCount);
    if (callNo > 500) return;
    Log("[FileHook:%ld] CreateFileA: %s\n", callNo, filename);
    /* Do NOT flush — FlushLog() calls CreateFileW which would recurse. */
}

static void __cdecl LogStdStringRefCall(const char *label, const void *stringArg) {
    LONG callNo = InterlockedIncrement(&g_cStringCallCount);
    char text[512];
    DWORD size = 0;
    DWORD capacity = 0;

    if (callNo > MAX_CAPTURED_TEXT_CALLS) {
        return;
    }

    if (ReadMsvcStdString(stringArg, text, sizeof(text), &size, &capacity)) {
        Log("[StringHook:%ld] %s size=%lu capacity=%lu text=%s\n",
            callNo, label, size, capacity, text);
    } else {
        const BYTE *obj = (const BYTE *)stringArg;
        DWORD rawSize = 0, rawCap = 0;
        __try {
            rawSize = *(const DWORD *)(obj + 16);
            rawCap = *(const DWORD *)(obj + 20);
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        Log("[StringHook:%ld] %s decode-failed ptr=0x%p rawSize=%lu rawCap=%lu\n",
            callNo, label, stringArg, rawSize, rawCap);
    }

    if (callNo == MAX_CAPTURED_TEXT_CALLS) {
        Log("[StringHook] capture limit reached; further calls are ignored.\n");
    }

    FlushLog();
}

static void LogPointerStringCandidate(const char *prefix, LONG callNo,
                                      const char *kind, DWORD offset,
                                      DWORD pointerValue) {
    char text[512];
    DWORD size = 0;
    DWORD capacity = 0;

    if (CopyCStringPreview((const char *)pointerValue, text, sizeof(text)) &&
        PreviewLooksInteresting(text)) {
        Log("  [%s:%ld] +0x%02lX -> %s cstr ptr=0x%08lX text=%s\n",
            prefix, callNo, offset, kind, pointerValue, text);
    }

    if (ReadMsvcStdString((const void *)pointerValue, text, sizeof(text), &size, &capacity) &&
        PreviewLooksInteresting(text)) {
        Log("  [%s:%ld] +0x%02lX -> %s std::string ptr=0x%08lX size=%lu cap=%lu text=%s\n",
            prefix, callNo, offset, kind, pointerValue, size, capacity, text);
    }
}

static void DumpPointerProbeBody(const char *prefix, LONG callNo,
                                 const void *objectPtr, DWORD dumpBytes) {
    const BYTE *base = (const BYTE *)objectPtr;

    if (!objectPtr) {
        return;
    }

    /* Raw dword dump first: this makes unknown field offsets easy to compare across runs. */
    for (DWORD row = 0; row < dumpBytes; row += 0x10) {
        DWORD v0 = 0, v1 = 0, v2 = 0, v3 = 0;
        int ok0 = TryReadDword(base + row, &v0);
        int ok1 = TryReadDword(base + row + 4, &v1);
        int ok2 = TryReadDword(base + row + 8, &v2);
        int ok3 = TryReadDword(base + row + 12, &v3);

        Log("  +0x%02lX: %s%08lX %s%08lX %s%08lX %s%08lX\n",
            row,
            ok0 ? "" : "?", v0,
            ok1 ? "" : "?", v1,
            ok2 ? "" : "?", v2,
            ok3 ? "" : "?", v3);
    }

    /* Try inline std::string fields at every aligned offset. */
    for (DWORD offset = 0; offset + 24 <= dumpBytes; offset += 4) {
        char text[512];
        DWORD size = 0;
        DWORD capacity = 0;

        if (ReadMsvcStdString(base + offset, text, sizeof(text), &size, &capacity) &&
            PreviewLooksInteresting(text)) {
            Log("  [%s:%ld] inline std::string at +0x%02lX size=%lu cap=%lu text=%s\n",
                prefix, callNo, offset, size, capacity, text);
        }
    }

    /* Try direct and one-level nested pointers. ObjectCommandData often stores sub-objects. */
    for (DWORD offset = 0; offset + 4 <= dumpBytes; offset += 4) {
        DWORD ptr = 0;
        DWORD nested = 0;

        if (!TryReadDword(base + offset, &ptr) || !IsLikelyUserPointer(ptr)) {
            continue;
        }

        LogPointerStringCandidate(prefix, callNo, "direct", offset, ptr);

        if (TryReadDword((const void *)ptr, &nested) && IsLikelyUserPointer(nested)) {
            LogPointerStringCandidate(prefix, callNo, "nested", offset, nested);
        }
    }
}

static void __cdecl LogObjectCommandDataProbe(const char *label, void *thisPtr,
                                              const void *commandData) {
    LONG callNo = InterlockedIncrement(&g_objectCommandProbeCallCount);

    if (callNo > MAX_CAPTURED_OBJECT_PROBES) {
        if (callNo == MAX_CAPTURED_OBJECT_PROBES + 1) {
            Log("[ObjectCommandProbe] capture limit reached; further calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    Log("[ObjectCommandProbe:%ld] %s this=0x%p ObjectCommandData=0x%p\n",
        callNo, label, thisPtr, commandData);

    DumpPointerProbeBody("ObjectCommandProbe", callNo, commandData, 0x80);

    if (callNo == MAX_CAPTURED_OBJECT_PROBES) {
        Log("[ObjectCommandProbe] capture limit reached; further calls are ignored.\n");
    }

    FlushLog();
}

static int RememberMessageUiUpdatePointer(const void *thisPtr) {
    int i;

    if (!thisPtr) {
        return 0;
    }

    for (i = 0; i < g_messageUiSeenPointerCount; i++) {
        if (g_messageUiSeenPointers[i] == thisPtr) {
            return 0;
        }
    }

    if (g_messageUiSeenPointerCount < MAX_TRACKED_MESSAGE_POINTERS) {
        g_messageUiSeenPointers[g_messageUiSeenPointerCount++] = (void *)thisPtr;
        return 1;
    }

    return 0;
}

static int ShouldLogMessageUiUpdate(const void *thisPtr, LONG seenNo) {
    int isNewPointer = RememberMessageUiUpdatePointer(thisPtr);

    /* Keep early frames, new UI objects, and a time-spaced sample.
       The message UI update hook is hot, so dumping every frame hides useful data. */
    if (seenNo <= 20 || isNewPointer) {
        return 1;
    }

    if ((seenNo % MESSAGE_UI_UPDATE_SAMPLE_INTERVAL) == 0) {
        return 1;
    }

    return 0;
}

static void RememberMessageUiTextGui(void *thisPtr, const void *textGuiPtr) {
    int i;

    if (!thisPtr || !textGuiPtr) {
        return;
    }

    for (i = 0; i < g_messageUiTextGuiLinkCount; i++) {
        if (g_messageUiTextGuiLinks[i].thisPtr == thisPtr) {
            g_messageUiTextGuiLinks[i].textGuiPtr = textGuiPtr;
            return;
        }
    }

    if (g_messageUiTextGuiLinkCount < MAX_TRACKED_MESSAGE_TEXT_GUI_LINKS) {
        g_messageUiTextGuiLinks[g_messageUiTextGuiLinkCount].thisPtr = thisPtr;
        g_messageUiTextGuiLinks[g_messageUiTextGuiLinkCount].textGuiPtr = textGuiPtr;
        g_messageUiTextGuiLinkCount++;
    }
}

static const void *FindMessageUiTextGui(const void *thisPtr) {
    int i;

    if (!thisPtr) {
        return NULL;
    }

    for (i = 0; i < g_messageUiTextGuiLinkCount; i++) {
        if (g_messageUiTextGuiLinks[i].thisPtr == thisPtr) {
            return g_messageUiTextGuiLinks[i].textGuiPtr;
        }
    }

    return NULL;
}

static void __cdecl LogMessageUiUpdateProbe(const char *label, void *thisPtr,
                                            DWORD deltaTimeBits) {
    LONG seenNo;
    LONG callNo;
    const void *textGuiPtr;

    InterlockedIncrement(&g_messageUiProbeCallCount);
    seenNo = InterlockedIncrement(&g_messageUiUpdateSeenCount);
    if (!ShouldLogMessageUiUpdate(thisPtr, seenNo)) {
        return;
    }

    callNo = InterlockedIncrement(&g_messageUiUpdateLoggedCount);
    if (callNo > MAX_CAPTURED_MESSAGE_UI_UPDATE_PROBES) {
        if (callNo == MAX_CAPTURED_MESSAGE_UI_UPDATE_PROBES + 1) {
            Log("[MessageUiUpdate] capture limit reached; further update probes are ignored.\n");
            FlushLog();
        }
        return;
    }

    textGuiPtr = FindMessageUiTextGui(thisPtr);
    Log("[MessageUiUpdate:%ld/%ld] %s this=0x%p TextGui=0x%p deltaTimeBits=0x%08lX\n",
        callNo, seenNo, label, thisPtr, textGuiPtr, deltaTimeBits);
    DumpPointerProbeBody("MessageUiProbe", callNo, thisPtr, 0x80);
    if (textGuiPtr) {
        Log("  linked TextGui object:\n");
        DumpPointerProbeBody("MessageUiProbe", callNo, textGuiPtr, 0x80);
    }
    FlushLog();
}

static void __cdecl LogMessageUiTextGuiProbe(const char *label, void *thisPtr,
                                             const void *textGuiPtr) {
    LONG callNo;

    InterlockedIncrement(&g_messageUiProbeCallCount);
    RememberMessageUiTextGui(thisPtr, textGuiPtr);

    callNo = InterlockedIncrement(&g_messageUiSetTextGuiLoggedCount);
    if (callNo > MAX_CAPTURED_MESSAGE_UI_SET_TEXT_GUI_PROBES) {
        if (callNo == MAX_CAPTURED_MESSAGE_UI_SET_TEXT_GUI_PROBES + 1) {
            Log("[MessageUiLink] capture limit reached; further setTextGui probes are ignored.\n");
            FlushLog();
        }
        return;
    }

    Log("[MessageUiLink:%ld] %s this=0x%p TextGui=0x%p\n",
        callNo, label, thisPtr, textGuiPtr);

    if (callNo <= 8) {
        Log("  this object:\n");
        DumpPointerProbeBody("MessageUiProbe", callNo, thisPtr, 0x40);
        Log("  TextGui object:\n");
        DumpPointerProbeBody("MessageUiProbe", callNo, textGuiPtr, 0x80);
    }

    FlushLog();
}

static int VtableMatchesKnownMessageData(void *rawVtable) {
    return (g_messageShowDataVtable && rawVtable == g_messageShowDataVtable) ||
           (g_scrollMessageShowDataVtable && rawVtable == g_scrollMessageShowDataVtable) ||
           (g_observedMessageShowDataVtable && rawVtable == g_observedMessageShowDataVtable) ||
           (g_observedScrollMessageShowDataVtable && rawVtable == g_observedScrollMessageShowDataVtable);
}

static const char *GuessMessageDataKindFromLabel(const char *label) {
    if (!label) {
        return NULL;
    }

    if (strstr(label, "Scroll") || strstr(label, "scroll")) {
        return "scrollMessageData";
    }

    return "messageData";
}

static const char *ClassifyMessageDataPtr(const char *label, const void *dataPtr,
                                          void **outVtable) {
    DWORD rawVtable = 0;
    void *rawVtablePtr;
    const char *expectedKind = GuessMessageDataKindFromLabel(label);

    if (outVtable) {
        *outVtable = NULL;
    }

    if (!TryReadDword(dataPtr, &rawVtable)) {
        return "unreadable";
    }

    if (outVtable) {
        *outVtable = (void *)rawVtable;
    }
    rawVtablePtr = (void *)rawVtable;

    if (VtableMatchesKnownMessageData(rawVtablePtr)) {
        return expectedKind ? expectedKind : "messageData";
    }

    if (g_messageShowDataVtable && rawVtablePtr == g_messageShowDataVtable) {
        return "messageData";
    }

    if (g_scrollMessageShowDataVtable && rawVtablePtr == g_scrollMessageShowDataVtable) {
        return "scrollMessageData";
    }

    return "other";
}

static void LogKnownMessageDataFields(const void *dataPtr, const char *dataKind) {
    const BYTE *base = (const BYTE *)dataPtr;
    DWORD raw24 = 0;
    DWORD raw28 = 0;
    DWORD raw2c = 0;
    DWORD raw30 = 0;
    DWORD raw34 = 0;
    DWORD textFlag = 0;

    if (!dataPtr) {
        return;
    }

    if (lstrcmpA(dataKind, "messageData") == 0) {
        if (!TryReadDword(base + 0x24, &raw24) ||
            !TryReadDword(base + 0x28, &raw28) ||
            !TryReadDword(base + 0x2C, &raw2c) ||
            !TryReadDword(base + 0x30, &raw30) ||
            !TryReadDword(base + 0x34, &raw34)) {
            Log("  messageData fields: unreadable\n");
            return;
        }

        __try {
            textFlag = (DWORD)base[0x24];
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            textFlag = 0;
        }

        Log("  messageData fields: textFlag=%lu textId=%ld variableObjectId=%ld variableQualifierId=%ld variableId=%ld raw24=%08lX raw28=%08lX raw2C=%08lX raw30=%08lX raw34=%08lX\n",
            textFlag, (LONG)raw28, (LONG)raw2c, (LONG)raw30, (LONG)raw34,
            raw24, raw28, raw2c, raw30, raw34);
        return;
    }

    if (lstrcmpA(dataKind, "scrollMessageData") == 0) {
        if (!TryReadDword(base + 0x24, &raw24)) {
            Log("  scrollMessageData fields: unreadable\n");
            return;
        }

        Log("  scrollMessageData fields: textId=%ld raw24=%08lX\n",
            (LONG)raw24, raw24);
        return;
    }

    Log("  messageData fields: skipped for dataKind=%s\n", dataKind);
}

static void __cdecl LogMessageFlowProbe(const char *label, void *thisPtr,
                                        const void *arg1, const void *arg2,
                                        const void *dataPtr) {
    LONG seenNo = InterlockedIncrement(&g_messageFlowProbeCallCount);
    LONG loggedNo;
    LONG otherNo;
    LONG confirmedNo;
    void *dataVtable = NULL;
    const char *dataKind = ClassifyMessageDataPtr(label, dataPtr, &dataVtable);

    if (lstrcmpA(dataKind, "messageData") != 0 &&
        lstrcmpA(dataKind, "scrollMessageData") != 0) {
        otherNo = InterlockedIncrement(&g_messageFlowOtherLoggedCount);
        if (otherNo > MAX_CAPTURED_OTHER_MESSAGE_FLOW_PROBES) {
            if (otherNo == MAX_CAPTURED_OTHER_MESSAGE_FLOW_PROBES + 1) {
                Log("[MessageFlowOther] capture limit reached; further non-message data calls are ignored.\n");
                FlushLog();
            }
            return;
        }

        Log("[MessageFlowOther:%ld/%ld] %s this=0x%p arg1=0x%p arg2=0x%p data=0x%p dataKind=%s dataVtable=0x%p\n",
            otherNo, seenNo, label, thisPtr, arg1, arg2, dataPtr, dataKind, dataVtable);

        if (otherNo <= 4 && dataPtr) {
            DumpPointerProbeBody("MessageFlowOtherData", otherNo, dataPtr, 0x40);
        }

        FlushLog();
        return;
    }

    confirmedNo = InterlockedIncrement(&g_messageFlowConfirmedDataCount);
    loggedNo = InterlockedIncrement(&g_messageFlowLoggedCount);
    if (loggedNo > MAX_CAPTURED_MESSAGE_FLOW_PROBES) {
        if (loggedNo == MAX_CAPTURED_MESSAGE_FLOW_PROBES + 1) {
            Log("[MessageFlow] capture limit reached; further confirmed message data calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    Log("[MessageFlow:%ld/%ld] %s this=0x%p arg1=0x%p arg2=0x%p data=0x%p dataKind=%s dataVtable=0x%p confirmed=%ld\n",
        loggedNo, seenNo, label, thisPtr, arg1, arg2, dataPtr,
        dataKind, dataVtable, confirmedNo);
    LogKnownMessageDataFields(dataPtr, dataKind);

    if (loggedNo <= 40 && dataPtr) {
        DumpPointerProbeBody("MessageFlowData", loggedNo, dataPtr, 0x60);
    }

    FlushLog();
}

static void LearnMessageDataVtableFromSetter(const char *label, void *thisPtr) {
    DWORD rawVtable = 0;
    void **targetSlot;
    const char *kind;

    if (!label || !thisPtr || !TryReadDword(thisPtr, &rawVtable)) {
        return;
    }

    if (strstr(label, "ObjectCommandScrollMessageShowData::")) {
        targetSlot = &g_observedScrollMessageShowDataVtable;
        kind = "scrollMessageData";
    } else if (strstr(label, "ObjectCommandMessageShowData::")) {
        targetSlot = &g_observedMessageShowDataVtable;
        kind = "messageData";
    } else {
        return;
    }

    if (!*targetSlot) {
        *targetSlot = (void *)rawVtable;
        Log("[ValueHook] learned %s vtable from setter: observed=0x%p exportedMessage=0x%p exportedScroll=0x%p label=%s\n",
            kind, *targetSlot, g_messageShowDataVtable, g_scrollMessageShowDataVtable, label);
    }
}

static void __cdecl LogValueGetCall(const char *label, void *thisPtr, DWORD value) {
    LONG callNo = InterlockedIncrement(&g_valueGetCallCount);
    void *dataVtable = NULL;
    const char *dataKind;

    if (callNo > MAX_CAPTURED_VALUE_GET_CALLS) {
        if (callNo == MAX_CAPTURED_VALUE_GET_CALLS + 1) {
            Log("[ValueGet] capture limit reached; further getter calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    dataKind = ClassifyMessageDataPtr(label, thisPtr, &dataVtable);
    Log("[ValueGet:%ld] %s this=0x%p dataKind=%s dataVtable=0x%p value=%ld (0x%08lX)\n",
        callNo, label, thisPtr, dataKind, dataVtable, (LONG)value, value);

    if (callNo <= 8 && thisPtr) {
        DumpPointerProbeBody("ValueGet", callNo, thisPtr, 0x40);
    }

    FlushLog();
}

static void __cdecl LogValueHookCall(const char *label, void *thisPtr, DWORD value) {
    LONG callNo = InterlockedIncrement(&g_valueHookCallCount);

    LearnMessageDataVtableFromSetter(label, thisPtr);

    if (callNo > MAX_CAPTURED_VALUE_HOOK_CALLS) {
        if (callNo == MAX_CAPTURED_VALUE_HOOK_CALLS + 1) {
            Log("[ValueHook] capture limit reached; further calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    Log("[ValueHook:%ld] %s this=0x%p value=%ld (0x%08lX)\n",
        callNo, label, thisPtr, (LONG)value, value);

    if (callNo <= 5 && thisPtr) {
        DumpPointerProbeBody("ValueHook", callNo, thisPtr, 0x40);
    }

    FlushLog();
}

static void __cdecl LogJsCStringCall(const char *label, const char *text,
                                     DWORD length, DWORD hasLength) {
    LONG seenNo = InterlockedIncrement(&g_jsStringCallCount);
    LONG loggedNo;
    char preview[512];
    int hasPreview;
    int shouldLog;

    if (hasLength) {
        hasPreview = CopyCStringNPreview(text, length, preview, sizeof(preview));
    } else {
        hasPreview = CopyCStringPreview(text, preview, sizeof(preview));
    }

    shouldLog = hasPreview && ShouldLogJsPreview(seenNo, preview, length, hasLength);
    if (!shouldLog) {
        return;
    }

    loggedNo = InterlockedIncrement(&g_jsStringLoggedCount);
    if (loggedNo > MAX_CAPTURED_JS_STRING_CALLS) {
        if (loggedNo == MAX_CAPTURED_JS_STRING_CALLS + 1) {
            Log("[JSString] capture limit reached; further calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    if (hasPreview) {
        Log("[JSString:%ld/%ld] %s len=%lu hasLen=%lu text=%s\n",
            loggedNo, seenNo, label, length, hasLength, preview);
    } else {
        Log("[JSString:%ld/%ld] %s text=<empty-or-unreadable> ptr=0x%p len=%lu hasLen=%lu\n",
            loggedNo, seenNo, label, text, length, hasLength);
    }

    FlushLog();
}

static void __cdecl LogJsWideStringCall(const char *label, const wchar_t *text,
                                        DWORD length, DWORD hasLength) {
    LONG seenNo = InterlockedIncrement(&g_jsStringCallCount);
    LONG loggedNo;
    char preview[512];
    int hasPreview;
    int shouldLog;

    if (hasLength) {
        hasPreview = CopyWideStringNPreview(text, length, preview, sizeof(preview));
    } else {
        hasPreview = CopyWideStringPreview(text, preview, sizeof(preview));
    }

    shouldLog = hasPreview && ShouldLogJsPreview(seenNo, preview, length, hasLength);
    if (!shouldLog) {
        return;
    }

    loggedNo = InterlockedIncrement(&g_jsStringLoggedCount);
    if (loggedNo > MAX_CAPTURED_JS_STRING_CALLS) {
        if (loggedNo == MAX_CAPTURED_JS_STRING_CALLS + 1) {
            Log("[JSString] capture limit reached; further calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    if (hasPreview) {
        Log("[JSString:%ld/%ld] %s wideLen=%lu hasLen=%lu text=%s\n",
            loggedNo, seenNo, label, length, hasLength, preview);
    } else {
        Log("[JSString:%ld/%ld] %s text=<empty-or-unreadable> ptr=0x%p wideLen=%lu hasLen=%lu\n",
            loggedNo, seenNo, label, text, length, hasLength);
    }

    FlushLog();
}

static void __cdecl LogCrtFileOpenA(const char *label, const char *filename, const char *mode) {
    LONG callNo = InterlockedIncrement(&g_crtFileCallCount);
    char filePreview[MAX_PATH * 4];
    char modePreview[64];

    if (callNo > MAX_CAPTURED_CRT_FILE_CALLS) {
        if (callNo == MAX_CAPTURED_CRT_FILE_CALLS + 1) {
            Log("[CRTFile] capture limit reached; further opens are ignored.\n");
            FlushLog();
        }
        return;
    }

    if (!CopyCStringPreview(filename, filePreview, sizeof(filePreview))) {
        strcpy_s(filePreview, sizeof(filePreview), "<empty-or-unreadable>");
    }

    if (!CopyCStringPreview(mode, modePreview, sizeof(modePreview))) {
        strcpy_s(modePreview, sizeof(modePreview), "<empty-or-unreadable>");
    }

    Log("[CRTFile:%ld] %s file=%s mode=%s\n", callNo, label, filePreview, modePreview);
    FlushLog();
}

static void __cdecl LogCrtReadCall(const char *label, DWORD size, DWORD count,
                                   const void *stream) {
    LONG callNo = InterlockedIncrement(&g_crtReadCallCount);
    DWORD totalBytes = 0;

    if (size != 0 && count <= 0xFFFFFFFFu / size) {
        totalBytes = size * count;
    }

    if (callNo > MAX_CAPTURED_CRT_READ_CALLS) {
        if (callNo == MAX_CAPTURED_CRT_READ_CALLS + 1) {
            Log("[CRTRead] capture limit reached; further reads are ignored.\n");
            FlushLog();
        }
        return;
    }

    /* Small fread calls are common and noisy. Keep enough detail to identify bulk reads. */
    if (callNo <= 30 || totalBytes >= 64) {
        Log("[CRTRead:%ld] %s size=%lu count=%lu total=%lu stream=0x%p\n",
            callNo, label, size, count, totalBytes, stream);
        FlushLog();
    }
}

static const char *CallTextDataGetTextOriginal(void *thisPtr, const char *key) {
    const char *result = NULL;

#ifdef _M_IX86
    __asm {
        mov ecx, thisPtr
        push key
        call dword ptr [g_textDataGetTextTrampoline]
        mov result, eax
    }
#else
    (void)thisPtr;
    (void)key;
#endif

    return result;
}

static const char *__cdecl TextDataGetTextBridge(void *thisPtr, const char *key) {
    const char *result = NULL;
    LONG callNo = InterlockedIncrement(&g_textDataGetTextCallCount);
    char keyPreview[256];
    char resultPreview[512];
    int hasKey;
    int hasResult;

    if (!g_textDataGetTextTrampoline) {
        return NULL;
    }

    __try {
        result = CallTextDataGetTextOriginal(thisPtr, key);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        if (callNo <= MAX_CAPTURED_TEXT_CALLS) {
            Log("[TextData:%ld] original getText raised an exception. this=0x%p key=0x%p\n",
                callNo, thisPtr, key);
            FlushLog();
        }

        return NULL;
    }

    if (callNo > MAX_CAPTURED_TEXT_CALLS) {
        return result;
    }

    hasKey = CopyCStringPreview(key, keyPreview, sizeof(keyPreview));
    hasResult = CopyCStringPreview(result, resultPreview, sizeof(resultPreview));

    Log("[TextData:%ld] getText this=0x%p key=%s result=%s\n",
        callNo,
        thisPtr,
        hasKey ? keyPreview : "<empty-or-unreadable>",
        hasResult ? resultPreview : "<empty-or-unreadable>");

    if (callNo == MAX_CAPTURED_TEXT_CALLS) {
        Log("[TextData] capture limit reached; further calls are ignored.\n");
    }

    FlushLog();
    return result;
}

static int InstallInlineHook(InlineHook *hook, void **trampolineSlot) {
    DWORD oldProtect;
    DWORD unusedProtect;
    BYTE patch[MAX_HOOK_PATCH_SIZE];
    BYTE *trampoline;
    DWORD patchSize;

    if (!hook || !hook->target || !hook->detour || !trampolineSlot) {
        return 0;
    }

    /* Resolve FF 25 indirect jump (Windows API export stubs in kernel32 etc.).
     * FF 25 [disp32] = jmp dword ptr [absolute_address]
     * Follow the pointer to find the real function entry. */
    if (hook->target[0] == 0xFF && hook->target[1] == 0x25) {
        DWORD *ptrAddr = (DWORD *)(hook->target + 2);
        BYTE *realTarget = *(BYTE **)(*ptrAddr);
        Log("Resolved indirect jump for %s: 0x%p -> 0x%p\n",
            hook->label, hook->target, realTarget);
        hook->target = realTarget;
    }

    Log("First bytes for %s: %02X %02X %02X %02X %02X %02X %02X %02X\n",
        hook->label,
        hook->target[0], hook->target[1], hook->target[2], hook->target[3],
        hook->target[4], hook->target[5], hook->target[6], hook->target[7]);

    patchSize = GetProloguePatchSize(hook->target);
    if ((patchSize < MIN_HOOK_PATCH_SIZE || patchSize > MAX_HOOK_PATCH_SIZE) &&
        hook->allowNonPrologue) {
        patchSize = GetSequentialPatchSize(hook->target);
        if (patchSize >= MIN_HOOK_PATCH_SIZE && patchSize <= MAX_HOOK_PATCH_SIZE) {
            Log("Using non-prologue sequential patch for %s, patchSize=%lu\n",
                hook->label, patchSize);
        }
    }

    if (patchSize < MIN_HOOK_PATCH_SIZE || patchSize > MAX_HOOK_PATCH_SIZE) {
        /* Dump reason for skip: show instruction boundaries */
        int off = 0;
        Log("Skipped hook %s: prologue patch size=%lu (need %d-%d). Raw bytes: ",
            hook->label, patchSize, MIN_HOOK_PATCH_SIZE, MAX_HOOK_PATCH_SIZE);
        while (off < 16) {
            int ilen = GetX86InstructionLength(hook->target + off);
            if (ilen <= 0) {
                Log("%02X[?] ", hook->target[off] & 0xFF);
                off++;
            } else {
                for (int j = 0; j < ilen; j++) {
                    Log("%02X", hook->target[off + j] & 0xFF);
                }
                Log("[%d] ", ilen);
                off += ilen;
            }
        }
        Log("\n");
        return 0;
    }

    memcpy(hook->original, hook->target, patchSize);

    trampoline = (BYTE *)VirtualAlloc(NULL, patchSize + 5,
                                      MEM_COMMIT | MEM_RESERVE,
                                      PAGE_EXECUTE_READWRITE);
    if (!trampoline) {
        Log("Failed to allocate trampoline for %s: %lu\n", hook->label, GetLastError());
        return 0;
    }

    memcpy(trampoline, hook->original, patchSize);
    trampoline[patchSize] = 0xE9;
    *(DWORD *)(trampoline + patchSize + 1) =
        (DWORD)((BYTE *)hook->target + patchSize - (trampoline + patchSize + 5));

    memset(patch, 0x90, sizeof(patch));
    if (hook->callBased) {
        /* CALL-based detour: target -> CALL detour.
           Detour does pre-work, CALLs trampoline, does post-work, RETs.
           Trampoline: original bytes + JMP target+patchSize.
           When original function returns, it returns to detour (after CALL trampoline). */
        patch[0] = 0xE8;
        *(DWORD *)(patch + 1) = (DWORD)((BYTE *)hook->detour - hook->target - 5);
        Log("Using CALL-based patch for %s\n", hook->label);
    } else {
        patch[0] = 0xE9;
        *(DWORD *)(patch + 1) = (DWORD)((BYTE *)hook->detour - hook->target - 5);
    }

    if (!VirtualProtect(hook->target, patchSize, PAGE_EXECUTE_READWRITE, &oldProtect)) {
        Log("VirtualProtect failed for %s: %lu\n", hook->label, GetLastError());
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return 0;
    }

    memcpy(hook->target, patch, patchSize);
    FlushInstructionCache(GetCurrentProcess(), hook->target, patchSize);
    VirtualProtect(hook->target, patchSize, oldProtect, &unusedProtect);

    hook->trampoline = trampoline;
    hook->patchSize = patchSize;
    hook->installed = 1;
    *trampolineSlot = trampoline;

    Log("Installed hook %s target=0x%p trampoline=0x%p patchSize=%lu\n",
        hook->label, hook->target, trampoline, patchSize);
    return 1;
}

static void InstallHooksForModule(HMODULE moduleHandle, const char *moduleLabel,
                                  InlineHook *hooks, void ***trampolineSlots, int count) {
    if (!moduleHandle) {
        Log("Module %s is not loaded; hooks were not installed.\n", moduleLabel);
        return;
    }

    for (int i = 0; i < count; i++) {
        hooks[i].target = (BYTE *)GetProcAddress(moduleHandle, hooks[i].exportName);

        if (!hooks[i].target) {
            Log("Export not found for %s in %s\n", hooks[i].label, moduleLabel);
            continue;
        }

        Log("Resolved export %s in %s at 0x%p\n", hooks[i].label, moduleLabel, hooks[i].target);
        InstallInlineHook(&hooks[i], trampolineSlots[i]);
    }
}

static int InstallIatHookForModule(HMODULE moduleHandle, const char *moduleLabel,
                                   const char *functionName, void *detour,
                                   void **originalSlot) {
    BYTE *moduleBase = (BYTE *)moduleHandle;
    PIMAGE_DOS_HEADER dos;
    PIMAGE_NT_HEADERS nt;
    PIMAGE_IMPORT_DESCRIPTOR importDesc;
    DWORD importRva;
    int installed = 0;

    if (!moduleHandle || !functionName || !detour || !originalSlot) {
        return 0;
    }

    __try {
        dos = (PIMAGE_DOS_HEADER)moduleBase;
        if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
            Log("IAT hook skipped for %s: invalid DOS header.\n", moduleLabel);
            return 0;
        }

        nt = (PIMAGE_NT_HEADERS)(moduleBase + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE) {
            Log("IAT hook skipped for %s: invalid NT header.\n", moduleLabel);
            return 0;
        }

        importRva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
        if (!importRva) {
            Log("IAT hook skipped for %s: no import table.\n", moduleLabel);
            return 0;
        }

        importDesc = (PIMAGE_IMPORT_DESCRIPTOR)(moduleBase + importRva);
        for (; importDesc->Name; importDesc++) {
            const char *dllName = (const char *)(moduleBase + importDesc->Name);
            PIMAGE_THUNK_DATA nameThunk;
            PIMAGE_THUNK_DATA iatThunk;

            if (!importDesc->OriginalFirstThunk) {
                Log("IAT hook skipped import descriptor in %s: no OriginalFirstThunk.\n",
                    moduleLabel);
                continue;
            }

            nameThunk = (PIMAGE_THUNK_DATA)(moduleBase + importDesc->OriginalFirstThunk);
            iatThunk = (PIMAGE_THUNK_DATA)(moduleBase + importDesc->FirstThunk);

            for (; nameThunk->u1.AddressOfData; nameThunk++, iatThunk++) {
                PIMAGE_IMPORT_BY_NAME importByName;
                const char *name;
                DWORD oldProtect;
                DWORD unusedProtect;
                void *original;

                if (nameThunk->u1.Ordinal & IMAGE_ORDINAL_FLAG) {
                    continue;
                }

                importByName = (PIMAGE_IMPORT_BY_NAME)(moduleBase + nameThunk->u1.AddressOfData);
                name = (const char *)importByName->Name;
                if (lstrcmpA(name, functionName) != 0) {
                    continue;
                }

                original = (void *)iatThunk->u1.Function;
                if (!original || original == detour) {
                    continue;
                }

                if (!*originalSlot) {
                    *originalSlot = original;
                } else if (*originalSlot != original) {
                    Log("IAT hook warning for %s!%s: original differs (kept 0x%p, new 0x%p).\n",
                        moduleLabel, functionName, *originalSlot, original);
                }

                if (!VirtualProtect(&iatThunk->u1.Function, sizeof(iatThunk->u1.Function),
                                    PAGE_READWRITE, &oldProtect)) {
                    Log("IAT hook VirtualProtect failed for %s!%s: %lu\n",
                        moduleLabel, functionName, GetLastError());
                    continue;
                }

                iatThunk->u1.Function = (DWORD_PTR)detour;
                VirtualProtect(&iatThunk->u1.Function, sizeof(iatThunk->u1.Function),
                               oldProtect, &unusedProtect);
                FlushInstructionCache(GetCurrentProcess(), &iatThunk->u1.Function,
                                      sizeof(iatThunk->u1.Function));

                Log("Installed IAT hook %s!%s imported from %s original=0x%p detour=0x%p\n",
                    moduleLabel, functionName, dllName, original, detour);
                installed++;
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        Log("IAT hook scan raised an exception for %s!%s.\n", moduleLabel, functionName);
        return installed;
    }

    if (!installed) {
        Log("IAT hook target not found: %s!%s\n", moduleLabel, functionName);
    }

    return installed;
}

static void InstallCrtIatHooks(HMODULE mainModule, HMODULE cocosModule) {
    int installed = 0;

    installed += InstallIatHookForModule(mainModule, "player.exe", "fopen",
                                         DetourCrtFopen, &g_crtFopenOriginal);
    installed += InstallIatHookForModule(mainModule, "player.exe", "fopen_s",
                                         DetourCrtFopenS, &g_crtFopenSOriginal);
    installed += InstallIatHookForModule(mainModule, "player.exe", "fread",
                                         DetourCrtFread, &g_crtFreadOriginal);

    installed += InstallIatHookForModule(cocosModule, "libcocos2d.dll", "fopen",
                                         DetourCrtFopen, &g_crtFopenOriginal);
    installed += InstallIatHookForModule(cocosModule, "libcocos2d.dll", "fopen_s",
                                         DetourCrtFopenS, &g_crtFopenSOriginal);
    installed += InstallIatHookForModule(cocosModule, "libcocos2d.dll", "fread",
                                         DetourCrtFread, &g_crtFreadOriginal);

    Log("CRT IAT hook summary: installed=%d fopenOriginal=0x%p fopen_sOriginal=0x%p freadOriginal=0x%p\n",
        installed, g_crtFopenOriginal, g_crtFopenSOriginal, g_crtFreadOriginal);
}

static void InstallExportHooks(void) {
    HMODULE mainModule = GetModuleHandleW(NULL);
    /* MINIMAL diagnostic: only 7 essential hooks to avoid overhead interference.
       Removed: Cocos2d, SpiderMonkey, SQLite, kernel32/CRT I/O, MessageUi,
       MessageFlow, ValueHook/ValueGet - these generated 25K+ calls/sec. */
    InlineHook mainHooks[] = {
        {
            "updateText-7",
            "?updateText@TextGui@agtk@@QAEXV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@HHMMHH@Z",
            DetourUpdateText7,
            NULL, NULL, {0}, 0, 0
        },
        {
            "updateText-8",
            "?updateText@TextGui@agtk@@QAEXV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@HHMMHHM@Z",
            DetourUpdateText8,
            NULL, NULL, {0}, 0, 0
        },
        {
            "updateTextRender-7",
            "?updateTextRender@TextGui@agtk@@QAEXV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@HHMMHH@Z",
            DetourUpdateTextRender7,
            NULL, NULL, {0}, 0, 0
        },
        {
            "updateTextRender-8",
            "?updateTextRender@TextGui@agtk@@QAEXV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@HHMMHHM@Z",
            DetourUpdateTextRender8,
            NULL, NULL, {0}, 0, 0
        },
        {
            "TextData::getText",
            "?getText@TextData@data@agtk@@QBEPBDXZ",
            DetourTextDataGetText,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ObjectAction::execActionMessageShow",
            "?execActionMessageShow@ObjectAction@agtk@@QAEXPAVObjectCommandData@data@2@@Z",
            DetourExecActionMessageShow,
            NULL, NULL, {0}, 0, 0
        },
        {
            "TextGui::getString",
            "?getString@TextGui@agtk@@UBE?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@XZ",
            DetourTextGuiGetString,
            NULL, NULL, {0}, 0, 0, 0, 0, 1
        }
    };
    void **mainTrampolineSlots[] = {
        &g_updateText7Trampoline,
        &g_updateText8Trampoline,
        &g_updateTextRender7Trampoline,
        &g_updateTextRender8Trampoline,
        &g_textDataGetTextTrampoline,
        &g_execActionMessageShowTrampoline,
        &g_textGuiGetStringTrampoline
    };

    InstallHooksForModule(mainModule, "player.exe", mainHooks, mainTrampolineSlots,
                          (int)(sizeof(mainHooks) / sizeof(mainHooks[0])));

    Log("Minimal diagnostic: 7 hooks installed. No Cocos2d/SpiderMonkey/SQLite/kernel32.\n");
    FlushLog();
}


#ifdef _M_IX86
static __declspec(naked) void DetourUpdateText7(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelUpdateText7
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_updateText7Trampoline]
    }
}

static __declspec(naked) void DetourUpdateText8(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelUpdateText8
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_updateText8Trampoline]
    }
}

static __declspec(naked) void DetourUpdateTextRender7(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelUpdateTextRender7
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_updateTextRender7Trampoline]
    }
}

static __declspec(naked) void DetourUpdateTextRender8(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelUpdateTextRender8
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_updateTextRender8Trampoline]
    }
}

static __declspec(naked) void DetourTextDataGetText(void) {
    __asm {
        push dword ptr [esp + 4]
        push ecx
        call TextDataGetTextBridge
        add esp, 8
        ret 4
    }
}

static __declspec(naked) void DetourFontManagerCreateOrSet(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelFontManagerCreateOrSet
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_fontManagerCreateOrSetTrampoline]
    }
}

static __declspec(naked) void DetourTextLineNodeCreate(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelTextLineNodeCreate
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_textLineNodeCreateTrampoline]
    }
}

static __declspec(naked) void DetourTextLineNodeInit(void) {
    __asm {
        pushfd
        pushad
        lea eax, [esp + 40]
        push eax
        push OFFSET g_labelTextLineNodeInit
        call LogTextCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_textLineNodeInitTrampoline]
    }
}

static __declspec(naked) void DetourTextureInitWithStringFontDef(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelTextureInitFontDef
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_textureInitWithStringFontDefTrampoline]
    }
}

static __declspec(naked) void DetourTextureInitWithStringFull(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelTextureInitFull
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_textureInitWithStringFullTrampoline]
    }
}

static __declspec(naked) void DetourLabelSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelLabelSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_labelSetStringTrampoline]
    }
}

static __declspec(naked) void DetourLabelBMFontSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelLabelBMFontSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_labelBMFontSetStringTrampoline]
    }
}

static __declspec(naked) void DetourLabelTTFSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelLabelTTFSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_labelTTFSetStringTrampoline]
    }
}

static __declspec(naked) void DetourLabelAtlasSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelLabelAtlasSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_labelAtlasSetStringTrampoline]
    }
}

static __declspec(naked) void DetourUiTextSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelUiTextSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_uiTextSetStringTrampoline]
    }
}

static __declspec(naked) void DetourUiTextSetText(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelUiTextSetText
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_uiTextSetTextTrampoline]
    }
}

static __declspec(naked) void DetourUiTextBMFontSetString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelUiTextBMFontSetString
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_uiTextBMFontSetStringTrampoline]
    }
}

static __declspec(naked) void DetourUiTextBMFontSetText(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
        push eax
        push OFFSET g_labelUiTextBMFontSetText
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_uiTextBMFontSetTextTrampoline]
    }
}

/*
 * getExpandedText returns std::string by value (hidden pointer in [esp+4]).
 * Uses CALL instead of JMP so we can capture the return value.
 */
static __declspec(naked) void DetourGetExpandedText(void) {
    __asm {
        pushfd
        pushad
        /* Log the template text (param at [esp+48]: string const&). */
        mov eax, [esp + 48]
        push eax
        push OFFSET g_labelGetExpandedText
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        /* Call original via trampoline. */
        call dword ptr [g_getExpandedTextTrampoline]
        /* eax = hidden return pointer to result std::string. Log it. */
        pushfd
        pushad
        push eax
        push OFFSET g_labelGetExpandedTextResult
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        ret
    }
}

/* execActionMessageShow: void ObjectAction::execActionMessageShow(ObjectCommandData*).
   thiscall: ecx=this, [esp+4]=ObjectCommandData*. Probe the struct instead of
   treating the ObjectCommandData pointer as a C string. */
static __declspec(naked) void DetourExecActionMessageShow(void) {
    __asm {
        pushfd
        pushad
        push dword ptr [esp + 40]  /* ObjectCommandData* */
        push ecx                   /* ObjectAction this */
        push OFFSET g_labelExecActionMessageShow
        call LogObjectCommandDataProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_execActionMessageShowTrampoline]
    }
}

/* execActionScrollMessageShow has the same first argument shape as messageShow. */
static __declspec(naked) void DetourExecActionScrollMessageShow(void) {
    __asm {
        pushfd
        pushad
        push dword ptr [esp + 40]  /* ObjectCommandData* */
        push ecx                   /* ObjectAction this */
        push OFFSET g_labelExecActionScrollMessageShow
        call LogObjectCommandDataProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_execActionScrollMessageShowTrampoline]
    }
}

/*
 * sqlite3_column_text: cdecl, returns const unsigned char*.
 * JMP-based: just logs that it was called with column index (no return value capture,
 * to avoid the stack complexity of CALL-based detours that may crash).
 */
static __declspec(naked) void DetourSqlite3ColumnText(void) {
    __asm {
        pushfd
        pushad
        push dword ptr [esp + 48]  /* iCol */
        push OFFSET g_labelSqlite3ColumnText
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3ColumnTextTrampoline]
    }
}

/* sqlite3_column_text16: same, JMP-based. */
static __declspec(naked) void DetourSqlite3ColumnText16(void) {
    __asm {
        pushfd
        pushad
        push dword ptr [esp + 48]  /* iCol */
        push OFFSET g_labelSqlite3ColumnText16
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3ColumnText16Trampoline]
    }
}

/* sqlite3_exec: cdecl, int sqlite3_exec(sqlite3*, const char *sql, ...).
   Log the SQL query text. */
static __declspec(naked) void DetourSqlite3Exec(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* SQL text (second cdecl param) */
        push eax
        push OFFSET g_labelSqlite3Exec
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3ExecTrampoline]
    }
}

/* sqlite3_prepare_v2: cdecl, int sqlite3_prepare_v2(sqlite3*, const char *sql, int, sqlite3_stmt**, const char **).
   Log the SQL text being compiled. */
static __declspec(naked) void DetourSqlite3PrepareV2(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* SQL text (second cdecl param) */
        push eax
        push OFFSET g_labelSqlite3PrepareV2
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3PrepareV2Trampoline]
    }
}

/* sqlite3_step: cdecl, int sqlite3_step(sqlite3_stmt*). Log that a row is being fetched. */
static __declspec(naked) void DetourSqlite3Step(void) {
    __asm {
        pushfd
        pushad
        push dword ptr [esp + 40]  /* stmt pointer */
        push OFFSET g_labelSqlite3Step
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3StepTrampoline]
    }
}

/* sqlite3_open: cdecl, int sqlite3_open(const char *filename, sqlite3**).
   Log the database filename. */
static __declspec(naked) void DetourSqlite3Open(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]  /* filename (first cdecl param) */
        push eax
        push OFFSET g_labelSqlite3Open
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_sqlite3OpenTrampoline]
    }
}

/*
 * TextGui::getString: thiscall, returns std::string by value (hidden ptr at [esp+4]).
 *
 * CALL-based detour: we CALL the trampoline (which runs the original function),
 * then read the now-initialized std::string from the hidden pointer AFTER the
 * original function returns.  JMP-based detours cannot do this because they never
 * regain control after the trampoline jumps to the original body.
 */
static void __cdecl LogGetStringResult(const char *label, const void *hiddenPtr) {
    char text[2048];
    DWORD size, capacity;
    LONG callNo;

    callNo = InterlockedIncrement(&g_getStringResultCount);
    if (callNo > MAX_CAPTURED_GETSTRING_RESULTS) {
        if (callNo == MAX_CAPTURED_GETSTRING_RESULTS + 1) {
            Log("[GetStringResult] capture limit reached; further calls are ignored.\n");
            FlushLog();
        }
        return;
    }

    if (ReadMsvcStdString(hiddenPtr, text, sizeof(text), &size, &capacity)) {
        Log("[GetStringResult:%ld] len=%lu cap=%lu text=%s\n",
            callNo, size, capacity, text[0] ? text : "(empty)");
    } else {
        Log("[GetStringResult:%ld] hidden=0x%p ReadMsvcStdString failed\n",
            callNo, hiddenPtr);
    }

    if (callNo <= 20 || callNo % 50 == 0) {
        FlushLog();
    }
}

static __declspec(naked) void DetourTextGuiGetString(void) {
    __asm {
        /* On entry via CALL-based detour:
           [esp+0] = return address to original caller
           [esp+4] = hidden_ptr (for return-by-value std::string)
           ecx     = this (unchanged, needed by original function) */
        push ebx
        push esi
        mov ebx, [esp + 12]     /* hidden_ptr (after 2 pushes) */

        /* Push hidden_ptr so it's at [esp+4] after the following call.
           The original function expects: [esp]=ret_addr, [esp+4]=hidden_ptr. */
        push ebx
        call dword ptr [g_textGuiGetStringTrampoline]
        /* Trampoline runs original bytes + JMP to original body.
           Original function constructs std::string at *hidden_ptr, returns here. */

        /* After original ret: [esp+0] = hidden_ptr (our push before call).
           ebx still holds hidden_ptr; the std::string there is now initialized. */
        push ebx
        push OFFSET g_labelTextGuiGetStringResult
        call LogGetStringResult
        add esp, 8

        add esp, 4              /* pop hidden_ptr (our push before call) */
        pop esi
        pop ebx
        /* Stack now: [esp+0]=ret_to_original_caller, [esp+4]=hidden_ptr.
           eax = hidden_ptr (return value from original function, preserved). */
        ret
    }
}

/* ActionCommandMessageTextUi::update(float): thiscall, ecx=this. */
static __declspec(naked) void DetourMessageTextUiUpdate(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]  /* float bits */
        push edx
        push eax
        push OFFSET g_labelMessageTextUiUpdate
        call LogMessageUiUpdateProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageTextUiUpdateTrampoline]
    }
}

/* ActionCommandScrollMessageTextUi::update(float): thiscall, ecx=this. */
static __declspec(naked) void DetourScrollMessageTextUiUpdate(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]  /* float bits */
        push edx
        push eax
        push OFFSET g_labelScrollMessageTextUiUpdate
        call LogMessageUiUpdateProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_scrollMessageTextUiUpdateTrampoline]
    }
}

/* ActionCommandMessageTextUi::setTextGui(TextGui*): thiscall, ecx=this. */
static __declspec(naked) void DetourMessageTextUiSetTextGui(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]  /* TextGui* */
        push edx
        push eax
        push OFFSET g_labelMessageTextUiSetTextGui
        call LogMessageUiTextGuiProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageTextUiSetTextGuiTrampoline]
    }
}

/* ActionCommandScrollMessageTextUi::setTextGui(TextGui*): thiscall, ecx=this. */
static __declspec(naked) void DetourScrollMessageTextUiSetTextGui(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]  /* TextGui* */
        push edx
        push eax
        push OFFSET g_labelScrollMessageTextUiSetTextGui
        call LogMessageUiTextGuiProbe
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_scrollMessageTextUiSetTextGuiTrampoline]
    }
}

/* GuiManager::addActionCommandMessageGui(Object*, Object*, MessageData*). */
static __declspec(naked) void DetourGuiAddActionCommandMessageGui3(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* message data */
        push edx
        push ebx
        push eax
        push ecx                   /* GuiManager this */
        push OFFSET g_labelGuiAddActionCommandMessageGui3
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_guiAddActionCommandMessageGui3Trampoline]
    }
}

/* GuiManager::addActionCommandMessageGui(Object*, MessageData*). */
static __declspec(naked) void DetourGuiAddActionCommandMessageGui2(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov edx, [esp + 44]        /* message data */
        xor ebx, ebx
        push edx
        push ebx                   /* no lock object in this overload */
        push eax
        push ecx                   /* GuiManager this */
        push OFFSET g_labelGuiAddActionCommandMessageGui2
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_guiAddActionCommandMessageGui2Trampoline]
    }
}

/* GuiManager::addActionCommandScrollMessageGui(Object*, Object*, ScrollMessageData*). */
static __declspec(naked) void DetourGuiAddActionCommandScrollMessageGui3(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* scroll message data */
        push edx
        push ebx
        push eax
        push ecx                   /* GuiManager this */
        push OFFSET g_labelGuiAddActionCommandScrollMessageGui3
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_guiAddActionCommandScrollMessageGui3Trampoline]
    }
}

/* GuiManager::addActionCommandScrollMessageGui(Object*, ScrollMessageData*). */
static __declspec(naked) void DetourGuiAddActionCommandScrollMessageGui2(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov edx, [esp + 44]        /* scroll message data */
        xor ebx, ebx
        push edx
        push ebx                   /* no lock object in this overload */
        push eax
        push ecx                   /* GuiManager this */
        push OFFSET g_labelGuiAddActionCommandScrollMessageGui2
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_guiAddActionCommandScrollMessageGui2Trampoline]
    }
}

/* ActionCommandMessageTextUi::create(Object*, Object*, MessageData*): static factory. */
static __declspec(naked) void DetourMessageTextUiCreate(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* message data */
        push edx
        push ebx
        push eax
        xor eax, eax
        push eax                   /* no this pointer for static create */
        push OFFSET g_labelMessageTextUiCreate
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageTextUiCreateTrampoline]
    }
}

/* ActionCommandScrollMessageTextUi::create(Object*, Object*, ScrollMessageData*). */
static __declspec(naked) void DetourScrollMessageTextUiCreate(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* scroll message data */
        push edx
        push ebx
        push eax
        xor eax, eax
        push eax                   /* no this pointer for static create */
        push OFFSET g_labelScrollMessageTextUiCreate
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_scrollMessageTextUiCreateTrampoline]
    }
}

/* ActionCommandMessageTextUi::init(Object*, Object*, MessageData*). */
static __declspec(naked) void DetourMessageTextUiInit(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* message data */
        push edx
        push ebx
        push eax
        push ecx                   /* MessageTextUi this */
        push OFFSET g_labelMessageTextUiInit
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageTextUiInitTrampoline]
    }
}

/* ActionCommandScrollMessageTextUi::init(Object*, Object*, ScrollMessageData*). */
static __declspec(naked) void DetourScrollMessageTextUiInit(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* owner object */
        mov ebx, [esp + 44]        /* lock object */
        mov edx, [esp + 48]        /* scroll message data */
        push edx
        push ebx
        push eax
        push ecx                   /* ScrollMessageTextUi this */
        push OFFSET g_labelScrollMessageTextUiInit
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_scrollMessageTextUiInitTrampoline]
    }
}

/* ActionCommandMessageTextUi::setData(MessageData*). */
static __declspec(naked) void DetourMessageTextUiSetData(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push ecx
        push OFFSET g_labelMessageTextUiSetData
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageTextUiSetDataTrampoline]
    }
}

/* ActionCommandScrollMessageTextUi::setData(ScrollMessageData*). */
static __declspec(naked) void DetourScrollMessageTextUiSetData(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* scroll message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push ecx
        push OFFSET g_labelScrollMessageTextUiSetData
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_scrollMessageTextUiSetDataTrampoline]
    }
}

/* ActionCommandMessageTextUi::getData(): call original, then log the returned data pointer. */
static __declspec(naked) void DetourMessageTextUiGetData(void) {
    __asm {
        push ecx                   /* save this before the original call */
        call dword ptr [g_messageTextUiGetDataTrampoline]
        pop edx                    /* edx = original this */
        pushfd
        pushad
        push eax                   /* returned message data */
        xor ebx, ebx
        push ebx
        push eax                   /* repeat data as arg1 for readability */
        push edx
        push OFFSET g_labelMessageTextUiGetData
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        ret
    }
}

/* ActionCommandScrollMessageTextUi::getData(): call original, then log returned data. */
static __declspec(naked) void DetourScrollMessageTextUiGetData(void) {
    __asm {
        push ecx                   /* save this before the original call */
        call dword ptr [g_scrollMessageTextUiGetDataTrampoline]
        pop edx                    /* edx = original this */
        pushfd
        pushad
        push eax                   /* returned scroll message data */
        xor ebx, ebx
        push ebx
        push eax                   /* repeat data as arg1 for readability */
        push edx
        push OFFSET g_labelScrollMessageTextUiGetData
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        ret
    }
}

/* MessageWindowNode::create(MessageData*): static factory, first arg at [esp+4]. */
static __declspec(naked) void DetourMessageWindowNodeCreateMessage(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push edx                   /* no this pointer for static create */
        push OFFSET g_labelMessageWindowNodeCreateMessage
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageWindowNodeCreateMessageTrampoline]
    }
}

/* MessageWindowNode::create(ScrollMessageData*): static factory. */
static __declspec(naked) void DetourMessageWindowNodeCreateScroll(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* scroll message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push edx                   /* no this pointer for static create */
        push OFFSET g_labelMessageWindowNodeCreateScroll
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageWindowNodeCreateScrollTrampoline]
    }
}

/* MessageWindowNode::init(MessageData*): thiscall, ecx=this. */
static __declspec(naked) void DetourMessageWindowNodeInitMessage(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push ecx                   /* MessageWindowNode this */
        push OFFSET g_labelMessageWindowNodeInitMessage
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageWindowNodeInitMessageTrampoline]
    }
}

/* MessageWindowNode::init(ScrollMessageData*): thiscall, ecx=this. */
static __declspec(naked) void DetourMessageWindowNodeInitScroll(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]        /* scroll message data */
        xor edx, edx
        push eax
        push edx
        push eax                   /* repeat data as arg1 for readability */
        push ecx                   /* MessageWindowNode this */
        push OFFSET g_labelMessageWindowNodeInitScroll
        call LogMessageFlowProbe
        add esp, 20
        popad
        popfd
        jmp dword ptr [g_messageWindowNodeInitScrollTrampoline]
    }
}

/* ObjectCommandMessageShowData getters: call original, then log returned integer. */
static __declspec(naked) void DetourMessageShowGetTextFlag(void) {
    __asm {
        push ecx
        call dword ptr [g_messageShowGetTextFlagTrampoline]
        pop edx
        and eax, 0FFh
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelMessageShowGetTextFlag
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

static __declspec(naked) void DetourMessageShowGetTextId(void) {
    __asm {
        push ecx
        call dword ptr [g_messageShowGetTextIdTrampoline]
        pop edx
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelMessageShowGetTextId
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

static __declspec(naked) void DetourMessageShowGetVariableId(void) {
    __asm {
        push ecx
        call dword ptr [g_messageShowGetVariableIdTrampoline]
        pop edx
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelMessageShowGetVariableId
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

static __declspec(naked) void DetourMessageShowGetVariableObjectId(void) {
    __asm {
        push ecx
        call dword ptr [g_messageShowGetVariableObjectIdTrampoline]
        pop edx
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelMessageShowGetVariableObjectId
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

static __declspec(naked) void DetourMessageShowGetVariableQualifierId(void) {
    __asm {
        push ecx
        call dword ptr [g_messageShowGetVariableQualifierIdTrampoline]
        pop edx
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelMessageShowGetVariableQualifierId
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

static __declspec(naked) void DetourScrollMessageShowGetTextId(void) {
    __asm {
        push ecx
        call dword ptr [g_scrollMessageShowGetTextIdTrampoline]
        pop edx
        pushfd
        pushad
        push eax
        push edx
        push OFFSET g_labelScrollMessageShowGetTextId
        call LogValueGetCall
        add esp, 12
        popad
        popfd
        ret
    }
}

/* ObjectCommandMessageShowData setters: thiscall, ecx=this, first arg at [esp+4]. */
static __declspec(naked) void DetourMessageShowSetTextId(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        push edx
        push eax
        push OFFSET g_labelMessageShowSetTextId
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageShowSetTextIdTrampoline]
    }
}

static __declspec(naked) void DetourMessageShowSetTextFlag(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        and edx, 0FFh
        push edx
        push eax
        push OFFSET g_labelMessageShowSetTextFlag
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageShowSetTextFlagTrampoline]
    }
}

static __declspec(naked) void DetourMessageShowSetVariableId(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        push edx
        push eax
        push OFFSET g_labelMessageShowSetVariableId
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageShowSetVariableIdTrampoline]
    }
}

static __declspec(naked) void DetourMessageShowSetVariableObjectId(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        push edx
        push eax
        push OFFSET g_labelMessageShowSetVariableObjectId
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageShowSetVariableObjectIdTrampoline]
    }
}

static __declspec(naked) void DetourMessageShowSetVariableQualifierId(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        push edx
        push eax
        push OFFSET g_labelMessageShowSetVariableQualifierId
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_messageShowSetVariableQualifierIdTrampoline]
    }
}

static __declspec(naked) void DetourScrollMessageShowSetTextId(void) {
    __asm {
        pushfd
        pushad
        mov eax, ecx
        mov edx, [esp + 40]
        push edx
        push eax
        push OFFSET g_labelScrollMessageShowSetTextId
        call LogValueHookCall
        add esp, 12
        popad
        popfd
        jmp dword ptr [g_scrollMessageShowSetTextIdTrampoline]
    }
}

/* SpiderMonkey: JS_NewStringCopyN(JSContext*, const char*, unsigned int). */
static __declspec(naked) void DetourJsNewStringCopyN(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* text */
        mov edx, [esp + 48]  /* length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsNewStringCopyN
        call LogJsCStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsNewStringCopyNTrampoline]
    }
}

/* SpiderMonkey: JS_NewStringCopyZ(JSContext*, const char*). */
static __declspec(naked) void DetourJsNewStringCopyZ(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* text */
        push 0
        push 0
        push eax
        push OFFSET g_labelJsNewStringCopyZ
        call LogJsCStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsNewStringCopyZTrampoline]
    }
}

/* SpiderMonkey: JS_NewUCStringCopyN(JSContext*, const wchar_t*, unsigned int). */
static __declspec(naked) void DetourJsNewUCStringCopyN(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide text */
        mov edx, [esp + 48]  /* wide length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsNewUCStringCopyN
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsNewUCStringCopyNTrampoline]
    }
}

/* SpiderMonkey: JS_NewUCStringCopyZ(JSContext*, const wchar_t*). */
static __declspec(naked) void DetourJsNewUCStringCopyZ(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide text */
        push 0
        push 0
        push eax
        push OFFSET g_labelJsNewUCStringCopyZ
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsNewUCStringCopyZTrampoline]
    }
}

/* SpiderMonkey: JS_NewUCString(JSContext*, wchar_t*, unsigned int). */
static __declspec(naked) void DetourJsNewUCString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide text */
        mov edx, [esp + 48]  /* wide length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsNewUCString
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsNewUCStringTrampoline]
    }
}

/* SpiderMonkey: JS_InternString(JSContext*, const char*). */
static __declspec(naked) void DetourJsInternString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* text */
        push 0
        push 0
        push eax
        push OFFSET g_labelJsInternString
        call LogJsCStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsInternStringTrampoline]
    }
}

/* SpiderMonkey: JS_InternStringN(JSContext*, const char*, unsigned int). */
static __declspec(naked) void DetourJsInternStringN(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* text */
        mov edx, [esp + 48]  /* length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsInternStringN
        call LogJsCStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsInternStringNTrampoline]
    }
}

/* SpiderMonkey: JS_InternUCString(JSContext*, const wchar_t*). */
static __declspec(naked) void DetourJsInternUCString(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide text */
        push 0
        push 0
        push eax
        push OFFSET g_labelJsInternUCString
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsInternUCStringTrampoline]
    }
}

/* SpiderMonkey: JS_InternUCStringN(JSContext*, const wchar_t*, unsigned int). */
static __declspec(naked) void DetourJsInternUCStringN(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide text */
        mov edx, [esp + 48]  /* wide length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsInternUCStringN
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsInternUCStringNTrampoline]
    }
}

/* SpiderMonkey: JS_ParseJSON(JSContext*, const wchar_t*, unsigned int, MutableHandle<Value>). */
static __declspec(naked) void DetourJsParseJsonRaw(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* wide JSON text */
        mov edx, [esp + 48]  /* wide length */
        push 1
        push edx
        push eax
        push OFFSET g_labelJsParseJsonRaw
        call LogJsWideStringCall
        add esp, 16
        popad
        popfd
        jmp dword ptr [g_jsParseJsonRawTrampoline]
    }
}

/* CRT stdio hooks are reached through patched import table entries. */
static __declspec(naked) void DetourCrtFopen(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]  /* filename */
        mov edx, [esp + 44]  /* mode */
        push edx
        push eax
        push OFFSET g_labelCrtFopen
        call LogCrtFileOpenA
        add esp, 12
        popad
        popfd
        cmp dword ptr [g_crtFopenOriginal], 0
        jne call_original
        xor eax, eax
        ret
    call_original:
        jmp dword ptr [g_crtFopenOriginal]
    }
}

static __declspec(naked) void DetourCrtFopenS(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* filename */
        mov edx, [esp + 48]  /* mode */
        push edx
        push eax
        push OFFSET g_labelCrtFopenS
        call LogCrtFileOpenA
        add esp, 12
        popad
        popfd
        cmp dword ptr [g_crtFopenSOriginal], 0
        jne call_original
        mov eax, 22  /* EINVAL */
        ret
    call_original:
        jmp dword ptr [g_crtFopenSOriginal]
    }
}

static __declspec(naked) void DetourCrtFread(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 44]  /* size */
        mov edx, [esp + 48]  /* count */
        mov ebx, [esp + 52]  /* stream */
        push ebx
        push edx
        push eax
        push OFFSET g_labelCrtFread
        call LogCrtReadCall
        add esp, 16
        popad
        popfd
        cmp dword ptr [g_crtFreadOriginal], 0
        jne call_original
        xor eax, eax
        ret
    call_original:
        jmp dword ptr [g_crtFreadOriginal]
    }
}

/*
 * CreateFileW: __stdcall, first param is LPCWSTR filename at [esp+4].
 * Log all wide-char file opens to catch dialogue data files not read through Cocos2d.
 * Uses a re-entrancy guard because FlushLog() calls CreateFileW internally.
 */
static __declspec(naked) void DetourCreateFileW(void) {
    __asm {
        cmp dword ptr [g_inFileHook], 0
        jne skip_log
        mov dword ptr [g_inFileHook], 1
        pushfd
        pushad
        mov eax, [esp + 40]  /* lpFileName (first __stdcall param) */
        push eax
        call LogFileOpenW
        add esp, 4
        popad
        popfd
        mov dword ptr [g_inFileHook], 0
    skip_log:
        jmp dword ptr [g_createFileWTrampoline]
    }
}

/*
 * CreateFileA: __stdcall, first param is LPCSTR filename at [esp+4].
 */
static __declspec(naked) void DetourCreateFileA(void) {
    __asm {
        cmp dword ptr [g_inFileHook], 0
        jne skip_log
        mov dword ptr [g_inFileHook], 1
        pushfd
        pushad
        mov eax, [esp + 40]  /* lpFileName (first __stdcall param) */
        push eax
        call LogFileOpenA
        add esp, 4
        popad
        popfd
        mov dword ptr [g_inFileHook], 0
    skip_log:
        jmp dword ptr [g_createFileATrampoline]
    }
}
#endif

/* Heartbeat: periodically log that the DLL is alive and how many calls captured. */
static DWORD WINAPI HeartbeatThread(LPVOID parameter) {
    (void)parameter;
    int tick = 0;

    for (;;) {
        Sleep(10000);
        tick++;
        Log("[Heartbeat:%d] DLL alive, TextHook=%ld CString/StringHook=%ld TextData=%ld Sqlite3=%ld FileIO=%ld JSString=%ld/%ld ObjectProbe=%ld GetString=%ld MessageUi=%ld LinkLog=%ld UpdateLog=%ld/%ld MessageFlow=%ld/%ld Data=%ld Other=%ld ValueHook=%ld ValueGet=%ld CRTFile=%ld CRTRead=%ld\n",
            tick * 10,
            (LONG)g_textCallCount,
            (LONG)g_cStringCallCount,
            (LONG)g_textDataGetTextCallCount,
            (LONG)g_sqliteCallCount,
            (LONG)g_fileHookCallCount,
            (LONG)g_jsStringLoggedCount,
            (LONG)g_jsStringCallCount,
            (LONG)g_objectCommandProbeCallCount,
            (LONG)g_getStringResultCount,
            (LONG)g_messageUiProbeCallCount,
            (LONG)g_messageUiSetTextGuiLoggedCount,
            (LONG)g_messageUiUpdateLoggedCount,
            (LONG)g_messageUiUpdateSeenCount,
            (LONG)g_messageFlowProbeCallCount,
            (LONG)g_messageFlowLoggedCount,
            (LONG)g_messageFlowConfirmedDataCount,
            (LONG)g_messageFlowOtherLoggedCount,
            (LONG)g_valueHookCallCount,
            (LONG)g_valueGetCallCount,
            (LONG)g_crtFileCallCount,
            (LONG)g_crtReadCallCount);
        FlushLog();
    }
    return 0;
}

/* Initialize module info. */
static void InitModuleInfo(void) {
    g_mainModule = GetModuleHandleW(NULL);
    if (!g_mainModule) { Log("GetModuleHandleW(NULL) failed\n"); return; }

    PIMAGE_DOS_HEADER dos = (PIMAGE_DOS_HEADER)g_mainModule;
    PIMAGE_NT_HEADERS nt = (PIMAGE_NT_HEADERS)((BYTE*)g_mainModule + dos->e_lfanew);
    g_moduleBase = (BYTE*)g_mainModule;
    g_moduleSize = nt->OptionalHeader.SizeOfImage;

    Log("Module base: 0x%p, size: 0x%X\n", g_moduleBase, g_moduleSize);
    Log("ImageBase in PE: 0x%X\n", nt->OptionalHeader.ImageBase);
#ifdef _M_IX86
    Log("DLL architecture: x86\n");
#elif defined(_M_X64)
    Log("DLL architecture: x64\n");
#else
    Log("DLL architecture: unknown\n");
#endif
}

static void ResolveMessageDataVtables(void) {
    if (!g_mainModule) {
        return;
    }

    /*
     * UI setData is noisy: many unrelated objects pass through similar setters.
     * Matching the exact exported vtable lets the log focus on real AGTK message data.
     */
    g_messageShowDataVtable =
        (void *)GetProcAddress(g_mainModule, "??_7ObjectCommandMessageShowData@data@agtk@@6B@");
    g_scrollMessageShowDataVtable =
        (void *)GetProcAddress(g_mainModule, "??_7ObjectCommandScrollMessageShowData@data@agtk@@6B@");

    Log("Resolved message data vtables: message=0x%p scroll=0x%p\n",
        g_messageShowDataVtable, g_scrollMessageShowDataVtable);
}

/* Search for a string in module memory. Returns runtime address or NULL. */
static BYTE *SearchString(const char *str) {
    size_t len = strlen(str);
    BYTE *end = g_moduleBase + g_moduleSize - len;
    for (BYTE *p = g_moduleBase; p < end; p++) {
        if (memcmp(p, str, len) == 0) {
            return p;
        }
    }
    return NULL;
}

/* Scan for RTTI vtable names and dump info. */
static void ScanRTTI(void) {
    if (!g_moduleBase) return;

    /* Search for the TextGui vtable symbol string. */
    const char *vtableNames[] = {
        ".?AVTextGui@agtk@@",
        "??_7TextGui@agtk@@6B@",
        "TextGui@agtk@@",
        NULL
    };

    for (int i = 0; vtableNames[i]; i++) {
        BYTE *found = SearchString(vtableNames[i]);
        if (found) {
            DWORD_PTR offset = (DWORD_PTR)(found - g_moduleBase);
            Log("Found '%s' at runtime 0x%p (offset 0x%X)\n",
                vtableNames[i], found, (DWORD)offset);

            /* Dump surrounding bytes for analysis. */
            Log("  Bytes at -16: ");
            int start = offset >= 16 ? -16 : 0;
            for (int j = start; j < 64 && found + j < g_moduleBase + g_moduleSize; j++) {
                if (j % 16 == 0) Log("\n    ");
                Log("%02X ", found[j] & 0xFF);
            }
            Log("\n");
        } else {
            Log("NOT FOUND: '%s'\n", vtableNames[i]);
        }
    }

    /* Search for updateText mangled name. */
    const char *funcNames[] = {
        "updateText@TextGui@agtk@@",
        "?updateText@TextGui@agtk@@",
        NULL
    };
    for (int i = 0; funcNames[i]; i++) {
        BYTE *found = SearchString(funcNames[i]);
        if (found) {
            Log("Found '%s' at 0x%p (offset 0x%X)\n",
                funcNames[i], found, (DWORD)(found - g_moduleBase));
        } else {
            Log("NOT FOUND: '%s'\n", funcNames[i]);
        }
    }
}

/* ---- DLL Entry Point ---- */

static DWORD WINAPI DiagnosticThread(LPVOID parameter) {
    HINSTANCE hinstDLL = (HINSTANCE)parameter;

    InitLogPath();

    Log("=== OpenGameTranslator Hook DLL Diagnostic ===\n");
    Log("Process ID: %lu\n", GetCurrentProcessId());
    Log("DLL loaded at: 0x%p\n", hinstDLL);
    Log("This diagnostic build captures AGTK/Cocos text calls; it does not modify game text.\n");

    InitModuleInfo();
    ResolveMessageDataVtables();
    ScanRTTI();
    InstallExportHooks();

    /* Start heartbeat. */
    HANDLE hb = CreateThread(NULL, 0, HeartbeatThread, NULL, 0, NULL);
    if (hb) CloseHandle(hb);

    FlushLog();
    Log("[Init] Hook installation complete. Waiting for text calls...\n");
    FlushLog();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    if (fdwReason == DLL_PROCESS_ATTACH) {
        HANDLE threadHandle;

        DisableThreadLibraryCalls(hinstDLL);

        /* Keep DllMain small; the diagnostic work runs after the loader lock is released. */
        threadHandle = CreateThread(NULL, 0, DiagnosticThread, hinstDLL, 0, NULL);
        if (threadHandle) {
            CloseHandle(threadHandle);
        }
    }

    return TRUE;
}
