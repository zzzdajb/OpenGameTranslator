"""Scan a running game process for known Japanese text strings in memory.

Usage:
  1. Launch the game (player.exe).
  2. Play until dialogue text is visible on screen.
  3. Run: python tools/memory_scanner.py player.exe
"""

import sys
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

READABLE_PAGES = {PAGE_READONLY, PAGE_READWRITE, PAGE_WRITECOPY,
                  PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE}

# Known texts from the game's CSV extraction — used as probes.
KNOWN_TEXTS = [
    "オートモードキーボ",
    "セーブデータ削除",
    "おさわり痴漢ゲーム",
    "エネミーグループ",
    "キゲンメーター変換",
    "startゲームを選ぶ　はてな",
    "サイドメニュー上",
    "st4　外の背景繰り返し",
    "cursor(レイヤー1用)",
    "画面切り替わりA(ゲームオーバー用)",
    "ちかんサポート　マーヤ",
    "愛娘に、電車で痴漢をする父親の物語。",
]

CHUNK_SIZE = 1024 * 1024  # 1MB at a time

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


def search_memory_for_text(handle: int, search_bytes: bytes, text_label: str) -> list[dict]:
    """Search committed readable memory for a specific byte pattern."""
    results = []
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    mbi_size = ctypes.sizeof(mbi)
    regions_scanned = 0

    while kernel32.VirtualQueryEx(handle, ctypes.c_void_p(addr),
                                   ctypes.byref(mbi), mbi_size):
        region_size = mbi.RegionSize
        if (mbi.State == MEM_COMMIT and
            mbi.Protect in READABLE_PAGES and
            0 < region_size < 512 * 1024 * 1024):
            region_base = mbi.BaseAddress
            regions_scanned += 1
            offset = 0

            while offset < region_size:
                chunk = min(CHUNK_SIZE, region_size - offset)
                buf = ctypes.create_string_buffer(chunk)
                bytes_read = ctypes.c_size_t(0)
                current_addr = region_base + offset

                if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(current_addr),
                                              buf, chunk, ctypes.byref(bytes_read)):
                    raw = buf.raw[:bytes_read.value]
                    # Search for the byte pattern.
                    pos = raw.find(search_bytes)
                    while pos >= 0:
                        results.append({
                            "search_text": text_label,
                            "address_hex": f"0x{current_addr + pos:08X}",
                            "address": current_addr + pos,
                            "region_base": region_base,
                        })
                        # Continue searching after this match.
                        pos = raw.find(search_bytes, pos + 1)
                        if len(results) >= 10:
                            break

                offset += chunk

                if any(r["search_text"] == text_label and len([x for x in results if x["search_text"] == text_label]) >= 5
                       for r in results):
                    break

        if all(len([x for x in results if x["search_text"] == t]) >= 5 for t in KNOWN_TEXTS[:3]):
            break

        addr += region_size

    print(f"  Scanned {regions_scanned} regions, found {len(results)} matches")
    return results


def dump_surrounding_memory(handle: int, addr: int, size_before: int = 64, size_after: int = 256) -> str:
    """Read memory around an address and return hex + ASCII dump."""
    start = max(0, addr - size_before)
    total = size_before + size_after
    buf = ctypes.create_string_buffer(total)
    bytes_read = ctypes.c_size_t(0)

    if not kernel32.ReadProcessMemory(handle, ctypes.c_void_p(start),
                                       buf, total, ctypes.byref(bytes_read)):
        return "<read failed>"

    raw = buf.raw[:bytes_read.value]
    lines = []
    for i in range(0, len(raw), 16):
        chunk = raw[i:i+16]
        hex_part = " ".join(f"{b:02X}" for b in chunk)
        ascii_part = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in chunk)
        lines.append(f"  {start+i:08X}: {hex_part:<48s} {ascii_part}")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: python tools/memory_scanner.py <exe-name>")
        sys.exit(1)

    exe_name = sys.argv[1]
    pid = find_process_id(exe_name)
    if pid is None:
        print(f"Process '{exe_name}' not found.")
        sys.exit(1)

    print(f"Found PID: {pid}")
    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        print("OpenProcess failed. Try running as Administrator.")
        sys.exit(1)

    all_results = []
    for text in KNOWN_TEXTS:
        print(f"\nSearching for: {text[:60]}...")
        # Search UTF-8 encoding.
        utf8_bytes = text.encode("utf-8")
        results = search_memory_for_text(handle, utf8_bytes, text)
        all_results.extend(results)

        if not results:
            # Also try Shift-JIS.
            try:
                sjis_bytes = text.encode("shift_jis")
                results = search_memory_for_text(handle, sjis_bytes, f"{text} [SJIS]")
                all_results.extend(results)
            except Exception:
                pass

    kernel32.CloseHandle(handle)

    if not all_results:
        print("\nNo known texts found in process memory.")
        print("The dialogue text may be in GPU memory, compressed, or not yet loaded.")
        sys.exit(0)

    # Deduplicate by address.
    seen = set()
    unique = []
    for r in all_results:
        key = r["address"]
        if key not in seen:
            seen.add(key)
            unique.append(r)

    print(f"\n=== Found {len(unique)} unique matches ===")

    # Write full results.
    with open("output/memory_scan_results.json", "w", encoding="utf-8") as f:
        json.dump(unique, f, ensure_ascii=False, indent=2)

    # Show summary and dump surrounding memory for first few.
    handle2 = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    for i, r in enumerate(unique[:8]):
        print(f"\n[{i}] {r['search_text'][:50]} at {r['address_hex']}")
        if handle2:
            print(dump_surrounding_memory(handle2, r["address"]))

    if handle2:
        kernel32.CloseHandle(handle2)

    print(f"\nFull results: output/memory_scan_results.json")


if __name__ == "__main__":
    main()
