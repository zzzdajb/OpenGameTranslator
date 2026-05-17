/**
 * Minimal DLL injector for OpenGameTranslator.
 * Usage: injector.exe player.exe opengametranslator_hook.dll
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>

static int ends_with_exe(const char *name) {
    size_t len = strlen(name);
    return len >= 4 && _stricmp(name + len - 4, ".exe") == 0;
}

static int process_name_matches(const char *actualName, const char *requestedName) {
    char requestedWithExe[MAX_PATH];

    if (_stricmp(actualName, requestedName) == 0) {
        return 1;
    }

    if (ends_with_exe(requestedName)) {
        return 0;
    }

    _snprintf_s(requestedWithExe, sizeof(requestedWithExe), _TRUNCATE, "%s.exe", requestedName);
    return _stricmp(actualName, requestedWithExe) == 0;
}

static DWORD find_process_id(const char *procName) {
    DWORD pid = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);

    if (snap == INVALID_HANDLE_VALUE) {
        printf("CreateToolhelp32Snapshot failed: %lu\n", GetLastError());
        return 0;
    }

    PROCESSENTRY32 pe;
    memset(&pe, 0, sizeof(pe));
    pe.dwSize = sizeof(pe);

    if (Process32First(snap, &pe)) {
        do {
            char exeName[MAX_PATH];

#ifdef UNICODE
            WideCharToMultiByte(CP_ACP, 0, pe.szExeFile, -1, exeName, sizeof(exeName), NULL, NULL);
#else
            strcpy_s(exeName, sizeof(exeName), pe.szExeFile);
#endif

            if (process_name_matches(exeName, procName)) {
                pid = pe.th32ProcessID;
                break;
            }
        } while (Process32Next(snap, &pe));
    }

    CloseHandle(snap);
    return pid;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        printf("Usage: injector.exe <process.exe> <hook.dll>\n");
        return 1;
    }

    const char *procName = argv[1];
    const char *dllPath = argv[2];

    DWORD pid = find_process_id(procName);
    if (!pid) {
        printf("Process '%s' not found.\n", procName);
        return 1;
    }
    printf("Found %s PID: %lu\n", procName, pid);

    /* Get full path of DLL. */
    char fullPath[MAX_PATH];
    if (!GetFullPathNameA(dllPath, MAX_PATH, fullPath, NULL)) {
        strcpy_s(fullPath, MAX_PATH, dllPath);
    }
    printf("DLL: %s\n", fullPath);

    /* Allocate memory in the target process for the DLL path. */
    HANDLE hProc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                               PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                               FALSE, pid);
    if (!hProc) {
        printf("OpenProcess failed: %lu (try running as Administrator)\n", GetLastError());
        return 1;
    }

    size_t pathLen = strlen(fullPath) + 1;
    void *remoteMem = VirtualAllocEx(hProc, NULL, pathLen, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        printf("VirtualAllocEx failed: %lu\n", GetLastError());
        CloseHandle(hProc);
        return 1;
    }

    if (!WriteProcessMemory(hProc, remoteMem, fullPath, pathLen, NULL)) {
        printf("WriteProcessMemory failed: %lu\n", GetLastError());
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        return 1;
    }

    /* Get LoadLibraryA address (same in all processes due to same kernel32 base). */
    HMODULE k32 = GetModuleHandleA("kernel32.dll");
    LPTHREAD_START_ROUTINE loadLib = (LPTHREAD_START_ROUTINE)GetProcAddress(k32, "LoadLibraryA");
    if (!loadLib) {
        printf("GetProcAddress LoadLibraryA failed\n");
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        return 1;
    }

    /* Create remote thread to call LoadLibraryA. */
    HANDLE hThread = CreateRemoteThread(hProc, NULL, 0, loadLib, remoteMem, 0, NULL);
    if (!hThread) {
        printf("CreateRemoteThread failed: %lu\n", GetLastError());
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        return 1;
    }

    /* Wait for LoadLibraryA to finish. */
    WaitForSingleObject(hThread, 5000);
    DWORD exitCode;
    GetExitCodeThread(hThread, &exitCode);
    CloseHandle(hThread);
    VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
    CloseHandle(hProc);

    if (exitCode) {
        printf("DLL loaded successfully (handle: 0x%lX)\n", exitCode);
    } else {
        printf("LoadLibraryA returned NULL. DLL may have failed to load.\n");
        printf("Check: %s exists and is a valid DLL.\n", fullPath);
    }

    return exitCode ? 0 : 1;
}
