"""Keep BiliDownloader-managed Eagle tags isolated in one tag group."""

from __future__ import annotations

import json
import os
import secrets
import string
import time
from pathlib import Path
from typing import Iterable

import requests


TAG_GROUP_NAME = "BiliDownloader 标签"
TAG_GROUP_COLOR = "blue"
DEFAULT_EAGLE_API = "http://localhost:41595"


def clean_tags(values: Iterable[object]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        tag = " ".join(str(value or "").split()).strip()
        if not tag or len(tag) > 80:
            continue
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(tag)
    return result


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, path)


def _new_group_id() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "BD" + "".join(secrets.choice(alphabet) for _ in range(12))


def _api_update(path: str, payload: dict, api_base: str = "") -> bool:
    if not api_base:
        return False
    try:
        response = requests.post(
            f"{api_base.rstrip('/')}{path}",
            json=payload,
            timeout=8,
        )
        if not response.ok:
            return False
        data = response.json()
        return isinstance(data, dict) and data.get("status") == "success"
    except (OSError, ValueError, TypeError, requests.RequestException):
        return False


def api_for_library(library_dir: Path, api_base: str = DEFAULT_EAGLE_API) -> str:
    """Return the Eagle API only when it is currently showing this library."""
    if not api_base:
        return ""
    try:
        response = requests.get(
            f"{api_base.rstrip('/')}/api/library/info",
            timeout=5,
        )
        if not response.ok:
            return ""
        payload = response.json()
        current = ((payload.get("data") or {}).get("library") or {}).get("path")
        if not current:
            return ""
        if Path(current).resolve() != Path(library_dir).resolve():
            return ""
        return api_base
    except (OSError, ValueError, TypeError, requests.RequestException):
        return ""


def ensure_bili_tag_group(
    library_dir: Path,
    tags: Iterable[object] = (),
    api_base: str = "",
) -> dict:
    """Create or merge the dedicated BiliDownloader tag group without touching others."""
    metadata_path = library_dir / "metadata.json"
    metadata = _read_json(metadata_path, {})
    if not isinstance(metadata, dict):
        raise RuntimeError("Eagle library metadata is invalid")

    groups = metadata.get("tagsGroups")
    if not isinstance(groups, list):
        groups = []
        metadata["tagsGroups"] = groups

    group = next(
        (
            item for item in groups
            if isinstance(item, dict) and str(item.get("name") or "").strip() == TAG_GROUP_NAME
        ),
        None,
    )
    created = group is None
    if created:
        group = {
            "id": _new_group_id(),
            "name": TAG_GROUP_NAME,
            "tags": [],
            "color": TAG_GROUP_COLOR,
        }
        groups.append(group)

    merged_tags = clean_tags([*(group.get("tags") or []), *tags])
    changed = created or group.get("tags") != merged_tags
    group["tags"] = merged_tags
    group.setdefault("id", _new_group_id())
    group.setdefault("color", TAG_GROUP_COLOR)
    if not created and api_base:
        _api_update(
            "/api/v2/tagGroup/update",
            {
                "id": str(group["id"]),
                "name": TAG_GROUP_NAME,
                "tags": merged_tags,
                "color": group.get("color") or TAG_GROUP_COLOR,
            },
            api_base,
        )
    if changed:
        metadata["modificationTime"] = int(time.time() * 1000)
        _write_json(metadata_path, metadata)
    return {"id": str(group["id"]), "name": TAG_GROUP_NAME, "tags": merged_tags}


def append_bili_tags_to_item(
    item: dict,
    library_dir: Path,
    tags: Iterable[object],
    api_base: str = "",
) -> list[str]:
    """Append cached Bilibili tags to one Eagle item, preserving all existing tags."""
    cleaned = clean_tags(tags)
    if not cleaned:
        return []

    metadata_path = Path(str(item.get("metadata_path") or ""))
    if not metadata_path.is_file():
        raise RuntimeError("Eagle item metadata is missing")
    metadata = _read_json(metadata_path, {})
    if not isinstance(metadata, dict):
        raise RuntimeError("Eagle item metadata is invalid")

    merged = clean_tags([*(metadata.get("tags") or []), *cleaned])
    changed = metadata.get("tags") != merged
    if changed or api_base:
        now_ms = int(time.time() * 1000)
        metadata["tags"] = merged
        metadata["lastModified"] = now_ms
        item_id = str(metadata.get("id") or item.get("id") or "").strip()
        api_updated = _api_update(
            "/api/v2/item/update",
            {
                "id": item_id,
                "tags": merged,
                "modificationTime": now_ms,
            },
            api_base,
        ) if item_id else False
        if changed and not api_updated:
            _write_json(metadata_path, metadata)

        mtime_path = library_dir / "mtime.json"
        mtime = _read_json(mtime_path, {})
        if not isinstance(mtime, dict):
            mtime = {}
        mtime[str(metadata.get("id") or item.get("id") or "")] = now_ms
        mtime["all"] = 1
        _write_json(mtime_path, mtime)
    return cleaned


def prune_unused_bili_tags(library_dir: Path, api_base: str = "") -> dict:
    """Remove BiliDownloader group tags that are not assigned to any Eagle item."""
    library_dir = Path(library_dir)
    metadata_path = library_dir / "metadata.json"
    metadata = _read_json(metadata_path, {})
    if not isinstance(metadata, dict):
        raise RuntimeError("Eagle library metadata is invalid")
    groups = metadata.get("tagsGroups")
    if not isinstance(groups, list):
        return {"removed": 0, "remaining": 0}
    group = next(
        (
            item for item in groups
            if isinstance(item, dict)
            and str(item.get("name") or "").strip() == TAG_GROUP_NAME
        ),
        None,
    )
    if not group:
        return {"removed": 0, "remaining": 0}

    used_tags = set()
    images_dir = library_dir / "images"
    for item_metadata_path in images_dir.glob("*.info/metadata.json"):
        item_metadata = _read_json(item_metadata_path, {})
        if isinstance(item_metadata, dict):
            used_tags.update(clean_tags(item_metadata.get("tags") or []))

    old_tags = clean_tags(group.get("tags") or [])
    remaining = [tag for tag in old_tags if tag in used_tags]
    removed = len(old_tags) - len(remaining)
    if removed:
        group["tags"] = remaining
    group_id = str(group.get("id") or "").strip()
    api_updated = _api_update(
        "/api/v2/tagGroup/update",
        {
            "id": group_id,
            "name": TAG_GROUP_NAME,
            "tags": remaining,
            "color": group.get("color") or TAG_GROUP_COLOR,
        },
        api_base,
    ) if group_id and api_base else False
    if removed:
        if not api_updated:
            metadata["modificationTime"] = int(time.time() * 1000)
            _write_json(metadata_path, metadata)
    return {"removed": removed, "remaining": len(remaining)}
