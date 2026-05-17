"""Inject a 32-bit DLL into a 32-bit process on 64-bit Windows (WoW64).

Finds the 32-bit LoadLibraryA address by enumerating the target's modules
via CreateToolhelp32Snapshot, then uses CreateRemoteThread.
"""
import sys
import os
import ctypes
from ctypes import wintypes

kernel32 = ctypes.windll.kernel32

# Set proper return types.
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.VirtualAllocEx.restype = ctypes.c_void_p
kernel32.CreateRemoteThread.restype = wintypes.HANDLE

# Constants
PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
PAGE_READWRITE = 0x04
TH32CS_SNAPPROCESS = 0x00000002
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_ubyte)),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_char * 256),
        ("szExePath", ctypes.c_char * 260),
    ]


def find_pid(name: str) -> int:
    """Find process ID by executable name."""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == wintypes.HANDLE(-1).value:
        raise OSError("CreateToolhelp32Snapshot failed")
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    target = name.lower()
    if kernel32.Process32First(snap, ctypes.byref(entry)):
        while True:
            ename = entry.szExeFile.decode("utf-8", errors="ignore").lower()
            if ename == target:
                kernel32.CloseHandle(snap)
                return entry.th32ProcessID
            if not kernel32.Process32Next(snap, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snap)
    return 0


def find_32bit_kernel32_base(pid: int) -> int:
    """Find the base address of kernel32.dll in a 32-bit process."""
    # TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32 to enumerate 32-bit modules.
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if snap == wintypes.HANDLE(-1).value:
        raise OSError(f"CreateToolhelp32Snapshot(MODULE32) failed: {kernel32.GetLastError()}")

    entry = MODULEENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    if kernel32.Module32First(snap, ctypes.byref(entry)):
        while True:
            name = entry.szModule.decode("utf-8", errors="ignore").lower()
            if name == "kernel32.dll":
                base = ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value
                kernel32.CloseHandle(snap)
                return base or 0
            if not kernel32.Module32Next(snap, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snap)
    return 0


def find_export_in_remote(h_proc, module_base: int, func_name: bytes) -> int:
    """Find an exported function in a remote 32-bit module by parsing its PE."""
    # Read DOS header.
    dos = (ctypes.c_ubyte * 0x40)()
    read = ctypes.c_size_t()
    kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(module_base),
                               dos, len(dos), ctypes.byref(read))
    pe_rva = int.from_bytes(dos[0x3C:0x40][:4], 'little')

    # Read PE signature and COFF + optional header.
    pe_buf = (ctypes.c_ubyte * 0x200)()
    kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(module_base + pe_rva),
                               pe_buf, len(pe_buf), ctypes.byref(read))

    # PE32: export directory at optional header offset 0x60.
    export_rva = int.from_bytes(pe_buf[0x60:0x64][:4], 'little')
    if export_rva == 0:
        return 0

    # Read export directory.
    export_addr = module_base + export_rva
    exp = (ctypes.c_ubyte * 40)()
    kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(export_addr),
                               exp, 40, ctypes.byref(read))

    num_names = int.from_bytes(exp[24:28][:4], 'little')
    funcs_rva = int.from_bytes(exp[28:32][:4], 'little')
    names_rva = int.from_bytes(exp[32:36][:4], 'little')
    ordinals_rva = int.from_bytes(exp[36:40][:4], 'little')

    names_addr = module_base + names_rva
    ords_addr = module_base + ordinals_rva
    funcs_addr = module_base + funcs_rva

    target = func_name + b"\x00"
    target_len = len(target)

    for i in range(num_names):
        # Read name RVA.
        name_rva_buf = (ctypes.c_ubyte * 4)()
        kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(names_addr + i * 4),
                                   name_rva_buf, 4, ctypes.byref(read))
        name_rva = int.from_bytes(bytes(name_rva_buf[:4]), 'little')

        # Read name string.
        name_buf = (ctypes.c_ubyte * target_len)()
        kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(module_base + name_rva),
                                   name_buf, target_len, ctypes.byref(read))
        if bytes(name_buf) == target:
            # Read ordinal.
            ord_buf = (ctypes.c_ubyte * 2)()
            kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(ords_addr + i * 2),
                                       ord_buf, 2, ctypes.byref(read))
            ordinal = int.from_bytes(bytes(ord_buf[:2]), 'little')

            # Read function RVA.
            func_rva_buf = (ctypes.c_ubyte * 4)()
            kernel32.ReadProcessMemory(h_proc, ctypes.c_void_p(funcs_addr + ordinal * 4),
                                       func_rva_buf, 4, ctypes.byref(read))
            func_rva = int.from_bytes(bytes(func_rva_buf[:4]), 'little')
            return module_base + func_rva

    return 0


def inject(pid: int, dll_path: str):
    dll_bytes = dll_path.encode("utf-8") + b"\x00"
    h_proc = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not h_proc:
        raise OSError(f"OpenProcess({pid}) failed: {kernel32.GetLastError()}")

    # Find 32-bit kernel32 base and LoadLibraryA address.
    print("Finding 32-bit kernel32.dll base...")
    k32_base = find_32bit_kernel32_base(pid)
    if not k32_base:
        kernel32.CloseHandle(h_proc)
        raise OSError("Could not find kernel32.dll in target process")
    print(f"  32-bit kernel32.dll at 0x{k32_base:08X}")

    print("Finding LoadLibraryA...")
    load_lib = find_export_in_remote(h_proc, k32_base, b"LoadLibraryA")
    if not load_lib:
        kernel32.CloseHandle(h_proc)
        raise OSError("Could not find LoadLibraryA in remote kernel32.dll")
    print(f"  LoadLibraryA at 0x{load_lib:08X}")

    # Allocate memory in target for DLL path.
    remote_mem = kernel32.VirtualAllocEx(h_proc, None, len(dll_bytes),
                                          MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
    if not remote_mem:
        kernel32.CloseHandle(h_proc)
        raise OSError("VirtualAllocEx failed")

    written = ctypes.c_size_t(0)
    kernel32.WriteProcessMemory(h_proc, remote_mem, dll_bytes, len(dll_bytes), ctypes.byref(written))
    print(f"Wrote DLL path to 0x{remote_mem:08X}")

    # Create remote thread.
    print("Creating remote thread...")
    h_thread = kernel32.CreateRemoteThread(h_proc, None, 0,
                                            ctypes.c_void_p(load_lib),
                                            remote_mem, 0, None)
    if not h_thread:
        err = kernel32.GetLastError()
        kernel32.VirtualFreeEx(h_proc, remote_mem, 0, 0x8000)
        kernel32.CloseHandle(h_proc)
        raise OSError(f"CreateRemoteThread failed: {err}")

    kernel32.WaitForSingleObject(h_thread, 5000)
    exit_code = wintypes.DWORD()
    kernel32.GetExitCodeThread(h_thread, ctypes.byref(exit_code))
    kernel32.CloseHandle(h_thread)

    # Clean up.
    kernel32.VirtualFreeEx(h_proc, remote_mem, 0, 0x8000)
    kernel32.CloseHandle(h_proc)

    if exit_code.value:
        print(f"DLL loaded! Handle: 0x{exit_code.value:08X}")
    else:
        print("DLL load FAILED (LoadLibraryA returned NULL).")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python inject.py <process.exe> <hook.dll>")
        sys.exit(1)
    pid = find_pid(sys.argv[1])
    if not pid:
        print(f"Process '{sys.argv[1]}' not found.")
        sys.exit(1)
    print(f"Found PID: {pid}")
    inject(pid, os.path.abspath(sys.argv[2]))
