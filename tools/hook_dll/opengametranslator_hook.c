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
static char g_logBuf[65536];
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
static void *g_sqlite3ColumnTextTrampoline = NULL;
static void *g_sqlite3ColumnText16Trampoline = NULL;
static void *g_sqlite3ExecTrampoline = NULL;
static void *g_sqlite3PrepareV2Trampoline = NULL;
static void *g_sqlite3StepTrampoline = NULL;
static void *g_sqlite3OpenTrampoline = NULL;
static void *g_textGuiGetStringTrampoline = NULL;
static LONG g_textDataGetTextCallCount = 0;
static LONG g_cStringCallCount = 0;
static LONG g_sqliteCallCount = 0;

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
static const char g_labelSqlite3ColumnText[] = "sqlite3_column_text";
static const char g_labelSqlite3ColumnTextResult[] = "sqlite3_column_text-result";
static const char g_labelSqlite3ColumnText16[] = "sqlite3_column_text16";
static const char g_labelSqlite3Exec[] = "sqlite3_exec";
static const char g_labelSqlite3PrepareV2[] = "sqlite3_prepare_v2";
static const char g_labelSqlite3Step[] = "sqlite3_step";
static const char g_labelSqlite3Open[] = "sqlite3_open";
static const char g_labelTextGuiGetString[] = "TextGui::getString";
static const char g_labelTextGuiGetStringResult[] = "TextGui::getString-result";

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
static void DetourSqlite3ColumnText(void);
static void DetourSqlite3ColumnText16(void);
static void DetourSqlite3Exec(void);
static void DetourSqlite3PrepareV2(void);
static void DetourSqlite3Step(void);
static void DetourSqlite3Open(void);
static void DetourTextGuiGetString(void);

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

        if (size == 0 || size > 2048 || capacity < size || capacity > 1024 * 1024) {
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
    /* All MSVC x86 prologues start with: push ebp; mov ebp, esp */
    if (target[0] != 0x55 || target[1] != 0x8B || target[2] != 0xEC) {
        return 0;
    }

    int offset = 3;  /* After push ebp; mov ebp, esp */

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

    Log("First bytes for %s: %02X %02X %02X %02X %02X %02X %02X %02X\n",
        hook->label,
        hook->target[0], hook->target[1], hook->target[2], hook->target[3],
        hook->target[4], hook->target[5], hook->target[6], hook->target[7]);

    patchSize = GetProloguePatchSize(hook->target);

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
    patch[0] = 0xE9;
    *(DWORD *)(patch + 1) = (DWORD)((BYTE *)hook->detour - hook->target - 5);

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

static void InstallExportHooks(void) {
    HMODULE mainModule = GetModuleHandleW(NULL);
    HMODULE cocosModule = GetModuleHandleA("libcocos2d.dll");
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
            "?getText@TextData@data@agtk@@QAEPBDPBD@Z",
            DetourTextDataGetText,
            NULL, NULL, {0}, 0, 0
        },
        {
            "FontManager::createOrSetWithFontData",
            "?createOrSetWithFontData@FontManager@@QAEPAVLabel@cocos2d@@ABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@PAVFontData@data@agtk@@HHPAV23@@Z",
            DetourFontManagerCreateOrSet,
            NULL, NULL, {0}, 0, 0
        },
        {
            "TextLineNode::create",
            "?create@TextLineNode@agtk@@SAPAV12@V?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@PAVFontData@data@2@HHABUColor3B@cocos2d@@PAHPAU78@@Z",
            DetourTextLineNodeCreate,
            NULL, NULL, {0}, 0, 0
        },
        {
            "TextLineNode::init",
            "?init@TextLineNode@agtk@@UAE_NV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@PAVFontData@data@2@HHABUColor3B@cocos2d@@PAHPAU78@@Z",
            DetourTextLineNodeInit,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ProjectData::getExpandedText",
            "?getExpandedText@ProjectData@data@agtk@@QAE?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@PBDABV45@AAV?$list@HV?$allocator@H@std@@@5@@Z",
            DetourGetExpandedText,
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
            NULL, NULL, {0}, 0, 0
        }
    };
    void **mainTrampolineSlots[] = {
        &g_updateText7Trampoline,
        &g_updateText8Trampoline,
        &g_updateTextRender7Trampoline,
        &g_updateTextRender8Trampoline,
        &g_textDataGetTextTrampoline,
        &g_fontManagerCreateOrSetTrampoline,
        &g_textLineNodeCreateTrampoline,
        &g_textLineNodeInitTrampoline,
        &g_getExpandedTextTrampoline,
        &g_execActionMessageShowTrampoline,
        &g_textGuiGetStringTrampoline
    };
    InlineHook cocosHooks[] = {
        {
            "Texture2D::initWithString-fontDef",
            "?initWithString@Texture2D@cocos2d@@QAE_NPBDABUFontDefinition@2@@Z",
            DetourTextureInitWithStringFontDef,
            NULL, NULL, {0}, 0, 0
        },
        {
            "Texture2D::initWithString-full",
            "?initWithString@Texture2D@cocos2d@@QAE_NPBDABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@MABVSize@2@W4TextHAlignment@2@W4TextVAlignment@2@_NH@Z",
            DetourTextureInitWithStringFull,
            NULL, NULL, {0}, 0, 0
        },
        {
            "Label::setString",
            "?setString@Label@cocos2d@@UAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourLabelSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "LabelBMFont::setString",
            "?setString@LabelBMFont@cocos2d@@UAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourLabelBMFontSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "LabelTTF::setString",
            "?setString@LabelTTF@cocos2d@@UAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourLabelTTFSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "LabelAtlas::setString",
            "?setString@LabelAtlas@cocos2d@@UAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourLabelAtlasSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ui::Text::setString",
            "?setString@Text@ui@cocos2d@@QAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourUiTextSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ui::Text::setText",
            "?setText@Text@ui@cocos2d@@QAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourUiTextSetText,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ui::TextBMFont::setString",
            "?setString@TextBMFont@ui@cocos2d@@QAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourUiTextBMFontSetString,
            NULL, NULL, {0}, 0, 0
        },
        {
            "ui::TextBMFont::setText",
            "?setText@TextBMFont@ui@cocos2d@@QAEXABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@@Z",
            DetourUiTextBMFontSetText,
            NULL, NULL, {0}, 0, 0
        }
    };
    void **cocosTrampolineSlots[] = {
        &g_textureInitWithStringFontDefTrampoline,
        &g_textureInitWithStringFullTrampoline,
        &g_labelSetStringTrampoline,
        &g_labelBMFontSetStringTrampoline,
        &g_labelTTFSetStringTrampoline,
        &g_labelAtlasSetStringTrampoline,
        &g_uiTextSetStringTrampoline,
        &g_uiTextSetTextTrampoline,
        &g_uiTextBMFontSetStringTrampoline,
        &g_uiTextBMFontSetTextTrampoline
    };

    InstallHooksForModule(mainModule, "player.exe", mainHooks, mainTrampolineSlots,
                          (int)(sizeof(mainHooks) / sizeof(mainHooks[0])));
    InstallHooksForModule(cocosModule, "libcocos2d.dll", cocosHooks, cocosTrampolineSlots,
                          (int)(sizeof(cocosHooks) / sizeof(cocosHooks[0])));

    /* SQLite hooks — dialogue text is loaded via sqlite3_column_text. */
    {
        HMODULE sqlite3Module = GetModuleHandleA("sqlite3.dll");
        InlineHook sqlite3Hooks[] = {
            {
                "sqlite3_column_text",
                "sqlite3_column_text",
                DetourSqlite3ColumnText,
                NULL, NULL, {0}, 0, 0
            },
            {
                "sqlite3_column_text16",
                "sqlite3_column_text16",
                DetourSqlite3ColumnText16,
                NULL, NULL, {0}, 0, 0
            },
            {
                "sqlite3_exec",
                "sqlite3_exec",
                DetourSqlite3Exec,
                NULL, NULL, {0}, 0, 0
            },
            {
                "sqlite3_prepare_v2",
                "sqlite3_prepare_v2",
                DetourSqlite3PrepareV2,
                NULL, NULL, {0}, 0, 0
            },
            {
                "sqlite3_step",
                "sqlite3_step",
                DetourSqlite3Step,
                NULL, NULL, {0}, 0, 0
            },
            {
                "sqlite3_open",
                "sqlite3_open",
                DetourSqlite3Open,
                NULL, NULL, {0}, 0, 0
            }
        };
        void **sqlite3TrampolineSlots[] = {
            &g_sqlite3ColumnTextTrampoline,
            &g_sqlite3ColumnText16Trampoline,
            &g_sqlite3ExecTrampoline,
            &g_sqlite3PrepareV2Trampoline,
            &g_sqlite3StepTrampoline,
            &g_sqlite3OpenTrampoline
        };
        InstallHooksForModule(sqlite3Module, "sqlite3.dll", sqlite3Hooks, sqlite3TrampolineSlots,
                              (int)(sizeof(sqlite3Hooks) / sizeof(sqlite3Hooks[0])));
    }
}

