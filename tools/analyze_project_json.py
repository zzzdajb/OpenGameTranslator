"""
Deep scan of project.json to find dialogue text location.
Focus: action command structures, numeric arrays, and encoded data.
"""
import json
import sys
import os
import struct
from collections import defaultdict, Counter

INPUT = r"C:\Users\York\AppData\Local\player\OpenGameTranslator\output\opengametranslator-translated-project.json"
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "project_json_analysis.txt")

# Known dialogue phrases confirmed by user
KNOWN_PHRASES = [
    "それから", "定食屋", "記憶", "覚えていない",
    "午後", "仕事", "自宅", "頭を抱えて",
    "痴漢", "娘", "電車", "父親", "物語",
]

def safe_print(s):
    """Print avoiding GBK encoding errors on Windows."""
    try:
        print(s)
    except UnicodeEncodeError:
        print(s.encode('utf-8', errors='replace').decode('utf-8', errors='replace'))


def walk_all(data):
    """Walk the entire JSON tree and collect comprehensive stats."""
    stats = {
        'string_count': 0,
        'string_total_chars': 0,
        'string_len_dist': Counter(),
        'number_count': 0,
        'bool_count': 0,
        'null_count': 0,
        'list_count': 0,
        'dict_count': 0,
        'total_leaves': 0,
        'max_depth': 0,
        # Special fields
        'numeric_lists': [],      # Lists where all elements are numbers
        'jp_strings': [],         # Strings containing Japanese
        'long_strings': [],       # Strings > 500 chars
        'binary_strings': [],     # Strings with high non-printable ratio
        'action_like_dicts': [],  # Dicts that look like actions
    }

    def walk(v, depth, path):
        stats['max_depth'] = max(stats['max_depth'], depth)
        stats['total_leaves'] += 1

        if isinstance(v, dict):
            stats['dict_count'] += 1
            # Check if this looks like an action/command
            dict_keys = set(v.keys())
            action_keys = {'id', 'name', 'type', 'value', 'link', 'memo',
                          'children', 'folder', 'partType', 'layerIndex',
                          'visible', 'locked', 'priority', 'x', 'y'}
            if dict_keys & action_keys:
                stats['action_like_dicts'].append((path, len(v), sorted(dict_keys)[:15]))

            for k, val in v.items():
                walk(val, depth + 1, f"{path}.{k}")

        elif isinstance(v, list):
            stats['list_count'] += 1
            if len(v) > 0:
                # Check if it's a numeric list
                if all(isinstance(x, (int, float)) for x in v):
                    stats['numeric_lists'].append((path, len(v), v[:30]))

                # Sample elements
                sample_indices = [0]
                if len(v) > 1:
                    sample_indices.append(len(v) // 2)
                if len(v) > 2:
                    sample_indices.append(len(v) - 1)
                # For large lists, sample more
                if len(v) > 100:
                    sample_indices.append(len(v) // 4)
                    sample_indices.append(3 * len(v) // 4)

                for i in sample_indices:
                    if i < len(v):
                        walk(v[i], depth + 1, f"{path}[{i}]")

        elif isinstance(v, str):
            stats['string_count'] += 1
            stats['string_total_chars'] += len(v)
            stats['string_len_dist'][len(v)] += 1

            # Check for Japanese
            has_jp = any('぀' <= c <= 'ヿ' or '一' <= c <= '鿿' for c in v)
            if has_jp:
                stats['jp_strings'].append((path, len(v), v[:300]))

            if len(v) > 500:
                stats['long_strings'].append((path, len(v), v[:200]))

            # Check for binary-looking strings
            if len(v) > 50:
                printable = sum(1 for c in v if c.isprintable() or c in '\n\r\t')
                if len(v) > 0 and printable / len(v) < 0.3:
                    stats['binary_strings'].append((path, len(v), repr(v[:100])))

        elif isinstance(v, (int, float)):
            stats['number_count'] += 1
        elif isinstance(v, bool):
            stats['bool_count'] += 1
        elif v is None:
            stats['null_count'] += 1

    walk(data, 0, "root")
    return stats


def decode_numeric_lists(num_lists):
    """Try to decode each numeric list as text in various encodings."""
    results = []
    for path, arr_len, sample in num_lists:
        # Only try arrays that could plausibly be text (length 3+)
        if arr_len < 3:
            continue

        # Convert to ints
        ints = [int(x) for x in sample]

        findings = {}
        # Try byte-wise (if values fit in byte range)
        if all(0 <= x <= 255 for x in ints):
            byte_arr = bytes(ints)
            for enc in ('utf-8', 'shift-jis', 'utf-16le'):
                try:
                    text = byte_arr.decode(enc, errors='ignore')
                    printable = ''.join(c for c in text if c.isprintable() or c in '\n\r\t ')
                    # Check for Japanese
                    if any('぀' <= c <= 'ヿ' for c in printable):
                        findings[enc] = printable[:200]
                except Exception:
                    pass

        # Try as direct character codes (Unicode codepoints)
        try:
            chars = []
            for n in ints:
                if 0x3000 <= n <= 0x9fff:
                    chars.append(chr(n))
                elif 0x20 <= n <= 0x7e:
                    chars.append(chr(n))
            if chars:
                text = ''.join(chars)
                if any('぀' <= c <= 'ヿ' for c in text):
                    findings['unicode-codepoints'] = text[:200]
        except Exception:
            pass

        # Try Shift-JIS codepoint pairs (values 0x8140-0xeffc range)
        try:
            sjis_chars = []
            for n in ints:
                if 0x20 <= n <= 0x7e:
                    sjis_chars.append(chr(n))
                elif 0xa1 <= n <= 0xdf:
                    sjis_chars.append(chr(n))  # half-width kana range in SJIS
                elif 0x8140 <= n <= 0xeffc:
                    try:
                        b1 = (n >> 8) & 0xff
                        b2 = n & 0xff
                        sjis_chars.append(bytes([b1, b2]).decode('shift-jis', errors='replace'))
                    except Exception:
                        pass
            text = ''.join(sjis_chars)
            if any('぀' <= c <= 'ヿ' for c in text):
                findings['sjis-codepoint'] = text[:200]
        except Exception:
            pass

        if findings:
            results.append((path, arr_len, findings))

    return results


def analyze_action_params(stats):
    """Analyze dicts that look like actions to find text parameters."""
    # Group action-like dicts by their key sets
    key_set_groups = defaultdict(list)
    for path, size, keys in stats['action_like_dicts']:
        key_tuple = tuple(sorted(keys))
        key_set_groups[key_tuple].append(path)

    return key_set_groups


def search_encoded_phrases(data):
    """Search the raw JSON text for known phrases encoded in various ways."""
    results = []

    with open(INPUT, 'r', encoding='utf-8') as f:
        raw = f.read()

    for phrase in KNOWN_PHRASES:
        # Check raw presence
        if phrase in raw:
            results.append(('raw-japanese', phrase, 'found in JSON text'))

        # Check UTF-8 bytes as JSON array
        utf8_bytes = list(phrase.encode('utf-8'))
        utf8_str = json.dumps(utf8_bytes)
        # Check if the byte sequence appears in the raw text
        # (unlikely for 20+ byte sequences but worth checking)

        # Check Shift-JIS encoding
        try:
            sjis_bytes = list(phrase.encode('shift-jis'))
        except Exception:
            sjis_bytes = None

        # Check for the phrase encoded as \uXXXX sequences
        unicode_escaped = ''.join(f'\\u{ord(c):04x}' for c in phrase)
        # Not practical to search in 85MB file

    return results


def main():
    safe_print(f"Loading {INPUT}...")
    with open(INPUT, 'r', encoding='utf-8') as f:
        data = json.load(f)

    safe_print("\n" + "=" * 70)
    safe_print("1. COMPREHENSIVE TREE WALK")
    safe_print("=" * 70)
    stats = walk_all(data)

    safe_print(f"  Total leaves visited: {stats['total_leaves']}")
    safe_print(f"  Max depth: {stats['max_depth']}")
    safe_print(f"  Strings: {stats['string_count']} (total chars: {stats['string_total_chars']})")
    safe_print(f"  Numbers: {stats['number_count']}")
    safe_print(f"  Booleans: {stats['bool_count']}")
    safe_print(f"  Nulls: {stats['null_count']}")
    safe_print(f"  Arrays: {stats['list_count']}")
    safe_print(f"  Objects: {stats['dict_count']}")
    safe_print(f"  Numeric arrays: {len(stats['numeric_lists'])}")
    safe_print(f"  Japanese strings: {len(stats['jp_strings'])}")
    safe_print(f"  Long strings (>500): {len(stats['long_strings'])}")
    safe_print(f"  Binary-looking strings: {len(stats['binary_strings'])}")
    safe_print(f"  Action-like dicts: {len(stats['action_like_dicts'])}")

    safe_print(f"\n  String length distribution (top 30):")
    for slen, count in stats['string_len_dist'].most_common(30):
        safe_print(f"    len={slen}: {count}")

    safe_print(f"\n  Numeric array size distribution:")
    sizes = Counter()
    for _, arr_len, _ in stats['numeric_lists']:
        sizes[arr_len] += 1
    for s, c in sizes.most_common(20):
        safe_print(f"    size={s}: {c}")

    # Write full results to file to avoid GBK issues
    safe_print(f"\n  Writing detailed results to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as out:
        out.write("JAPANESE STRINGS\n")
        out.write("=" * 70 + "\n")
        for path, slen, preview in stats['jp_strings']:
            out.write(f"\n  [{slen}] {path}:\n    {preview}\n")

        out.write("\n\nLONG STRINGS\n")
        out.write("=" * 70 + "\n")
        for path, slen, preview in stats['long_strings']:
            out.write(f"\n  [{slen}] {path}:\n    {preview}\n")

        out.write("\n\nNUMERIC ARRAYS\n")
        out.write("=" * 70 + "\n")
        for path, arr_len, sample in stats['numeric_lists']:
            out.write(f"\n  [{arr_len}] {path}:\n    sample={sample}\n")

        out.write("\n\nBINARY-LOOKING STRINGS\n")
        out.write("=" * 70 + "\n")
        for path, slen, preview in stats['binary_strings']:
            out.write(f"\n  [{slen}] {path}:\n    {preview}\n")

    safe_print("  Done.")

    safe_print("\n" + "=" * 70)
    safe_print("2. DECODE NUMERIC ARRAYS AS TEXT")
    safe_print("=" * 70)
    decoded = decode_numeric_lists(stats['numeric_lists'])
    safe_print(f"  Arrays that decode to Japanese: {len(decoded)}")
    for path, arr_len, findings in decoded[:20]:
        safe_print(f"  [{arr_len}] {path}:")
        for enc, text in findings.items():
            safe_print(f"    {enc}: {text[:200]}")

    safe_print("\n" + "=" * 70)
    safe_print("3. ACTION-LIKE DICT KEY SETS (top patterns)")
    safe_print("=" * 70)
    key_groups = analyze_action_params(stats)
    for key_set, paths in sorted(key_groups.items(), key=lambda x: -len(x[1]))[:20]:
        safe_print(f"  {len(paths)}x: {list(key_set)[:12]}")

    safe_print("\n" + "=" * 70)
    safe_print("4. KNOWN PHRASE SEARCH")
    safe_print("=" * 70)
    phrase_results = search_encoded_phrases(data)
    if phrase_results:
        for method, phrase, note in phrase_results:
            safe_print(f"  {method}: '{phrase}' - {note}")
    else:
        safe_print("  No known phrases found in any encoding")

    safe_print("\nDone.")


if __name__ == '__main__':
    main()
