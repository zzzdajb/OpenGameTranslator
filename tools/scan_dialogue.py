"""Scan a running game process for Japanese dialogue text.

Scans ALL readable committed memory regions (not just heap), tries both
UTF-8 and Shift-JIS encodings, and uses dialogue-specific search probes.

Usage:
  1. Start the game with launcher.exe and navigate to a dialogue scene.
  2. python tools/scan_dialogue.py player.exe
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

# Dialogue keywords from the game (inferred from game context).
# These are common Japanese words likely to appear in dialogue.
DIALOGUE_PROBES_UTF8 = [
    "珍しく",
    "部下",
    "春日部",
    "昼食",
    "痴漢",
    "お父さん",
    "マーヤ",
    "電車",
    "物語",
]

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

def is_valid_sjis_byte_sequence(data: bytes) -> bool:
    """Verify that byte sequence is valid Shift-JIS (no invalid lead/trail combos)."""
    i = 0
    while i < len(data):
        b = data[i]
        if b < 0x80:
            i += 1
        elif 0xA0 <= b <= 0xDF:
            i += 1  # Halfwidth katakana — single byte
        elif (0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xEF):
            if i + 1 >= len(data):
                return False  # Truncated lead byte
            t = data[i + 1]
            if not (0x40 <= t <= 0xFC and t != 0x7F):
                return False  # Invalid trail byte
            i += 2
        else:
            return False  # Invalid lead byte (0x80, 0xA0, 0xF0-0xFF etc.)
    return True

def is_japanese(text: str, is_sjis: bool = False) -> bool:
    """Detect Japanese text: must contain hiragana/katakana."""
    hiragana = 0
    katakana = 0
    kanji = 0
    halfwidth_kana = 0
    control = 0
    total = 0

    for ch in text:
        code = ord(ch)
        total += 1
        if 0x3040 <= code <= 0x309F:
            hiragana += 1
        elif 0x30A0 <= code <= 0x30FF:
            katakana += 1
        elif 0xFF61 <= code <= 0xFF9F:
            halfwidth_kana += 1
        elif 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            kanji += 1
        elif code < 0x20 and code not in (0x0A, 0x0D, 0x09):
            control += 1
        elif 0x80 <= code <= 0x9F:
            control += 1  # C1 control codes = Shift-JIS decode garbage
        elif code >= 0xE000 and code <= 0xF8FF:
            return False  # Private use area = binary garbage

    if total < 2:
        return False
    # Reject if too many control characters.
    if control > total * 0.2:
        return False
    # Must have hiragana or katakana (not just kanji which can be false positives).
    kana_count = hiragana + katakana + halfwidth_kana
    # For Shift-JIS binary garbage can produce halfwidth katakana and kanji.
    # Hiragana (U+3040-U+309F) requires specific SJIS bytes (0x82 0x9F-0xF1)
    # which are very rare in random data — the most reliable Japanese indicator.
    if is_sjis:
        return hiragana >= 1 and (hiragana + katakana + kanji) >= total * 0.25
    else:
        return kana_count >= 1 or (kanji >= 4 and kana_count >= 1)

def extract_utf8_strings(data: bytes, base_addr: int) -> list[dict]:
    """Extract UTF-8 Japanese strings delimited by nulls or control chars."""
    results = []
    seen = set()
    i = 0
    while i < len(data):
        # Skip non-printable bytes except newline/tab.
        b = data[i]
        if b == 0x00 or (b < 0x20 and b not in (0x0A, 0x0D, 0x09)):
            i += 1
            continue

        start = i
        # Gather all bytes until a null or control char.
        while i < len(data):
            b = data[i]
            if b == 0x00:
                break
            if b < 0x20 and b not in (0x0A, 0x0D, 0x09):
                break
            i += 1

        chunk_len = i - start
        if chunk_len >= 6:  # At least 2 CJK chars (3 bytes each in UTF-8)
            raw_chunk = data[start:i]
            try:
                candidate = raw_chunk.decode("utf-8")
                # Only accept if it has hiragana — filters out most binary garbage.
                if is_japanese(candidate) and candidate not in seen:
                    seen.add(candidate)
                    results.append({"address": base_addr + start, "text": candidate, "encoding": "utf-8"})
            except UnicodeDecodeError:
                pass

        i += 1  # Skip past the null/delimiter

    return results

def extract_sjis_strings(data: bytes, base_addr: int) -> list[dict]:
    """Extract null-terminated Shift-JIS Japanese strings."""
    results = []
    seen = set()
    i = 0
    buf = bytearray()

    while i < len(data):
        b = data[i]
        if b == 0x00:
            if len(buf) >= 6:  # Min 6 bytes for meaningful Japanese text
                # Validate byte-level Shift-JIS structure first.
                if is_valid_sjis_byte_sequence(buf):
                    try:
                        candidate = buf.decode("shift_jis")
                        if is_japanese(candidate, is_sjis=True) and candidate not in seen:
                            seen.add(candidate)
                            results.append({"address": base_addr + i - len(buf), "text": candidate, "encoding": "shift-jis"})
                    except UnicodeDecodeError:
                        pass
            buf.clear()
        elif b < 0x20 and b not in (0x0A, 0x0D, 0x09):
            buf.clear()
        else:
            buf.append(b)
        i += 1

    return results

def scan_all_regions(handle: int) -> list[dict]:
    """Scan all committed readable memory regions for Japanese text."""
    all_results = []
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
            region_base = mbi.BaseAddress or 0
            regions_scanned += 1
            offset = 0
            chunk = 256 * 1024

            while offset < region_size:
                size = min(chunk, region_size - offset)
                buf = ctypes.create_string_buffer(size)
                bytes_read = ctypes.c_size_t(0)

                if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(region_base + offset),
                                               buf, size, ctypes.byref(bytes_read)):
                    raw = buf.raw[:bytes_read.value]
                    # UTF-8
                    all_results.extend(extract_utf8_strings(raw, region_base + offset))
                    # Shift-JIS
                    all_results.extend(extract_sjis_strings(raw, region_base + offset))

                offset += size

            if regions_scanned % 20 == 0:
                print(f"  Scanned {regions_scanned} regions, found {len(all_results)} strings...")

        addr += region_size

    print(f"  Total regions scanned: {regions_scanned}")
    return all_results

def search_specific_probes(handle: int) -> list[dict]:
    """Search for specific dialogue probe strings in memory."""
    results = []
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    mbi_size = ctypes.sizeof(mbi)

    print("\n=== Searching for dialogue probes ===")

    probes = DIALOGUE_PROBES_UTF8
    probes_bytes = [(p, p.encode("utf-8")) for p in probes]

    # Also create Shift-JIS variants
    for p in probes:
        try:
            probes_bytes.append((p + " [SJIS]", p.encode("shift_jis")))
        except Exception:
            pass

    while kernel32.VirtualQueryEx(handle, ctypes.c_void_p(addr),
                                   ctypes.byref(mbi), mbi_size):
        region_size = mbi.RegionSize
        if (mbi.State == MEM_COMMIT and
            mbi.Protect in READABLE_PAGES and
            0 < region_size < 512 * 1024 * 1024):
            region_base = mbi.BaseAddress or 0
            offset = 0
            chunk = 1024 * 1024

            while offset < region_size:
                size = min(chunk, region_size - offset)
                buf = ctypes.create_string_buffer(size)
                bytes_read = ctypes.c_size_t(0)

                if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(region_base + offset),
                                               buf, size, ctypes.byref(bytes_read)):
                    raw = buf.raw[:bytes_read.value]
                    for label, probe in probes_bytes:
                        pos = raw.find(probe)
                        if pos >= 0:
                            results.append({
                                "probe": label,
                                "address_hex": f"0x{region_base + offset + pos:08X}",
                                "address": region_base + offset + pos,
                                "region_base": region_base,
                                "encoding": "shift-jis" if "[SJIS]" in label else "utf-8"
                            })
                            # Dump surrounding memory.
                            start = max(0, region_base + offset + pos - 64)
                            dump_size = min(256, region_size - (pos - 64 if pos >= 64 else pos))
                            dump_buf = ctypes.create_string_buffer(dump_size)
                            dump_read = ctypes.c_size_t(0)
                            if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(start),
                                                           dump_buf, dump_size, ctypes.byref(dump_read)):
                                raw_dump = dump_buf.raw[:dump_read.value]
                                hex_str = " ".join(f"{b:02X}" for b in raw_dump[:128])
                                ascii_str = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in raw_dump[:128])
                                print(f"\n  Found '{label}' at 0x{region_base + offset + pos:08X}")
                                print(f"  Hex: {hex_str}")
                                print(f"  ASCII: {ascii_str}")

                offset += size

        addr += region_size

    return results

def main():
    if len(sys.argv) < 2:
        print("Usage: python tools/scan_dialogue.py <exe-name>")
        sys.exit(1)

    exe_name = sys.argv[1]
    pid = find_process_id(exe_name)
    if pid is None:
        print(f"Process '{exe_name}' not found. Start the game first.")
        sys.exit(1)

    print(f"Found PID: {pid}")
    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        print("OpenProcess failed. Try running as Administrator.")
        sys.exit(1)

    # Phase 1: Search for specific dialogue probes.
    probe_results = search_specific_probes(handle)
    print(f"\nProbe search complete: {len(probe_results)} matches")

    # Phase 2: Full extraction of all Japanese strings.
    print("\n=== Full Japanese string extraction ===")
    all_results = scan_all_regions(handle)

    kernel32.CloseHandle(handle)

    if not all_results:
        print("\nNo Japanese text found in process memory.")
        print("The text may be in GPU memory, encrypted, or using a custom encoding.")
        sys.exit(0)

    # Deduplicate by text.
    seen = set()
    unique = []
    for r in all_results:
        if r["text"] not in seen:
            seen.add(r["text"])
            unique.append(r)

    unique.sort(key=lambda x: x["address"])

    print(f"\nTotal Japanese strings: {len(all_results)}, Unique: {len(unique)}")

    # Separate by encoding.
    utf8_count = sum(1 for r in unique if r["encoding"] == "utf-8")
    sjis_count = sum(1 for r in unique if r["encoding"] == "shift-jis")
    print(f"  UTF-8: {utf8_count}, Shift-JIS: {sjis_count}")

    # Filter for dialogue-length text (10+ chars, more likely to be dialogue).
    dialogue = [r for r in unique if len(r["text"]) >= 10]
    print(f"  Dialogue-length (>=10 chars): {len(dialogue)}")

    # Save full results.
    out_path = "output/dialogue_scan.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(unique, f, ensure_ascii=False, indent=2)
    print(f"\nFull results: {out_path}")

    # Save dialogue-only results.
    dialogue_out = "output/dialogue_candidates.json"
    with open(dialogue_out, "w", encoding="utf-8") as f:
        json.dump(dialogue, f, ensure_ascii=False, indent=2)
    print(f"Dialogue candidates: {dialogue_out}")

    # Show longest texts (most likely dialogue).
    print("\n=== Top 40 longest Japanese texts ===")
    by_len = sorted(dialogue, key=lambda x: -len(x["text"]))[:40]
    for r in by_len:
        try:
            print(f"  0x{r['address']:08X} [{r['encoding']}] ({len(r['text'])}c): {r['text'][:120]}")
        except UnicodeEncodeError:
            # Windows GBK console can't print Japanese — show escaped.
            print(f"  0x{r['address']:08X} [{r['encoding']}] ({len(r['text'])}c): <japanese text>")

if __name__ == "__main__":
    main()
