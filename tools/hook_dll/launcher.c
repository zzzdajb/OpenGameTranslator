/**
 * OpenGameTranslator Game Launcher with DLL injection.
 * Creates the game process suspended, injects the hook DLL, then resumes.
 * This ensures hooks are in place before any game code runs.
 *
 * Usage: launcher.exe <player.exe> <hook.dll>
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char *argv[]) {
    if (argc < 3) {
        printf("Usage: launcher.exe <player.exe> <hook.dll>\n");
        printf("  Creates game process suspended, injects DLL, then resumes.\n");
        return 1;
    }

    const char *gamePath = argv[1];
    const char *dllPath = argv[2];

    /* Get full paths. */
    char fullGamePath[MAX_PATH];
    char fullDllPath[MAX_PATH];
    if (!GetFullPathNameA(gamePath, MAX_PATH, fullGamePath, NULL)) {
        strcpy_s(fullGamePath, MAX_PATH, gamePath);
    }
    if (!GetFullPathNameA(dllPath, MAX_PATH, fullDllPath, NULL)) {
        strcpy_s(fullDllPath, MAX_PATH, dllPath);
    }

    /* Extract game directory for SetCurrentDirectory. */
    char gameDir[MAX_PATH];
    strcpy_s(gameDir, MAX_PATH, fullGamePath);
    char *lastSep = strrchr(gameDir, '\\');
    if (lastSep) *lastSep = '\0';

    printf("Game: %s\n", fullGamePath);
    printf("DLL:  %s\n", fullDllPath);
    printf("Dir:  %s\n", gameDir);

    /* Create the game process suspended. */
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));

    if (!CreateProcessA(fullGamePath, NULL, NULL, NULL, FALSE,
                        CREATE_SUSPENDED, NULL, gameDir, &si, &pi)) {
        printf("CreateProcess failed: %lu\n", GetLastError());
        return 1;
    }
    printf("Game PID: %lu (suspended)\n", pi.dwProcessId);

    /* Allocate memory for the DLL path in the target process. */
    size_t pathLen = strlen(fullDllPath) + 1;
    void *remoteMem = VirtualAllocEx(pi.hProcess, NULL, pathLen,
                                     MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        printf("VirtualAllocEx failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 1;
    }

    if (!WriteProcessMemory(pi.hProcess, remoteMem, fullDllPath, pathLen, NULL)) {
        printf("WriteProcessMemory failed: %lu\n", GetLastError());
        VirtualFreeEx(pi.hProcess, remoteMem, 0, MEM_RELEASE);
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 1;
    }

    /* Get LoadLibraryA address. */
    HMODULE k32 = GetModuleHandleA("kernel32.dll");
    LPTHREAD_START_ROUTINE loadLib =
        (LPTHREAD_START_ROUTINE)GetProcAddress(k32, "LoadLibraryA");
    if (!loadLib) {
        printf("GetProcAddress LoadLibraryA failed\n");
        VirtualFreeEx(pi.hProcess, remoteMem, 0, MEM_RELEASE);
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 1;
    }

    /* Create remote thread to call LoadLibraryA. */
    HANDLE hLoadThread = CreateRemoteThread(pi.hProcess, NULL, 0,
                                            loadLib, remoteMem, 0, NULL);
    if (!hLoadThread) {
        printf("CreateRemoteThread failed: %lu\n", GetLastError());
        VirtualFreeEx(pi.hProcess, remoteMem, 0, MEM_RELEASE);
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 1;
    }

    /* Wait for LoadLibraryA to finish. */
    WaitForSingleObject(hLoadThread, 5000);
    DWORD exitCode;
    GetExitCodeThread(hLoadThread, &exitCode);
    CloseHandle(hLoadThread);
    VirtualFreeEx(pi.hProcess, remoteMem, 0, MEM_RELEASE);

    if (exitCode) {
        printf("DLL loaded: 0x%lX\n", exitCode);
    } else {
        printf("LoadLibraryA returned NULL. DLL may have failed.\n");
        /* Continue anyway — the game should still start. */
    }

    /* Resume the game's main thread. */
    printf("Resuming game...\n");
    ResumeThread(pi.hThread);

    /* Wait for the game to exit. */
    printf("Game is running. Press Ctrl+C in this window to detach,\n");
    printf("or close the game window to stop.\n");
    WaitForSingleObject(pi.hProcess, INFINITE);

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    printf("Game exited.\n");
    return 0;
}
