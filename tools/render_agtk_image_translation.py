# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=12.0.0"]
# ///
"""Render translated text back into AGTK/Cocos pre-rendered dialogue images.

This is intentionally a small production prototype:

1. `make-template` scans one decrypted dialogue PNG and writes a CSV template.
2. `render` reads translations from CSV and writes replacement PNGs.

The CSV keeps text separate from image layout. LLM translation only needs to fill
the `translation` column; this script owns where and how the text is drawn.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont


DEFAULT_COLUMNS = 2
DEFAULT_ROWS = 15
DEFAULT_FRAME_WIDTH = 900
DEFAULT_FRAME_HEIGHT = 160
DEFAULT_FONT_SIZE = 28
MIN_FONT_SIZE = 16
LINE_SPACING = 6
TEXT_MARGIN_X = 28
TEXT_MARGIN_Y = 14
CSV_FIELDNAMES = [
    "image_id",
    "frame_index",
    "source",
    "translation",
    "notes",
]

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
]


@dataclass(frozen=True)
class FrameLayout:
    image_id: str
    frame_index: int
    x: int
    y: int
    width: int
    height: int
    text_bbox: tuple[int, int, int, int] | None


@dataclass(frozen=True)
class TranslationRow:
    image_id: str
    frame_index: int
    source: str
    translation: str
    notes: str


@dataclass(frozen=True)
class RenderedFrameResult:
    image_id: str
    frame_index: int
    output_path: str
    overflow: bool
    font_size: int
    line_count: int
    source: str
    translation: str
    notes: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create CSV templates and replacement PNGs for AGTK image dialogue."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    template_parser = subparsers.add_parser(
        "make-template", help="Create a CSV template for one decrypted PNG."
    )
    template_parser.add_argument("--image", required=True, type=Path)
    template_parser.add_argument("--output-csv", required=True, type=Path)
    template_parser.add_argument("--columns", type=int, default=DEFAULT_COLUMNS)
    template_parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    template_parser.add_argument(
        "--demo-text",
        default="",
        help="Optional test translation, supports {image_id} and {frame_index}.",
    )

    batch_parser = subparsers.add_parser(
        "prepare-batch",
        help="Create one CSV and frame previews for a range of decrypted PNGs.",
    )
    batch_parser.add_argument("--decrypted-dir", required=True, type=Path)
    batch_parser.add_argument("--output-csv", required=True, type=Path)
    batch_parser.add_argument("--preview-dir", required=True, type=Path)
    batch_parser.add_argument("--start-image-id", required=True, type=int)
    batch_parser.add_argument("--end-image-id", required=True, type=int)
    batch_parser.add_argument("--columns", type=int, default=DEFAULT_COLUMNS)
    batch_parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    batch_parser.add_argument(
        "--include-empty",
        action="store_true",
        help="Also include frames where no bright text pixels were detected.",
    )
    batch_parser.add_argument(
        "--demo-text",
        default="",
        help="Optional test translation, supports {image_id} and {frame_index}.",
    )
    batch_parser.add_argument(
        "--summary-json",
        type=Path,
        default=None,
        help="Optional JSON summary path for generated rows and previews.",
    )

    render_parser = subparsers.add_parser(
        "render", help="Render translated CSV rows into replacement PNGs."
    )
    render_parser.add_argument("--csv", required=True, type=Path)
    render_parser.add_argument("--decrypted-dir", required=True, type=Path)
    render_parser.add_argument("--output-dir", required=True, type=Path)
    render_parser.add_argument("--font", type=Path, default=None)
    render_parser.add_argument("--font-size", type=int, default=DEFAULT_FONT_SIZE)
    render_parser.add_argument("--columns", type=int, default=DEFAULT_COLUMNS)
    render_parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    render_parser.add_argument(
        "--image-id",
        default="",
        help="Render only one image id. If omitted, all image ids in the CSV are rendered.",
    )
    render_parser.add_argument(
        "--backup-existing",
        action="store_true",
        help="Before overwriting output PNGs, copy existing files to *.bak.png.",
    )
    render_parser.add_argument(
        "--overflow-report",
        type=Path,
        default=None,
        help="Optional CSV report path for rows that did not fit.",
    )

    return parser.parse_args()


def image_id_from_path(image_path: Path) -> str:
    return image_path.stem


def frame_layouts(
    image_id: str,
    image: Image.Image,
    columns: int,
    rows: int,
) -> list[FrameLayout]:
    frame_width = image.width // columns
    frame_height = image.height // rows
    layouts: list[FrameLayout] = []

    for index in range(columns * rows):
        col = index % columns
        row = index // columns
        x = col * frame_width
        y = row * frame_height
        crop = image.crop((x, y, x + frame_width, y + frame_height))
        bbox = detect_bright_bbox(crop)
        if bbox is not None:
            bbox = (
                x + bbox[0],
                y + bbox[1],
                x + bbox[2],
                y + bbox[3],
            )
        layouts.append(
            FrameLayout(
                image_id=image_id,
                frame_index=index,
                x=x,
                y=y,
                width=frame_width,
                height=frame_height,
                text_bbox=bbox,
            )
        )

    return layouts


def detect_bright_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    """Find the visible text area in black-background dialogue cells."""
    gray = image.convert("L")
    pixels = gray.load()
    min_x = image.width
    min_y = image.height
    max_x = -1
    max_y = -1

    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y] > 32:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x < 0:
        return None

    return (min_x, min_y, max_x + 1, max_y + 1)


def write_template_csv(
    image_path: Path,
    output_csv: Path,
    columns: int,
    rows: int,
    demo_text: str,
) -> None:
    image = Image.open(image_path)
    image_id = image_id_from_path(image_path)
    csv_rows = template_rows_for_image(
        image_id=image_id,
        image=image,
        columns=columns,
        rows=rows,
        include_empty=False,
        demo_text=demo_text,
    )

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        writer.writerows(csv_rows)


def template_rows_for_image(
    image_id: str,
    image: Image.Image,
    columns: int,
    rows: int,
    include_empty: bool,
    demo_text: str,
) -> list[dict[str, str | int]]:
    csv_rows: list[dict[str, str | int]] = []
    for layout in frame_layouts(image_id, image, columns, rows):
        if layout.text_bbox is None and not include_empty:
            continue
        csv_rows.append(
            {
                "image_id": layout.image_id,
                "frame_index": layout.frame_index,
                "source": "",
                "translation": format_demo_text(
                    demo_text, layout.image_id, layout.frame_index
                ),
                "notes": "",
            }
        )
    return csv_rows


def format_demo_text(demo_text: str, image_id: str, frame_index: int) -> str:
    if not demo_text:
        return ""
    return demo_text.format(image_id=image_id, frame_index=frame_index)


def save_frame_preview(
    image: Image.Image,
    layout: FrameLayout,
    preview_dir: Path,
) -> Path:
    image_dir = preview_dir / layout.image_id
    image_dir.mkdir(parents=True, exist_ok=True)
    output_path = image_dir / f"{layout.frame_index:02d}.png"
    crop = image.crop(
        (
            layout.x,
            layout.y,
            layout.x + layout.width,
            layout.y + layout.height,
        )
    )
    crop.save(output_path)
    return output_path


def prepare_batch(args: argparse.Namespace) -> None:
    if args.start_image_id > args.end_image_id:
        raise SystemExit("--start-image-id must be <= --end-image-id")

    all_rows: list[dict[str, str | int]] = []
    summary: dict[str, object] = {
        "formatVersion": 1,
        "decryptedDir": str(args.decrypted_dir),
        "outputCsv": str(args.output_csv),
        "previewDir": str(args.preview_dir),
        "startImageId": args.start_image_id,
        "endImageId": args.end_image_id,
        "images": [],
        "missingImages": [],
    }
    image_summaries: list[dict[str, object]] = []
    missing_images: list[str] = []

    args.preview_dir.mkdir(parents=True, exist_ok=True)
    for image_number in range(args.start_image_id, args.end_image_id + 1):
        image_id = str(image_number)
        image_path = args.decrypted_dir / f"{image_id}.png"
        if not image_path.exists():
            missing_images.append(image_id)
            continue

        image = Image.open(image_path)
        layouts = frame_layouts(image_id, image, args.columns, args.rows)
        text_layouts = [
            layout
            for layout in layouts
            if layout.text_bbox is not None or args.include_empty
        ]

        for layout in text_layouts:
            save_frame_preview(image, layout, args.preview_dir)

        rows = template_rows_for_image(
            image_id=image_id,
            image=image,
            columns=args.columns,
            rows=args.rows,
            include_empty=args.include_empty,
            demo_text=args.demo_text,
        )
        all_rows.extend(rows)
        image_summaries.append(
            {
                "imageId": image_id,
                "sourcePath": str(image_path),
                "frameCount": len(layouts),
                "textFrameCount": len(text_layouts),
                "previewDir": str(args.preview_dir / image_id),
            }
        )

    args.output_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.output_csv.open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        writer.writerows(all_rows)

    summary["images"] = image_summaries
    summary["missingImages"] = missing_images
    summary["rowCount"] = len(all_rows)
    summary["imageCount"] = len(image_summaries)
    if args.summary_json is not None:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    print(
        f"Prepared {len(all_rows)} rows from {len(image_summaries)} images -> "
        f"{args.output_csv}"
    )
    print(f"Frame previews -> {args.preview_dir}")
    if missing_images:
        print(f"Missing images: {', '.join(missing_images)}")


def read_translation_rows(csv_path: Path) -> list[TranslationRow]:
    with csv_path.open("r", newline="", encoding="utf-8-sig") as fp:
        reader = csv.DictReader(fp)
        rows: list[TranslationRow] = []
        for raw in reader:
            translation = (raw.get("translation") or "").strip()
            if not translation:
                continue
            rows.append(
                TranslationRow(
                    image_id=(raw.get("image_id") or "").strip(),
                    frame_index=int((raw.get("frame_index") or "0").strip()),
                    source=raw.get("source") or "",
                    translation=translation,
                    notes=raw.get("notes") or "",
                )
            )
    return rows


def load_font(font_path: Path | None, size: int) -> ImageFont.FreeTypeFont:
    path = font_path or first_existing_font()
    if path is None:
        raise SystemExit(
            "No CJK font found. Pass --font /path/to/font.ttf or install a CJK font."
        )
    return ImageFont.truetype(str(path), size=size)


def first_existing_font() -> Path | None:
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            return path
    return None


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    """Wrap CJK text by measured pixel width.

    This simple approach is deliberate: most translated dialogue is Chinese text,
    where character-by-character wrapping is predictable enough for a prototype.
    """
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        current = ""
        for char in paragraph:
            candidate = current + char
            bbox = draw.textbbox((0, 0), candidate, font=font)
            if current and (bbox[2] - bbox[0]) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        lines.append(current)
    return lines


def text_block_size(
    draw: ImageDraw.ImageDraw,
    lines: Iterable[str],
    font: ImageFont.FreeTypeFont,
) -> tuple[int, int]:
    width = 0
    height = 0
    line_count = 0
    for line in lines:
        bbox = draw.textbbox((0, 0), line or " ", font=font)
        width = max(width, bbox[2] - bbox[0])
        height += bbox[3] - bbox[1]
        line_count += 1
    if line_count > 1:
        height += LINE_SPACING * (line_count - 1)
    return width, height


def fit_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    max_width: int,
    max_height: int,
    font_path: Path | None,
    preferred_size: int,
) -> tuple[ImageFont.FreeTypeFont, list[str], bool, int]:
    for size in range(preferred_size, MIN_FONT_SIZE - 1, -1):
        font = load_font(font_path, size)
        lines = wrap_text(draw, text, font, max_width)
        _, height = text_block_size(draw, lines, font)
        if height <= max_height:
            return font, lines, False, size

    font = load_font(font_path, MIN_FONT_SIZE)
    return font, wrap_text(draw, text, font, max_width), True, MIN_FONT_SIZE


def render_image(
    image_id: str,
    rows: list[TranslationRow],
    decrypted_dir: Path,
    output_dir: Path,
    font_path: Path | None,
    preferred_font_size: int,
    columns: int,
    table_rows: int,
    backup_existing: bool,
) -> tuple[Path, list[RenderedFrameResult]]:
    source_path = decrypted_dir / f"{image_id}.png"
    if not source_path.exists():
        raise SystemExit(f"Missing decrypted image: {source_path}")

    image = Image.open(source_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    layouts = {
        layout.frame_index: layout
        for layout in frame_layouts(image_id, image, columns, table_rows)
    }
    results: list[RenderedFrameResult] = []

    for row in rows:
        layout = layouts.get(row.frame_index)
        if layout is None:
            raise SystemExit(f"Frame index out of range: {row.frame_index}")

        # Clear the whole dialogue cell. For Maya's dialogue sheets the cell
        # background is black, so this avoids ghosting from the original glyphs.
        clear_box = (
            layout.x,
            layout.y,
            layout.x + layout.width,
            layout.y + layout.height,
        )
        draw.rectangle(clear_box, fill=(0, 0, 0))

        text_x = layout.x + TEXT_MARGIN_X
        text_y = layout.y + TEXT_MARGIN_Y
        max_width = layout.width - TEXT_MARGIN_X * 2
        max_height = layout.height - TEXT_MARGIN_Y * 2

        font, lines, overflow, used_font_size = fit_text(
            draw,
            row.translation,
            max_width,
            max_height,
            font_path,
            preferred_font_size,
        )
        draw_multiline(draw, (text_x, text_y), lines, font)

        if overflow:
            mark_overflow(draw, layout)
        results.append(
            RenderedFrameResult(
                image_id=row.image_id,
                frame_index=row.frame_index,
                output_path=str(output_dir / f"{image_id}.png"),
                overflow=overflow,
                font_size=used_font_size,
                line_count=len(lines),
                source=row.source,
                translation=row.translation,
                notes=row.notes,
            )
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{image_id}.png"
    if backup_existing and output_path.exists():
        backup_path = output_path.with_name(f"{output_path.stem}.bak.png")
        if not backup_path.exists():
            shutil.copy2(output_path, backup_path)
    # Convert back to palette mode to match original asset format.
    # The game expects paletted (P) images; RGB images cause crashes in
    # touch/H-scene rendering paths that manipulate the palette.
    image_p = image.convert("P", palette=Image.ADAPTIVE, colors=2)
    image_p.save(output_path, optimize=True)
    return output_path, results


def draw_multiline(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    lines: list[str],
    font: ImageFont.FreeTypeFont,
) -> None:
    x, y = position
    for line in lines:
        bbox = draw.textbbox((x, y), line or " ", font=font)
        draw.text((x, y), line, fill=(255, 255, 255), font=font)
        y += (bbox[3] - bbox[1]) + LINE_SPACING


def mark_overflow(draw: ImageDraw.ImageDraw, layout: FrameLayout) -> None:
    # Red outline means the translation did not fit at the minimum font size.
    draw.rectangle(
        (
            layout.x + 2,
            layout.y + 2,
            layout.x + layout.width - 3,
            layout.y + layout.height - 3,
        ),
        outline=(255, 0, 0),
        width=3,
    )


def render_from_csv(args: argparse.Namespace) -> None:
    rows = read_translation_rows(args.csv)
    if args.image_id:
        rows = [row for row in rows if row.image_id == args.image_id]

    rows_by_image: dict[str, list[TranslationRow]] = {}
    for row in rows:
        rows_by_image.setdefault(row.image_id, []).append(row)

    if not rows_by_image:
        raise SystemExit("No rows with non-empty translation were found.")

    all_results: list[RenderedFrameResult] = []
    for image_id, image_rows in sorted(rows_by_image.items(), key=lambda item: image_sort_key(item[0])):
        output_path, image_results = render_image(
            image_id=image_id,
            rows=image_rows,
            decrypted_dir=args.decrypted_dir,
            output_dir=args.output_dir,
            font_path=args.font,
            preferred_font_size=args.font_size,
            columns=args.columns,
            table_rows=args.rows,
            backup_existing=args.backup_existing,
        )
        all_results.extend(image_results)
        print(f"Rendered {len(image_rows)} rows -> {output_path}")

    if args.overflow_report is not None:
        write_overflow_report(args.overflow_report, all_results)
        overflow_count = sum(1 for result in all_results if result.overflow)
        print(f"Overflow report: {overflow_count} rows -> {args.overflow_report}")


def image_sort_key(image_id: str) -> tuple[int, str]:
    try:
        return (int(image_id), image_id)
    except ValueError:
        return (10**9, image_id)


def write_overflow_report(
    report_path: Path,
    results: list[RenderedFrameResult],
) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(
            fp,
            fieldnames=[
                "image_id",
                "frame_index",
                "font_size",
                "line_count",
                "source",
                "translation",
                "notes",
            ],
        )
        writer.writeheader()
        for result in results:
            if not result.overflow:
                continue
            writer.writerow(
                {
                    "image_id": result.image_id,
                    "frame_index": result.frame_index,
                    "font_size": result.font_size,
                    "line_count": result.line_count,
                    "source": result.source,
                    "translation": result.translation,
                    "notes": result.notes,
                }
            )


def main() -> None:
    args = parse_args()
    if args.command == "make-template":
        write_template_csv(
            image_path=args.image,
            output_csv=args.output_csv,
            columns=args.columns,
            rows=args.rows,
            demo_text=args.demo_text,
        )
        print(f"Wrote CSV template: {args.output_csv}")
    elif args.command == "prepare-batch":
        prepare_batch(args)
    elif args.command == "render":
        render_from_csv(args)


if __name__ == "__main__":
    main()
