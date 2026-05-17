import json

with open("output/dialogue_scan.json", "r", encoding="utf-8") as f:
    data = json.load(f)

utf8_texts = [r for r in data if r["encoding"] == "utf-8"]

skip_patterns = [
    "指摘", "ファイルスロット", "プレイヤー", "オブジェクト",
    "event", "Opening", "tachie", "tachi ", "���", "��`",
    "���`", "�ե", "�Υ��֥", "ָ��", "�ץ쥤",
    "ɸѡ", "�ı俪", "ִ�ж�", "�ݻٶ�"
]

dialogue = []
for r in utf8_texts:
    text = r["text"]
    if len(text) >= 15 and not any(p in text for p in skip_patterns):
        dialogue.append(r)

print(f"Potential dialogue texts: {len(dialogue)}")
for r in sorted(dialogue, key=lambda x: -len(x["text"]))[:30]:
    print(f"0x{r['address']:08X} ({len(r['text'])}c)")
    print(f"  {r['text'][:200]}")
    print()
