"""Extract all Japanese strings from heap regions near known text matches."""

import sys
import json
import struct
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
READABLE_PAGES = {PAGE_READONLY, PAGE_READWRITE, PAGE_WRITECOPY,
                  PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE}

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


def find_process_id(exe_name: str) -> int | None:
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return None
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    target = exe_name.lower()
    if not target.endswith(".exe"):
        target += ".exe"
    if kernel32.Process32First(snapshot, ctypes.byref(entry)):
        while True:
            name = entry.szExeFile.decode("utf-8", errors="ignore").lower()
            if name == target:
                kernel32.CloseHandle(snapshot)
                return entry.th32ProcessID
            if not kernel32.Process32Next(snapshot, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snapshot)
    return None


def is_japanese_extended(text: str) -> bool:
    """Accept text with hiragana/katakana OR substantial CJK with Japanese context."""
    has_kana = False
    has_cjk = False
    cjk_count = 0
    total_chars = 0

    for ch in text:
        code = ord(ch)
        total_chars += 1
        if 0x3040 <= code <= 0x30FF:
            has_kana = True
        elif 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            has_cjk = True
            cjk_count += 1
        elif code < 0x20 and code not in (0x0A, 0x0D, 0x09):
            return False  # Control char

    if total_chars < 2:
        return False

    # Must have kana, OR substantial kanji-only text that looks like Japanese
    # (pure kanji text that's > 4 chars is likely Japanese in this game context).
    return has_kana or (has_cjk and cjk_count >= 4)


def extract_utf8_strings(data: bytes, base_addr: int) -> list[dict]:
    """Extract all null-terminated or delimited UTF-8 Japanese strings from raw bytes."""
    results = []
    seen = set()
    i = 0

    while i < len(data):
        # Skip non-UTF8-friendly bytes.
        if data[i] < 0x20 or (data[i] >= 0x7F and data[i] < 0xC0):
            i += 1
            continue

        # Try to decode a UTF-8 sequence.
        start = i
        while i < len(data):
            b = data[i]
            if b == 0x00:
                break  # Null terminator
            if b < 0x20:
                break
            if 0x80 <= b < 0xC0:
                break  # Continuation byte without lead
            i += 1

        if i - start >= 6:  # At least 2 Japanese characters (3 bytes each for UTF-8)
            try:
                candidate = data[start:i].decode("utf-8")
                if is_japanese_extended(candidate) and candidate not in seen:
                    seen.add(candidate)
                    results.append({
                        "address": base_addr + start,
                        "text": candidate,
                        "length": len(candidate),
                    })
            except UnicodeDecodeError:
                pass

        i += 1  # Skip past the null or delimiter

    return results


def scan_heap_region(handle: int, region_base: int, region_size: int) -> list[dict]:
    """Scan an entire heap region for Japanese strings."""
    all_strings = []
    offset = 0
    chunk = 256 * 1024

    while offset < region_size:
        size = min(chunk, region_size - offset)
        buf = ctypes.create_string_buffer(size)
        bytes_read = ctypes.c_size_t(0)

        if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(region_base + offset),
                                       buf, size, ctypes.byref(bytes_read)):
            strings = extract_utf8_strings(buf.raw[:bytes_read.value], region_base + offset)
            all_strings.extend(strings)

        offset += size

    return all_strings


def main():
    if len(sys.argv) < 2:
        print("Usage: python tools/extract_heap_strings.py <exe-name>")
        sys.exit(1)

    exe_name = sys.argv[1]
    pid = find_process_id(exe_name)
    if pid is None:
        print(f"Process '{exe_name}' not found.")
        sys.exit(1)

    print(f"Found PID: {pid}")
    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        print("OpenProcess failed. Try Administrator.")
        sys.exit(1)

    # Scan all heap regions (PAGE_READWRITE, > 64KB for typical game heaps).
    all_results = []
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    mbi_size = ctypes.sizeof(mbi)
    regions_scanned = 0

    print("Scanning heap regions for Japanese text...")

    while kernel32.VirtualQueryEx(handle, ctypes.c_void_p(addr),
                                   ctypes.byref(mbi), mbi_size):
        region_size = mbi.RegionSize
        if (mbi.State == MEM_COMMIT and
            mbi.Protect == PAGE_READWRITE and
            64 * 1024 <= region_size <= 512 * 1024 * 1024):
            regions_scanned += 1
            strings = scan_heap_region(handle, mbi.BaseAddress, region_size)
            all_results.extend(strings)

            if regions_scanned % 20 == 0:
                print(f"  Scanned {regions_scanned} regions, found {len(all_results)} strings...")

        addr += region_size

    kernel32.CloseHandle(handle)

    print(f"\nScanned {regions_scanned} heap regions.")
    print(f"Found {len(all_results)} Japanese text strings.")

    if all_results:
        # Deduplicate by text content.
        seen_texts = set()
        unique = []
        for r in all_results:
            if r["text"] not in seen_texts:
                seen_texts.add(r["text"])
                unique.append(r)

        print(f"Unique texts: {len(unique)}")

        # Sort by address for readability.
        unique.sort(key=lambda x: x["address"])

        with open("output/heap_strings.json", "w", encoding="utf-8") as f:
            json.dump(unique, f, ensure_ascii=False, indent=2)

        print("Results written to output/heap_strings.json")

        # Show samples.
        print("\n=== First 30 texts ===")
        for i, r in enumerate(unique[:30]):
            print(f"  0x{r['address']:08X}: {r['text'][:100]}")


if __name__ == "__main__":
    main()
