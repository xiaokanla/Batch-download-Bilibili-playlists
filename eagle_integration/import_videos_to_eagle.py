#!/usr/bin/env python3
"""Prepare local Bilibili videos for Eagle.

Default workflow:
- Keep the original video file unchanged.
- Generate a random-frame contact sheet PNG for each matched video.
- Write an Eagle import manifest that imports the original video and records the
  generated contact sheet path for the later "set custom thumbnail" experiment.

Eagle's public API currently has no "set thumbnail image" parameter for videos,
so this script does not pretend to solve that final step. It prepares the data
we need without damaging the video.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

import requests
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

from export_to_eagle import (
    BILI_REFERER,
    EAGLE_API,
    EXPORT_DIR,
    USER_AGENT,
    VideoItem,
    build_annotation,
    clean_filename,
    configure_console,
    dedupe_videos,
    download_cover,
    import_to_eagle,
    videos_from_cache,
    videos_from_cache_dir,
    videos_from_state,
)


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
VIDEO_MANIFEST_PATH = EXPORT_DIR / "video_manifest.json"
CONTACT_SHEET_DIR = EXPORT_DIR / "contact_sheets"
DANMAKU_CACHE_DIR = EXPORT_DIR / "danmaku_cache"
VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".flv", ".mov", ".m4v"}


def subprocess_no_window_kwargs() -> dict:
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": startupinfo,
    }


def find_ffmpeg() -> str:
    configured = os.environ.get("BILI_FFMPEG_PATH", "")
    if configured and Path(configured).exists():
        return configured
    local = PROJECT_ROOT / "ffmpeg.exe"
    if local.exists():
        return str(local)
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise RuntimeError("ffmpeg not found; put ffmpeg.exe in project root or install ffmpeg")


def find_ffprobe() -> str | None:
    configured = os.environ.get("BILI_FFPROBE_PATH", "")
    if configured and Path(configured).exists():
        return configured
    local = PROJECT_ROOT / "ffprobe.exe"
    if local.exists():
        return str(local)
    return shutil.which("ffprobe")


def normalize_text(value: str) -> str:
    value = value.lower()
    value = re.sub(r"\[[^\]]+\]|\([^)]*\)|\u3010[^\u3011]+\u3011", " ", value)
    value = re.sub(r"bv[0-9a-z]+", " ", value, flags=re.I)
    value = re.sub(r"[\W_]+", "", value, flags=re.U)
    return value


def scan_video_files(video_dir: Path) -> list[Path]:
    if not video_dir.exists():
        raise FileNotFoundError(f"video dir not found: {video_dir}")
    files = [p for p in video_dir.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTS]
    if not files:
        raise RuntimeError(f"no video files found in: {video_dir}")
    return files


def scan_eagle_library_videos(library_dir: Path) -> list[dict]:
    images_dir = library_dir / "images"
    if not images_dir.exists():
        raise FileNotFoundError(f"Eagle images dir not found: {images_dir}")
    items: list[dict] = []
    for info_dir in images_dir.glob("*.info"):
        metadata_path = info_dir / "metadata.json"
        if not metadata_path.exists():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if metadata.get("isDeleted") is True:
            continue
        ext = str(metadata.get("ext") or "").lower()
        video_files = [p for p in info_dir.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTS]
        if ext and f".{ext}" in VIDEO_EXTS:
            video_files = sorted(video_files, key=lambda p: p.suffix.lower() != f".{ext}")
        if not video_files:
            continue
        thumbnails = sorted(info_dir.glob("*_thumbnail.*"))
        text = "\n".join(
            str(x)
            for x in [
                metadata.get("id", ""),
                metadata.get("name", ""),
                metadata.get("url", ""),
                metadata.get("website", ""),
                metadata.get("annotation", ""),
                video_files[0].name,
            ]
            if x
        )
        items.append(
            {
                "source_path": video_files[0],
                "metadata": metadata,
                "search_text": text,
                "bvids": set(re.findall(r"BV[0-9A-Za-z]+", text)),
                "eagle_id": metadata.get("id") or info_dir.stem,
                "thumbnail_path": thumbnails[0] if thumbnails else None,
            }
        )
    if not items:
        raise RuntimeError(f"no Eagle library videos found in: {library_dir}")
    return items


def match_video_files(videos: Iterable[VideoItem], files: list[Path], min_score: float) -> list[dict]:
    by_bv: dict[str, Path] = {}
    normalized_files = []
    for path in files:
        match = re.search(r"(BV[0-9A-Za-z]+)", path.name)
        if match:
            by_bv.setdefault(match.group(1), path)
        normalized_files.append((path, normalize_text(path.stem)))

    matched: list[dict] = []
    used: set[Path] = set()
    for video in videos:
        source_path = by_bv.get(video.bvid)
        score = 1.0 if source_path else 0.0
        method = "bvid" if source_path else ""

        if not source_path:
            title_key = normalize_text(video.title)
            if not title_key:
                continue
            best_path = None
            best_score = 0.0
            for path, file_key in normalized_files:
                if path in used or not file_key:
                    continue
                if title_key in file_key or file_key in title_key:
                    current = min(len(title_key), len(file_key)) / max(len(title_key), len(file_key))
                    current = max(current, 0.82)
                else:
                    current = SequenceMatcher(None, title_key, file_key).ratio()
                if current > best_score:
                    best_score = current
                    best_path = path
            if best_path and best_score >= min_score:
                source_path = best_path
                score = best_score
                method = "title"

        if source_path and source_path not in used:
            used.add(source_path)
            matched.append({"video": video, "source_path": source_path, "score": score, "method": method})

    return matched


def match_eagle_library_items(
    videos: Iterable[VideoItem],
    items: list[dict],
    min_score: float,
    allow_title_match: bool = False,
) -> list[dict]:
    matched: list[dict] = []
    used: set[str] = set()
    normalized_items = [
        (
            item,
            normalize_text(str(item["metadata"].get("name") or item["source_path"].stem)),
            item["search_text"],
        )
        for item in items
    ]
    for video in videos:
        best_item = None
        score = 0.0
        method = ""
        if video.bvid:
            for item, _key, text in normalized_items:
                if item["eagle_id"] in used:
                    continue
                if video.bvid in item.get("bvids", set()) or video.bvid in text:
                    best_item = item
                    score = 1.0
                    method = "eagle-bvid"
                    break

        if best_item is None and allow_title_match:
            title_key = normalize_text(video.title)
            for item, item_key, _text in normalized_items:
                if item["eagle_id"] in used or not item_key or not title_key:
                    continue
                if title_key in item_key or item_key in title_key:
                    current = max(0.82, min(len(title_key), len(item_key)) / max(len(title_key), len(item_key)))
                else:
                    current = SequenceMatcher(None, title_key, item_key).ratio()
                if current > score:
                    score = current
                    best_item = item
                    method = "eagle-title"

        if best_item and score >= min_score:
            used.add(best_item["eagle_id"])
            matched.append(
                {
                    "video": video,
                    "source_path": best_item["source_path"],
                    "score": score,
                    "method": method,
                    "eagle_id": best_item["eagle_id"],
                    "eagle_thumbnail": best_item.get("thumbnail_path"),
                }
            )
    return matched


def run_command(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        **subprocess_no_window_kwargs(),
    )


def run_ffmpeg(args: list[str]) -> None:
    proc = run_command(args)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-1200:]
        raise RuntimeError(detail or f"ffmpeg failed with exit code {proc.returncode}")


def frame_worker_count(total: int) -> int:
    if total <= 1:
        return 1
    try:
        configured = int(os.environ.get("BILI_EAGLE_FRAME_WORKERS", "0") or 0)
    except Exception:
        configured = 0
    cpu_limit = max(1, (os.cpu_count() or 2) // 2)
    if configured > 0:
        return max(1, min(configured, total, 6))
    return max(1, min(total, cpu_limit, 4))


def get_duration_seconds(path: Path) -> float | None:
    ffprobe = find_ffprobe()
    if ffprobe:
        try:
            proc = run_command(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ]
            )
            if proc.returncode == 0:
                value = float((proc.stdout or "").strip())
                if value > 0:
                    return value
        except Exception:
            pass

    try:
        proc = run_command([find_ffmpeg(), "-i", str(path)])
    except Exception:
        return None
    text = (proc.stderr or "") + (proc.stdout or "")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def get_video_resolution(path: Path) -> tuple[int, int] | None:
    ffprobe = find_ffprobe()
    if ffprobe:
        try:
            proc = run_command(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=width,height",
                    "-of",
                    "csv=s=x:p=0",
                    str(path),
                ]
            )
            if proc.returncode == 0:
                text = (proc.stdout or "").strip().splitlines()[0]
                width, height = [int(x) for x in text.split("x")[:2]]
                if width > 0 and height > 0:
                    return width, height
        except Exception:
            pass

    try:
        proc = run_command([find_ffmpeg(), "-i", str(path)])
    except Exception:
        return None
    text = (proc.stderr or "") + (proc.stdout or "")
    matches = re.findall(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    if not matches:
        return None
    width, height = [int(x) for x in matches[0]]
    return (width, height) if width > 0 and height > 0 else None


def output_size_for_video(source: Path, preferred_width: int) -> tuple[int, int]:
    resolution = get_video_resolution(source)
    if not resolution:
        return preferred_width, int(preferred_width * 9 / 16)
    src_w, src_h = resolution
    aspect = src_w / src_h
    if src_w >= src_h:
        out_w = max(720, preferred_width)
        out_h = int(round(out_w / aspect))
    else:
        out_h = max(720, preferred_width)
        out_w = int(round(out_h * aspect))
    # Keep dimensions even for cleaner encoder/viewer compatibility.
    out_w = max(2, out_w - out_w % 2)
    out_h = max(2, out_h - out_h % 2)
    return out_w, out_h


def sample_timestamps(duration: float | None, count: int, avoid: Iterable[float] = ()) -> list[float]:
    if count <= 0:
        return []
    avoid_list = list(avoid)
    def far_enough(value: float) -> bool:
        return all(abs(value - other) >= 4.0 for other in avoid_list)

    if duration and duration > 4:
        start = max(1.0, duration * 0.08)
        end = max(start + 0.5, duration * 0.92)
        if end <= start:
            end = duration
        values = []
        attempts = 0
        while len(values) < count and attempts < count * 20:
            attempts += 1
            value = random.uniform(start, end)
            if far_enough(value) and all(abs(value - old) >= 4.0 for old in values):
                values.append(value)
        while len(values) < count:
            values.append(random.uniform(start, end))
        return sorted(values)
    return [max(0.0, i * 2.0) for i in range(count)]


def segmented_timestamps(duration: float | None, count: int, avoid: Iterable[float] = ()) -> list[float]:
    if count <= 0:
        return []
    avoid_list = [x for x in avoid if x is not None]
    if not duration or duration <= 6:
        return sample_timestamps(duration, count, avoid_list)

    start = max(1.0, duration * 0.06)
    end = min(max(start + 1.0, duration - 1.0), duration * 0.94)
    if end <= start:
        return sample_timestamps(duration, count, avoid_list)

    values: list[float] = []
    segments = max(count, 1)
    span = (end - start) / segments
    min_gap = max(2.0, min(12.0, duration / max(count * 1.6, 1)))
    for idx in range(segments):
        left = start + span * idx
        right = start + span * (idx + 1)
        for _ in range(10):
            value = random.uniform(left, right)
            if all(abs(value - old) >= min_gap for old in values + avoid_list):
                values.append(value)
                break
        else:
            values.append((left + right) / 2)
    return sorted(values[:count])


def extract_frame(source: Path, timestamp: float, output: Path, width: int) -> None:
    ffmpeg = find_ffmpeg()
    run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-ss",
            f"{timestamp:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-vf",
            f"scale={width}:-2",
            "-q:v",
            "3",
            str(output),
        ]
    )


def score_frame(path: Path) -> float:
    try:
        with Image.open(path) as image:
            gray = image.convert("L").resize((160, 90), Image.Resampling.BILINEAR)
            pixels = list(gray.getdata())
    except Exception:
        return -1.0
    if not pixels:
        return -1.0
    mean = sum(pixels) / len(pixels)
    variance = sum((px - mean) ** 2 for px in pixels) / len(pixels)
    contrast = variance ** 0.5
    if mean < 12 or mean > 243:
        return contrast * 0.2
    edge = 0.0
    width, height = 160, 90
    for y in range(0, height - 1, 3):
        row = y * width
        next_row = (y + 1) * width
        for x in range(0, width - 1, 3):
            edge += abs(pixels[row + x] - pixels[row + x + 1])
            edge += abs(pixels[row + x] - pixels[next_row + x])
    edge /= 1800
    exposure_bonus = 1.0 - min(abs(mean - 128) / 128, 1.0)
    return contrast * 1.4 + edge * 0.7 + exposure_bonus * 18


def frame_difference_score(path_a: Path, path_b: Path) -> float:
    try:
        with Image.open(path_a) as a, Image.open(path_b) as b:
            a_small = a.convert("L").resize((96, 54), Image.Resampling.BILINEAR)
            b_small = b.convert("L").resize((96, 54), Image.Resampling.BILINEAR)
            diff = ImageChops.difference(a_small, b_small)
            return float(ImageStat.Stat(diff).mean[0])
    except Exception:
        return 0.0


def select_diverse_frames(scored_frames: list[tuple[float, Path, bool, float]], frame_count: int) -> list[Path]:
    if not scored_frames:
        return []

    selected: list[Path] = []
    selected_times: list[float] = []
    peak_frames = [item for item in scored_frames if item[2]]
    if peak_frames:
        score, path, _is_peak, timestamp = max(peak_frames, key=lambda item: item[0])
        selected.append(path)
        selected_times.append(timestamp)

    ordered = sorted(scored_frames, key=lambda item: item[0], reverse=True)
    duration_span = max([item[3] for item in scored_frames], default=0) - min([item[3] for item in scored_frames], default=0)
    min_time_gap = max(2.0, min(14.0, duration_span / max(frame_count, 1) * 0.45)) if duration_span else 2.0

    while len(selected) < frame_count:
        best = None
        best_rank = -1e9
        for quality, path, is_peak, timestamp in ordered:
            if path in selected or is_peak:
                continue
            time_gap = min((abs(timestamp - old) for old in selected_times), default=999.0)
            if time_gap < min_time_gap and len(selected) < max(1, frame_count // 2):
                continue
            visual_gap = min((frame_difference_score(path, old) for old in selected), default=28.0)
            rank = quality + visual_gap * 1.8 + min(time_gap, 30.0) * 0.8
            if rank > best_rank:
                best_rank = rank
                best = (path, timestamp)
        if best is None:
            break
        selected.append(best[0])
        selected_times.append(best[1])

    if len(selected) < frame_count:
        for _quality, path, _is_peak, timestamp in ordered:
            if len(selected) >= frame_count:
                break
            if path not in selected:
                selected.append(path)
                selected_times.append(timestamp)
    return selected


def danmaku_cache_path(bvid: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z_-]", "_", bvid or "unknown")
    return DANMAKU_CACHE_DIR / f"{safe}.json"


def danmaku_xml_cache_path(bvid: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z_-]", "_", bvid or "unknown")
    return DANMAKU_CACHE_DIR / f"{safe}.xml"


def parse_danmaku_xml_times(xml_bytes: bytes) -> list[float]:
    root = ET.fromstring(xml_bytes)
    times = []
    for node in root.findall(".//d"):
        p_attr = node.attrib.get("p", "")
        if not p_attr:
            continue
        try:
            times.append(float(p_attr.split(",", 1)[0]))
        except ValueError:
            continue
    return times


def fetch_danmaku_times(video: VideoItem, use_network: bool = True) -> list[float]:
    if not video.bvid:
        return []
    DANMAKU_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = danmaku_cache_path(video.bvid)
    xml_path = danmaku_xml_cache_path(video.bvid)
    if xml_path.exists() and xml_path.stat().st_size > 0:
        try:
            times = parse_danmaku_xml_times(xml_path.read_bytes())
            cache_path.write_text(
                json.dumps({"bvid": video.bvid, "times": times, "source": "xml"}, ensure_ascii=False),
                encoding="utf-8",
            )
            return times
        except Exception:
            pass
    if cache_path.exists():
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            return [float(x) for x in data.get("times", [])]
        except Exception:
            pass
    if not use_network:
        return []

    headers = {"User-Agent": USER_AGENT, "Referer": BILI_REFERER}
    try:
        page_resp = requests.get(
            "https://api.bilibili.com/x/player/pagelist",
            params={"bvid": video.bvid},
            headers=headers,
            timeout=12,
        )
        page_resp.raise_for_status()
        page_data = page_resp.json()
        pages = page_data.get("data") or []
        if not pages:
            return []
        cid = pages[0].get("cid")
        if not cid:
            return []
        time.sleep(random.uniform(0.25, 0.75))
        dm_resp = requests.get(
            "https://api.bilibili.com/x/v1/dm/list.so",
            params={"oid": cid},
            headers=headers,
            timeout=15,
        )
        dm_resp.raise_for_status()
        xml_path.write_bytes(dm_resp.content)
        times = parse_danmaku_xml_times(dm_resp.content)
        cache_path.write_text(
            json.dumps({"bvid": video.bvid, "cid": cid, "times": times}, ensure_ascii=False),
            encoding="utf-8",
        )
        return times
    except Exception as exc:
        cache_path.write_text(
            json.dumps({"bvid": video.bvid, "times": [], "error": str(exc)[:240]}, ensure_ascii=False),
            encoding="utf-8",
        )
        return []


def peak_timestamp_from_danmaku(times: list[float], duration: float | None) -> float | None:
    if not times:
        return None
    bucket_size = 5.0
    buckets: dict[int, int] = {}
    for value in times:
        if value < 1:
            continue
        if duration and value > max(1.0, duration - 1):
            continue
        bucket = int(value // bucket_size)
        buckets[bucket] = buckets.get(bucket, 0) + 1
    if not buckets:
        return None
    peak_bucket, peak_count = max(buckets.items(), key=lambda item: item[1])
    avg = sum(buckets.values()) / max(1, len(buckets))
    if peak_count < max(4, avg * 1.8):
        return None
    timestamp = peak_bucket * bucket_size + bucket_size / 2
    if duration:
        timestamp = min(max(1.0, timestamp), max(1.0, duration - 1.0))
    return timestamp


def load_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def fit_image_cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    image = image.convert("RGB")
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - target_w) // 2)
    top = max(0, (resized.height - target_h) // 2)
    return resized.crop((left, top, left + target_w, top + target_h))


def compose_contact_sheet(
    cover_path: Path | None,
    frame_paths: list[Path],
    output: Path,
    columns: int,
    rows: int,
    sheet_width: int,
    sheet_height: int,
) -> None:
    gap = 8
    sheet_w = sheet_width
    sheet_h = sheet_height
    grid_h = max(120, int(sheet_h * 0.32))
    cover_h = max(120, sheet_h - gap - grid_h)
    cell_width = max(2, (sheet_w - (columns - 1) * gap) // columns)
    cell_height = max(2, (grid_h - (rows - 1) * gap) // rows)
    canvas = Image.new("RGB", (sheet_w, sheet_h), (0, 0, 0))

    if cover_path and cover_path.exists():
        with Image.open(cover_path) as cover:
            canvas.paste(fit_image_cover(cover, (sheet_w, cover_h)), (0, 0))
    elif frame_paths:
        with Image.open(frame_paths[0]) as fallback:
            canvas.paste(fit_image_cover(fallback, (sheet_w, cover_h)), (0, 0))

    for index, frame_path in enumerate(frame_paths[: columns * rows]):
        with Image.open(frame_path) as image:
            tile = fit_image_cover(image, (cell_width, cell_height))

        col = index % columns
        row = index // columns
        left = col * (cell_width + gap)
        top = cover_h + gap + row * (cell_height + gap)
        canvas.paste(tile, (left, top))

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=94)


def contact_sheet_path(video: VideoItem, source: Path | None = None) -> Path:
    stem = clean_filename(f"{video.bvid} {video.title}", video.bvid or "video")
    if source:
        try:
            marker = f"{source.resolve()}|{source.stat().st_size}"
        except Exception:
            marker = str(source)
        digest = hashlib.sha1(marker.encode("utf-8", errors="ignore")).hexdigest()[:8]
        stem = clean_filename(f"{stem} {digest}", stem)
    return CONTACT_SHEET_DIR / f"{stem} [contact-sheet].jpg"


def generate_contact_sheet(
    source: Path,
    video: VideoItem,
    frame_count: int,
    columns: int,
    width: int,
    overwrite: bool,
    use_danmaku: bool,
    cover_override: Path | None = None,
) -> Path:
    output = contact_sheet_path(video, source)
    if output.exists() and output.stat().st_size > 1024 and not overwrite:
        return output

    rows = math.ceil(frame_count / columns)
    output_width, output_height = output_size_for_video(source, width)
    gap = 8
    grid_h = max(120, int(output_height * 0.32))
    cell_width = max(240, (output_width - (columns - 1) * gap) // columns)
    grid_cell_height = max(120, (grid_h - (rows - 1) * gap) // rows)
    extract_width = max(cell_width, int(grid_cell_height * 16 / 9))
    duration = get_duration_seconds(source)
    peak_ts = peak_timestamp_from_danmaku(fetch_danmaku_times(video, use_network=use_danmaku), duration)
    protected_timestamps = [peak_ts] if peak_ts is not None else []
    try:
        candidate_multiplier = float(os.environ.get("BILI_EAGLE_CANDIDATE_MULTIPLIER", "3") or 3)
    except Exception:
        candidate_multiplier = 3
    candidate_multiplier = max(1.5, min(5.0, candidate_multiplier))
    candidate_count = max(int(frame_count * candidate_multiplier), frame_count + 6)
    timestamps = protected_timestamps + sample_timestamps(
        duration,
        max(0, max(frame_count, frame_count // 2) - len(protected_timestamps)),
        avoid=protected_timestamps,
    ) + segmented_timestamps(
        duration,
        max(0, candidate_count - max(frame_count, frame_count // 2) - len(protected_timestamps)),
        avoid=protected_timestamps,
    )

    with tempfile.TemporaryDirectory(prefix="eagle_frames_") as tmp:
        tmp_dir = Path(tmp)
        scored_frames: list[tuple[float, Path, bool, float]] = []

        def extract_scored_frame(index: int, timestamp: float):
            frame_path = tmp_dir / f"frame_{index:02d}.jpg"
            extract_frame(source, timestamp, frame_path, extract_width)
            if not frame_path.exists() or frame_path.stat().st_size <= 0:
                return None
            is_peak = peak_ts is not None and abs(timestamp - peak_ts) < 0.01
            return (score_frame(frame_path), frame_path, is_peak, timestamp)

        workers = frame_worker_count(len(timestamps))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(extract_scored_frame, index, timestamp): timestamp
                for index, timestamp in enumerate(timestamps, 1)
            }
            for future in as_completed(futures):
                timestamp = futures[future]
                try:
                    result = future.result()
                    if result:
                        scored_frames.append(result)
                except Exception as exc:
                    print(f"[frame-skip] {video.bvid} @{timestamp:.1f}s: {exc}")

        if not scored_frames:
            fallback_times = [0.5, 1.5, 3.0]
            if duration and duration > 8:
                fallback_times.extend([duration * 0.25, duration * 0.5, duration * 0.75, max(1.0, duration - 2.0)])
            for retry_index, timestamp in enumerate(fallback_times, 1):
                frame_path = tmp_dir / f"fallback_{retry_index:02d}.jpg"
                try:
                    extract_frame(source, max(0.0, timestamp), frame_path, max(320, extract_width // 2))
                    if frame_path.exists() and frame_path.stat().st_size > 0:
                        scored_frames.append((score_frame(frame_path), frame_path, False, timestamp))
                except Exception as exc:
                    print(f"[frame-fallback-skip] {video.bvid} @{timestamp:.1f}s: {exc}")

        if not scored_frames:
            raise RuntimeError(f"failed to extract frames: {source}")

        selected: list[Path] = []
        peak_frames = [item for item in scored_frames if item[2]]
        if peak_frames:
            print(f"[danmaku-peak] {video.bvid} @{peak_ts:.1f}s")

        selected = select_diverse_frames(scored_frames, frame_count)

        if not selected:
            selected = [max(scored_frames, key=lambda item: item[0])[1]]
        rows = math.ceil(len(selected) / columns)
        cover_path = cover_override if cover_override and cover_override.exists() else None
        if cover_path is None:
            try:
                cover_path = download_cover(video)
            except Exception as exc:
                print(f"[cover-fallback] {video.bvid}: {exc}")
                cover_path = None
        compose_contact_sheet(
            cover_path,
            selected,
            output,
            columns=columns,
            rows=rows,
            sheet_width=output_width,
            sheet_height=output_height,
        )
    print(f"[sheet-size] {video.bvid} {output_width}x{output_height}")
    return output


def build_video_manifest(
    matches: list[dict],
    mode: str,
    overwrite: bool,
    limit: int,
    frame_count: int,
    columns: int,
    sheet_width: int,
    use_danmaku: bool,
    bilibili_cover_min_score: float = 1.0,
) -> list[dict]:
    selected = matches[:limit] if limit and limit > 0 else matches
    if not selected:
        raise RuntimeError(
            "no local videos matched the favorite cache; try putting BV ids in filenames "
            "or lowering --min-score"
        )

    manifest: list[dict] = []
    for index, item in enumerate(selected, 1):
        video: VideoItem = item["video"]
        source_path: Path = item["source_path"]
        sheet_path = None

        if mode == "contact-sheet":
            import_path = source_path
            sheet_path = generate_contact_sheet(
                source_path,
                video,
                frame_count=frame_count,
                columns=columns,
                width=sheet_width,
                overwrite=overwrite,
                use_danmaku=use_danmaku,
                cover_override=(
                    None
                    if item.get("method") == "eagle-bvid" or float(item.get("score") or 0) >= bilibili_cover_min_score
                    else item.get("eagle_thumbnail")
                ),
            )
        elif mode == "original":
            import_path = source_path
        else:
            raise ValueError(f"unknown mode: {mode}")

        tags = ["Bilibili", "\u6536\u85cf\u5939", "\u89c6\u9891"]
        if video.bvid:
            tags.append(video.bvid)
        if video.month:
            tags.append(video.month)

        annotation = build_annotation(video)
        annotation += f"\n\u672c\u5730\u6e90\u6587\u4ef6: {source_path}"
        annotation += f"\n\u5339\u914d\u65b9\u5f0f: {item['method']} ({item['score']:.2f})"
        if sheet_path:
            annotation += f"\nContact sheet: {sheet_path}"

        manifest.append(
            {
                "path": str(import_path),
                "name": video.title,
                "website": video.website,
                "annotation": annotation,
                "tags": tags,
                "bvid": video.bvid,
                "contact_sheet": str(sheet_path) if sheet_path else "",
                "source_video": str(source_path),
                "match": {"method": item["method"], "score": item["score"]},
            }
        )
        print(f"[video] {index}/{len(selected)} {video.bvid} -> {import_path.name}")
        if sheet_path:
            print(f"[sheet] {sheet_path}")

    VIDEO_MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] video manifest saved: {VIDEO_MANIFEST_PATH}")
    return manifest


def load_manifest(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError("manifest must be a JSON list")
    return data


def load_videos(args: argparse.Namespace) -> list[VideoItem]:
    if args.source_state:
        videos = videos_from_state()
    elif args.cache:
        videos = videos_from_cache(args.cache)
    else:
        videos = videos_from_cache_dir(args.cache_dir)
    return dedupe_videos(videos)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare local Bilibili videos for Eagle.")
    input_source = parser.add_mutually_exclusive_group()
    input_source.add_argument("--video-dir", type=Path, help="Directory containing downloaded videos.")
    input_source.add_argument("--eagle-library", type=Path, help="Eagle .library folder; use videos copied inside it.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--cache", type=Path, help="Use one fav_*.json cache file.")
    source.add_argument("--cache-dir", type=Path, default=PROJECT_ROOT / "userdata" / "_web_cache")
    source.add_argument("--source-state", action="store_true", help="Read current Web UI state.")
    parser.add_argument("--mode", choices=["contact-sheet", "original"], default="contact-sheet")
    parser.add_argument("--frames", type=int, default=8, help="Bottom frames per contact sheet. Default: 8")
    parser.add_argument("--columns", type=int, default=4, help="Bottom grid columns. Default: 4")
    parser.add_argument("--sheet-width", type=int, default=1920, help="Contact sheet width. Default: 1920")
    parser.add_argument("--no-danmaku", action="store_true", help="Do not fetch/use Bilibili danmaku peaks.")
    parser.add_argument("--allow-title-match", action="store_true", help="Allow fuzzy title matching for Eagle libraries.")
    parser.add_argument("--bili-cover-min-score", type=float, default=1.0, help="Use Bilibili cover for title matches at or above this score.")
    parser.add_argument("--min-score", type=float, default=0.72, help="Minimum title match score. Default: 0.72")
    parser.add_argument("--limit", type=int, default=10, help="Limit matched videos; 0 means all. Default: 10")
    parser.add_argument("--overwrite", action="store_true", help="Rebuild generated contact sheets.")
    parser.add_argument("--prepare-only", action="store_true", help="Only build manifest; do not import to Eagle.")
    parser.add_argument("--import-only", action="store_true", help="Import existing video manifest.")
    parser.add_argument("--manifest", type=Path, default=VIDEO_MANIFEST_PATH)
    parser.add_argument("--eagle-api", default=EAGLE_API)
    parser.add_argument("--batch-size", type=int, default=10)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    configure_console()
    args = parse_args(argv)
    try:
        if args.import_only:
            manifest = load_manifest(args.manifest)
        else:
            if not args.video_dir and not args.eagle_library:
                raise ValueError("--video-dir or --eagle-library is required unless --import-only is used")
            videos = load_videos(args)
            if args.eagle_library:
                eagle_items = scan_eagle_library_videos(args.eagle_library)
                matches = match_eagle_library_items(
                    videos,
                    eagle_items,
                    min_score=args.min_score,
                    allow_title_match=args.allow_title_match,
                )
                source_label = str(args.eagle_library)
                local_count = len(eagle_items)
            else:
                files = scan_video_files(args.video_dir)
                matches = match_video_files(videos, files, min_score=args.min_score)
                source_label = str(args.video_dir)
                local_count = len(files)
            selected_matches = matches[: args.limit if args.limit > 0 else len(matches)]
            report = {
                "source": source_label,
                "source_type": "eagle_library" if args.eagle_library else "video_dir",
                "cache_videos": len(videos),
                "local_files": local_count,
                "matched": len(matches),
                "mode": args.mode,
                "matches": [
                    {
                        "video": asdict(item["video"]),
                        "source_path": str(item["source_path"]),
                        "score": item["score"],
                        "method": item["method"],
                    }
                    for item in selected_matches
                ],
            }
            EXPORT_DIR.mkdir(parents=True, exist_ok=True)
            (EXPORT_DIR / "video_match_report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"[source] cache videos={len(videos)} local files={local_count} matched={len(matches)}")
            manifest = build_video_manifest(
                matches,
                mode=args.mode,
                overwrite=args.overwrite,
                limit=args.limit,
                frame_count=max(1, args.frames),
                columns=max(1, args.columns),
                sheet_width=max(720, args.sheet_width),
                use_danmaku=not args.no_danmaku,
                bilibili_cover_min_score=args.bili_cover_min_score,
            )

        if args.prepare_only:
            print("[done] prepare-only mode; Eagle import skipped")
            return 0

        import_to_eagle(manifest, api=args.eagle_api, batch_size=max(1, args.batch_size))
        print("[done] Eagle video import completed")
        return 0
    except KeyboardInterrupt:
        print("\n[cancelled]")
        return 130
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
