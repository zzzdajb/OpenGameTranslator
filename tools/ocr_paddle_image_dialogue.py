# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.32.0", "pillow>=12.0.0"]
# ///
"""Fill AGTK image-dialogue CSV sources with PaddleOCR online results.

The script uploads full 1800x2400 dialogue sheets, then maps OCR text lines back
to 2x15 frame cells by polygon coordinates. It keeps the API token outside the
repo: set PADDLEOCR_TOKEN in the environment before running.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests
from PIL import Image


JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
MODEL = "PP-OCRv5"
DEFAULT_COLUMNS = 2
DEFAULT_ROWS = 15
CSV_FIELDNAMES = [
    "image_id",
    "frame_index",
    "source",
    "translation",
    "notes",
]


@dataclass(frozen=True)
class OcrTextLine:
    text: str
    bbox: tuple[float, float, float, float]
    score: float | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run PaddleOCR on decrypted dialogue sheets and fill CSV source text."
    )
    parser.add_argument("--input-csv", required=True, type=Path)
    parser.add_argument("--output-csv", required=True, type=Path)
    parser.add_argument("--sheet-dir", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--start-image-id", type=int, default=None)
    parser.add_argument("--end-image-id", type=int, default=None)
    parser.add_argument("--image-id", action="append", default=[])
    parser.add_argument("--columns", type=int, default=DEFAULT_COLUMNS)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--request-timeout", type=float, default=60.0)
    parser.add_argument(
        "--overwrite-source",
        action="store_true",
        help="Replace existing source values. By default only empty source cells are filled.",
    )
    parser.add_argument(
        "--limit-images",
        type=int,
        default=0,
        help="For smoke tests: process only the first N selected image ids.",
    )
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=None,
        help="Optional JSON summary path.",
    )
    return parser.parse_args()


def read_csv_rows(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open("r", newline="", encoding="utf-8-sig") as fp:
        return [dict(row) for row in csv.DictReader(fp)]


def write_csv_rows(csv_path: Path, rows: list[dict[str, str]]) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in CSV_FIELDNAMES})


def selected_image_ids(rows: list[dict[str, str]], args: argparse.Namespace) -> list[str]:
    ids = sorted({row["image_id"] for row in rows}, key=image_sort_key)
    if args.image_id:
        allowed = set(args.image_id)
        ids = [image_id for image_id in ids if image_id in allowed]
    if args.start_image_id is not None:
        ids = [image_id for image_id in ids if int(image_id) >= args.start_image_id]
    if args.end_image_id is not None:
        ids = [image_id for image_id in ids if int(image_id) <= args.end_image_id]
    if args.limit_images > 0:
        ids = ids[: args.limit_images]
    return ids


def image_sort_key(image_id: str) -> tuple[int, str]:
    try:
        return (int(image_id), image_id)
    except ValueError:
        return (10**9, image_id)


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"bearer {token}"}


def submit_ocr_job(
    image_path: Path,
    token: str,
    model: str,
    request_timeout: float,
) -> str:
    optional_payload = {
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useTextlineOrientation": False,
    }
    data = {
        "model": model,
        "optionalPayload": json.dumps(optional_payload),
    }
    with image_path.open("rb") as fp:
        response = requests.post(
            JOB_URL,
            headers=auth_headers(token),
            data=data,
            files={"file": fp},
            timeout=request_timeout,
        )
    if response.status_code != 200:
        raise RuntimeError(f"OCR submit failed for {image_path}: {response.text}")
    return response.json()["data"]["jobId"]


def wait_for_job(
    job_id: str,
    token: str,
    poll_seconds: float,
    request_timeout: float,
) -> str:
    while True:
        response = requests.get(
            f"{JOB_URL}/{job_id}",
            headers=auth_headers(token),
            timeout=request_timeout,
        )
        if response.status_code != 200:
            raise RuntimeError(f"OCR poll failed for {job_id}: {response.text}")
        data = response.json()["data"]
        state = data["state"]
        if state == "done":
            return data["resultUrl"]["jsonUrl"]
        if state == "failed":
            raise RuntimeError(f"OCR job failed for {job_id}: {data.get('errorMsg')}")
        time.sleep(poll_seconds)


def download_jsonl(jsonl_url: str, request_timeout: float) -> str:
    response = requests.get(jsonl_url, timeout=request_timeout)
    response.raise_for_status()
    return response.text


def cached_or_run_ocr(
    image_id: str,
    image_path: Path,
    cache_dir: Path,
    token: str,
    args: argparse.Namespace,
) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = cache_dir / f"{image_id}.jsonl"
    if jsonl_path.exists():
        return jsonl_path.read_text(encoding="utf-8")

    print(f"OCR submit image {image_id}: {image_path}")
    job_id = submit_ocr_job(
        image_path=image_path,
        token=token,
        model=args.model,
        request_timeout=args.request_timeout,
    )
    print(f"OCR job {image_id}: {job_id}")
    jsonl_url = wait_for_job(
        job_id=job_id,
        token=token,
        poll_seconds=args.poll_seconds,
        request_timeout=args.request_timeout,
    )
    jsonl_text = download_jsonl(jsonl_url, request_timeout=args.request_timeout)
    jsonl_path.write_text(jsonl_text, encoding="utf-8")
    return jsonl_text


def parse_jsonl_text_lines(jsonl_text: str) -> list[OcrTextLine]:
    lines: list[OcrTextLine] = []
    seen: set[tuple[str, tuple[int, int, int, int]]] = set()
    for raw_line in jsonl_text.splitlines():
        if not raw_line.strip():
            continue
        payload = json.loads(raw_line)
        for line in find_ocr_lines(payload):
            key = (
                line.text,
                tuple(round(value) for value in line.bbox),
            )
            if key in seen:
                continue
            seen.add(key)
            lines.append(line)
    return lines


def find_ocr_lines(value: Any) -> Iterable[OcrTextLine]:
    if isinstance(value, dict):
        array_lines = lines_from_parallel_arrays(value)
        if array_lines:
            yield from array_lines
            return

        direct_line = line_from_direct_object(value)
        if direct_line is not None:
            yield direct_line

        for child in value.values():
            yield from find_ocr_lines(child)
    elif isinstance(value, list):
        for child in value:
            yield from find_ocr_lines(child)


def lines_from_parallel_arrays(value: dict[str, Any]) -> list[OcrTextLine]:
    text_values = first_list(value, ["recTexts", "rec_texts", "texts", "text"])
    poly_values = first_list(
        value,
        [
            "recPolys",
            "rec_polys",
            "dtPolys",
            "dt_polys",
            "boxes",
            "polygons",
        ],
    )
    score_values = first_list(value, ["recScores", "rec_scores", "scores"])
    if not text_values or not poly_values or len(text_values) != len(poly_values):
        return []

    lines: list[OcrTextLine] = []
    for index, text_value in enumerate(text_values):
        text = str(text_value).strip()
        if not text:
            continue
        bbox = polygon_to_bbox(poly_values[index])
        if bbox is None:
            continue
        score = None
        if score_values and index < len(score_values):
            try:
                score = float(score_values[index])
            except (TypeError, ValueError):
                score = None
        lines.append(OcrTextLine(text=text, bbox=bbox, score=score))
    return lines


def first_list(value: dict[str, Any], keys: list[str]) -> list[Any] | None:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return None


def line_from_direct_object(value: dict[str, Any]) -> OcrTextLine | None:
    text = value.get("text") or value.get("transcription") or value.get("recText")
    polygon = (
        value.get("polygon")
        or value.get("poly")
        or value.get("points")
        or value.get("box")
        or value.get("bbox")
    )
    if text is None or polygon is None:
        return None
    bbox = polygon_to_bbox(polygon)
    if bbox is None:
        return None
    score = value.get("score") or value.get("confidence") or value.get("recScore")
    try:
        parsed_score = None if score is None else float(score)
    except (TypeError, ValueError):
        parsed_score = None
    return OcrTextLine(text=str(text).strip(), bbox=bbox, score=parsed_score)


def polygon_to_bbox(polygon: Any) -> tuple[float, float, float, float] | None:
    points = flatten_points(polygon)
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def flatten_points(value: Any) -> list[tuple[float, float]]:
    if (
        isinstance(value, list)
        and len(value) == 4
        and all(is_number(item) for item in value)
    ):
        x1, y1, x2, y2 = [float(item) for item in value]
        return [(x1, y1), (x2, y2)]

    if isinstance(value, list):
        if value and all(isinstance(item, list) and len(item) >= 2 for item in value):
            points: list[tuple[float, float]] = []
            for item in value:
                if is_number(item[0]) and is_number(item[1]):
                    points.append((float(item[0]), float(item[1])))
            if points:
                return points
        if value and all(is_number(item) for item in value) and len(value) % 2 == 0:
            numbers = [float(item) for item in value]
            return list(zip(numbers[0::2], numbers[1::2]))
    return []


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def map_lines_to_frames(
    lines: list[OcrTextLine],
    image_width: int,
    image_height: int,
    columns: int,
    rows: int,
) -> dict[int, list[OcrTextLine]]:
    frame_width = image_width / columns
    frame_height = image_height / rows
    frames: dict[int, list[OcrTextLine]] = {}
    for line in lines:
        x1, y1, x2, y2 = line.bbox
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        col = min(columns - 1, max(0, int(center_x // frame_width)))
        row = min(rows - 1, max(0, int(center_y // frame_height)))
        frame_index = row * columns + col
        frames.setdefault(frame_index, []).append(line)
    return frames


def join_frame_text(lines: list[OcrTextLine]) -> str:
    sorted_lines = sorted(lines, key=lambda line: (line.bbox[1], line.bbox[0]))
    return "\n".join(line.text for line in sorted_lines if line.text.strip())


def main() -> None:
    args = parse_args()
    token = os.environ.get("PADDLEOCR_TOKEN")
    if not token:
        print("PADDLEOCR_TOKEN is not set.", file=sys.stderr)
        sys.exit(2)

    rows = read_csv_rows(args.input_csv)
    ids = selected_image_ids(rows, args)
    if not ids:
        raise SystemExit("No image ids selected.")

    source_by_key: dict[tuple[str, str], str] = {}
    summary_images: list[dict[str, Any]] = []
    for image_id in ids:
        image_path = args.sheet_dir / f"{image_id}.png"
        if not image_path.exists():
            raise SystemExit(f"Missing image sheet: {image_path}")
        with Image.open(image_path) as image:
            image_width, image_height = image.size

        jsonl_text = cached_or_run_ocr(
            image_id=image_id,
            image_path=image_path,
            cache_dir=args.cache_dir,
            token=token,
            args=args,
        )
        ocr_lines = parse_jsonl_text_lines(jsonl_text)
        frames = map_lines_to_frames(
            lines=ocr_lines,
            image_width=image_width,
            image_height=image_height,
            columns=args.columns,
            rows=args.rows,
        )
        for frame_index, frame_lines in frames.items():
            source_by_key[(image_id, str(frame_index))] = join_frame_text(frame_lines)
        summary_images.append(
            {
                "imageId": image_id,
                "ocrLineCount": len(ocr_lines),
                "filledFrameCount": len(frames),
                "cachePath": str(args.cache_dir / f"{image_id}.jsonl"),
            }
        )
        print(
            f"OCR parsed {image_id}: {len(ocr_lines)} text lines, "
            f"{len(frames)} frames"
        )

    filled_count = 0
    for row in rows:
        key = (row.get("image_id", ""), row.get("frame_index", ""))
        source = source_by_key.get(key)
        if source is None:
            continue
        if row.get("source") and not args.overwrite_source:
            continue
        row["source"] = source
        filled_count += 1

    write_csv_rows(args.output_csv, rows)
    print(f"Filled {filled_count} source cells -> {args.output_csv}")

    if args.summary_json is not None:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(
            json.dumps(
                {
                    "formatVersion": 1,
                    "inputCsv": str(args.input_csv),
                    "outputCsv": str(args.output_csv),
                    "sheetDir": str(args.sheet_dir),
                    "cacheDir": str(args.cache_dir),
                    "imageCount": len(ids),
                    "filledSourceCount": filled_count,
                    "images": summary_images,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
