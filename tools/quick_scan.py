"""Quick scan: extract all readable Japanese strings from game memory.
Tries both UTF-8 and Shift-JIS, keeps the one that produces valid hiragana."""
import json
import ctypes
from ctypes import wintypes

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
TH32CS_SNAPPROCESS = 0x00000002
MEM_COMMIT = 0x1000
PAGE_READONLY = 0x02
PAGE_READWRITE = 0x04
PAGE_WRITECOPY = 0x08
PAGE_EXECUTE_READ = 0x20
PAGE_EXECUTE_READWRITE = 0x40
READABLE = {PAGE_READONLY, PAGE_READWRITE, PAGE_WRITECOPY, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE}

kernel32 = ctypes.windll.kernel32

class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]

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
        ("szExeFile", ctypes.c_char * wintypes.MAX_PATH),
    ]

def find_pid(name: str) -> int:
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1: return 0
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    target = name.lower()
    if not target.endswith(".exe"): target += ".exe"
    if kernel32.Process32First(snap, ctypes.byref(entry)):
        while True:
            ename = entry.szExeFile.decode("utf-8", errors="ignore").lower()
            if ename == target:
                kernel32.CloseHandle(snap)
                return entry.th32ProcessID
            if not kernel32.Process32Next(snap, ctypes.byref(entry)): break
    kernel32.CloseHandle(snap)
    return 0

def has_hiragana(text: str) -> bool:
    return any(0x3040 <= ord(c) <= 0x309F for c in text)

def try_decode(raw: bytes):
    """Try UTF-8 and Shift-JIS, return (text, encoding) or (None, None)."""
    # Try UTF-8 first
    try:
        t = raw.decode("utf-8")
        if has_hiragana(t):
            return t, "utf-8"
    except UnicodeDecodeError:
        pass
    # Try Shift-JIS
    try:
        t = raw.decode("shift_jis")
        if has_hiragana(t):
            return t, "shift-jis"
    except UnicodeDecodeError:
        pass
    return None, None

def main():
    pid = find_pid("player.exe")
    if not pid:
        print("Game not running")
        return
    print(f"PID: {pid}")
    h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        print("OpenProcess failed")
        return

    results = []
    seen = set()
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    regions = 0

    while kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        if mbi.State == MEM_COMMIT and mbi.Protect in READABLE and 0 < mbi.RegionSize < 512*1024*1024:
            base = mbi.BaseAddress or 0
            regions += 1
            offset = 0
            while offset < mbi.RegionSize:
                chunk = min(256*1024, mbi.RegionSize - offset)
                buf = ctypes.create_string_buffer(chunk)
                nread = ctypes.c_size_t(0)
                if kernel32.ReadProcessMemory(h, ctypes.c_void_p(base + offset), buf, chunk, ctypes.byref(nread)):
                    raw = buf.raw[:nread.value]
                    # Extract strings between nulls
                    i = 0
                    while i < len(raw):
                        if raw[i] == 0 or (raw[i] < 0x20 and raw[i] not in (0x0A, 0x0D, 0x09)):
                            i += 1
                            continue
                        j = i
                        while j < len(raw) and raw[j] != 0 and not (raw[j] < 0x20 and raw[j] not in (0x0A, 0x0D, 0x09)):
                            j += 1
                        if j - i >= 12:  # At least 4 CJK chars
                            chunk_bytes = raw[i:j]
                            text, enc = try_decode(chunk_bytes)
                            if text and text not in seen and len(text) >= 8:
                                seen.add(text)
                                results.append({"address": base + i, "text": text, "encoding": enc, "length": len(text)})
                        i = j + 1
                offset += chunk
            if regions % 100 == 0:
                print(f"  {regions} regions, {len(results)} strings...")
        addr += mbi.RegionSize

    kernel32.CloseHandle(h)

    results.sort(key=lambda x: -x["length"])
    print(f"\nTotal: {len(results)} unique Japanese strings")

    # Show long texts (likely dialogue)
    long = [r for r in results if r["length"] >= 15]
    print(f"Dialogue-length (>=15 chars): {len(long)}")

    with open("output/readable_strings.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    # Print top long texts to file (avoid GBK console issues)
    with open("output/readable_strings_top.txt", "w", encoding="utf-8") as f:
        for r in long[:50]:
            f.write(f"0x{r['address']:08X} [{r['encoding']}] ({r['length']}c):\n  {r['text']}\n\n")

    print("Top texts written to output/readable_strings_top.txt")
    print(f"Full results: output/readable_strings.json")

if __name__ == "__main__":
    main()
