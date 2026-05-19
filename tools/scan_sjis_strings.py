"""Scan player.exe / libcocos2d.dll for Shift-JIS encoded Japanese text.

Writes results to output/sjis_scan_results.txt to avoid Windows GBK terminal issues.
"""

from pathlib import Path

# Shift-JIS lead bytes for double-byte chars
SJIS_LEAD = set(range(0x81, 0xA0)) | set(range(0xE0, 0xF0))
SJIS_TRAIL = set(range(0x40, 0x7F)) | set(range(0x80, 0xFD))


def find_null_delimited_sjis_strings(buf: bytes, min_jp: int = 5) -> list[dict]:
    """Find null-terminated regions that decode to plausible Japanese."""
    results = []
    i = 0

    while i < len(buf):
        # Skip non-SJIS-lead bytes
        if buf[i] not in SJIS_LEAD and buf[i] < 0x80:
            i += 1
            continue

        # Find next null
        end = buf.find(b"\x00", i)
        if end < 0:
            end = len(buf)
        if end - i < 6:  # too short for meaningful text
            i = end + 1
            continue

        region = buf[i:end]
        # Decode strictly
        try:
            text = region.decode("shift-jis", errors="strict")
        except (UnicodeDecodeError, LookupError):
            i = end + 1
            continue

        # Count hiragana/katakana (specific to Japanese, unlike kanji)
        kana = sum(1 for c in text if "ぁ" <= c <= "ゟ" or "ァ" <= c <= "ヿ")
        # Count common Japanese punctuation
        jp_punct = sum(1 for c in text if c in "、。！？…「」『』【】～・…")
        jp_chars = kana + jp_punct

        if jp_chars >= min_jp and len(text.strip()) >= 4:
            results.append({
                "offset": i,
                "size": len(region),
                "kana": kana,
                "punct": jp_punct,
                "text": text,
            })
        i = end + 1

    return results


def scan_sequences(buf: bytes, min_seq: int = 3, min_run: int = 12) -> list[dict]:
    """Scan for byte sequences that look like SJIS text regardless of null
    termination.  Many C++ string tables use different delimiters."""
    results = []
    i = 0

    while i < len(buf) - 1:
        b = buf[i]
        if b not in SJIS_LEAD:
            i += 1
            continue
        if buf[i + 1] not in SJIS_TRAIL:
            i += 1
            continue

        # Found a SJIS double-byte char.  Try to extend forward.
        start = i
        j = i + 2
        db_count = 1
        sb_count = 0

        while j < len(buf) - 1 and db_count < 2000:
            bj = buf[j]
            if bj == 0x00:
                break
            if bj in SJIS_LEAD and buf[j + 1] in SJIS_TRAIL:
                db_count += 1
                j += 2
            elif 0x09 <= bj <= 0x0D or 0x20 <= bj <= 0x7E:
                # ASCII (space, punctuation, alphanumeric)
                sb_count += 1
                j += 1
                if sb_count > db_count * 2:
                    break
            elif 0xA0 <= bj <= 0xDF:
                # Half-width kana
                sb_count += 1
                j += 1
            else:
                break

        if db_count >= min_run:
            region = buf[start:j]
            try:
                text = region.decode("shift-jis", errors="strict")
            except (UnicodeDecodeError, LookupError):
                i = start + 1
                continue

            # Require hiragana - binary data can accidentally match kanji bytes
            hiragana = sum(1 for c in text if "ぁ" <= c <= "ゟ")
            katakana = sum(1 for c in text if "ァ" <= c <= "ヿ")
            kana_total = hiragana + katakana

            if kana_total >= 3 and len(text.strip()) >= 8:
                results.append({
                    "offset": start,
                    "size": len(region),
                    "hiragana": hiragana,
                    "katakana": katakana,
                    "dbchars": db_count,
                    "text": text,
                })

        i = start + 1

    return results


def main():
    repo = Path(__file__).resolve().parents[1]
    out_dir = repo / "output"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "sjis_scan_results.txt"

    targets = [
        repo / "games" / "maya" / "player.exe",
        repo / "games" / "maya" / "libcocos2d.dll",
    ]

    with open(out_path, "w", encoding="utf-8") as out:
        for target in targets:
            if not target.exists():
                out.write(f"SKIP: {target.name} not found\n\n")
                continue

            buf = target.read_bytes()
            out.write(f"{'='*70}\n")
            out.write(f"File: {target.name} ({len(buf):,} bytes)\n")
            out.write(f"{'='*70}\n\n")

            # Method 1: null-delimited strings
            out.write("--- Null-delimited Shift-JIS strings ---\n")
            null_results = find_null_delimited_sjis_strings(buf, min_jp=5)
            null_results.sort(key=lambda r: -r["kana"])
            out.write(f"Found: {len(null_results)}\n")
            for r in null_results[:100]:
                clean = r["text"].replace("\n", "\\n").replace("\r", "\\r")
                out.write(f"  0x{r['offset']:06X} ({r['size']:4d}B, kana={r['kana']:2d}): {clean}\n")

            # Method 2: sequence scanning
            out.write("\n--- Sequence-based Shift-JIS regions ---\n")
            seq_results = scan_sequences(buf, min_seq=3, min_run=10)
            # Deduplicate
            seen = set()
            unique = []
            for r in seq_results:
                key = r["text"].strip()
                if key in seen or len(key) < 6:
                    continue
                seen.add(key)
                unique.append(r)
            unique.sort(key=lambda r: -r["hiragana"])
            out.write(f"Found: {len(unique)}\n")
            for r in unique[:200]:
                clean = r["text"].replace("\n", "\\n").replace("\r", "\\r")[:200]
                out.write(
                    f"  0x{r['offset']:06X} ({r['size']:4d}B, "
                    f"hira={r['hiragana']:3d} kata={r['katakana']:3d}): {clean}\n"
                )

            out.write("\n")

    print(f"Results written to {out_path}")


if __name__ == "__main__":
    main()
