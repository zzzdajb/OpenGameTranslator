/**
 * OpenGameTranslator Hook DLL - Diagnostic version.
 * Proxies sqlite3.dll to hook into the AGTK game engine.
 * This version writes a diagnostic log to help find function addresses.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

static wchar_t g_logPath[MAX_PATH];
static char g_logBuf[4096];
static int g_logLen = 0;

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
    g_logLen = 0;
}

/* ---- RTTI Scanner ---- */

#define MAX_VTABLE_SIZE 64

typedef struct {
    void *vtable;               /* Address of vtable (first function entry). */
    int vtableSize;             /* Number of virtual functions found. */
    void *functions[MAX_VTABLE_SIZE]; /* Function pointers. */
    const char *name;           /* Class name found. */
} FoundVtable;

static HMODULE g_mainModule = NULL;
static BYTE *g_moduleBase = NULL;
static DWORD g_moduleSize = 0;
static FoundVtable g_foundVtables[8];
static int g_foundCount = 0;

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
            for (int j = -16; j < 64; j++) {
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

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);

        /* Set up log path. */
        wchar_t userProfile[MAX_PATH];
        if (GetEnvironmentVariableW(L"USERPROFILE", userProfile, MAX_PATH)) {
            _snwprintf_s(g_logPath, MAX_PATH, _TRUNCATE,
                         L"%s\\AppData\\Local\\player\\opengametranslator_hook_diag.txt",
                         userProfile);
        } else {
            wcscpy_s(g_logPath, MAX_PATH, L"opengametranslator_hook_diag.txt");
        }

        Log("=== OpenGameTranslator Hook DLL Diagnostic ===\n");
        Log("DLL loaded at: 0x%p\n", hinstDLL);

        InitModuleInfo();
        ScanRTTI();

        FlushLog();
    }
    return TRUE;
}