#ifdef _M_IX86
static __declspec(naked) void DetourUpdateText7(void) {
    __asm {
        pushfd
        pushad
        mov eax, [esp + 40]
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
        mov eax, [esp + 40]
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
        mov eax, [esp + 40]
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
        mov eax, [esp + 40]
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
        mov eax, [esp + 40]
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
        mov eax, [esp + 40]
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
   thiscall: ecx=this, [esp+4]=ObjectCommandData*. Log that it was called. */
static __declspec(naked) void DetourExecActionMessageShow(void) {
    __asm {
        pushfd
        pushad
        /* Log the call with the ObjectCommandData pointer. */
        push dword ptr [esp + 40]
        push OFFSET g_labelExecActionMessageShow
        call LogCStringCall
        add esp, 8
        popad
        popfd
        jmp dword ptr [g_execActionMessageShowTrampoline]
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
 * Uses CALL-based detour to capture the result string after the call returns.
 */
static __declspec(naked) void DetourTextGuiGetString(void) {
    __asm {
        pushfd
        pushad
        /* Log that getString was called. */
        push dword ptr [esp + 40]  /* hidden return string ptr */
        push OFFSET g_labelTextGuiGetString
        call LogTextCall
        add esp, 8
        popad
        popfd
        /* Call original via trampoline. */
        call dword ptr [g_textGuiGetStringTrampoline]
        /* eax = hidden return pointer (same as [esp+4] in original).
           The result std::string has been constructed there. Read it. */
        pushfd
        pushad
        push eax
        push OFFSET g_labelTextGuiGetStringResult
        call LogStdStringRefCall
        add esp, 8
        popad
        popfd
        ret
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
        Log("[Heartbeat:%d] DLL alive, TextHook=%ld CString/StringHook=%ld TextData=%ld Sqlite3=%ld\n",
            tick * 10,
            (LONG)g_textCallCount,
            (LONG)g_cStringCallCount,
            (LONG)g_textDataGetTextCallCount,
            (LONG)g_sqliteCallCount);
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
