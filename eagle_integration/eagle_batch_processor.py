#!/usr/bin/env python3
"""Dedicated Eagle batch importer/thumbnail processor for BiliDownloader."""

from __future__ import annotations

import datetime as _dt
import json
import os
import queue
import re
import threading
import time
from pathlib import Path

import requests

from apply_contact_sheets_to_eagle import apply_match, find_library_items
from eagle_tags import api_for_library, append_bili_tags_to_item, clean_tags, ensure_bili_tag_group
from export_to_eagle import EAGLE_API, VideoItem, eagle_available, normalize_url
from import_videos_to_eagle import generate_contact_sheet
from one_click_eagle_thumbnail import load_library_folders


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
RECORDS_PATH = PROJECT_ROOT / "userdata" / "download_records.json"
INDEX_PATH = PROJECT_ROOT / "userdata" / "eagle_item_index.json"


def ensure_tkinter_loaded() -> None:
    """Load tkinter only for the standalone GUI, not for Web UI background imports."""
    if os.environ.get("BILI_WEB_HEADLESS") == "1":
        raise RuntimeError("GUI dialogs are disabled during Web UI Eagle tasks")
    global BOTH, END, HORIZONTAL, LEFT, RIGHT, X
    global BooleanVar, IntVar, StringVar, Tk, filedialog, messagebox, ttk, ScrolledText
    from tkinter import BOTH, END, HORIZONTAL, LEFT, RIGHT, X, BooleanVar, IntVar, StringVar, Tk, filedialog, messagebox
    from tkinter import ttk
    from tkinter.scrolledtext import ScrolledText


SPEED_MODES = {
    "快速": {"frames": 6, "columns": 3, "width": 1280, "workers": 4, "candidate": 2.0, "danmaku": False},
    "平衡": {"frames": 8, "columns": 4, "width": 1600, "workers": 4, "candidate": 2.6, "danmaku": False},
    "高质量": {"frames": 10, "columns": 5, "width": 1920, "workers": 3, "candidate": 3.5, "danmaku": True},
}


def apply_speed_mode(mode: dict) -> None:
    os.environ["BILI_EAGLE_FRAME_WORKERS"] = str(mode["workers"])
    os.environ["BILI_EAGLE_CANDIDATE_MULTIPLIER"] = str(mode["candidate"])


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(default)) else default
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def item_to_index_entry(item: dict) -> dict:
    meta = item.get("metadata") or {}
    return {
        "id": str(item.get("id") or ""),
        "name": str(meta.get("name") or ""),
        "metadata_path": str(item.get("metadata_path") or ""),
        "info_dir": str(item.get("info_dir") or ""),
        "thumbnail_path": str(item.get("thumbnail_path") or ""),
        "search_text": str(item.get("search_text") or ""),
        "folders": [str(x) for x in meta.get("folders", []) or []],
        "lastModified": meta.get("lastModified") or meta.get("mtime") or 0,
        "ext": str(meta.get("ext") or ""),
    }


def refresh_eagle_index(library_dir: Path) -> dict:
    library_dir = Path(library_dir)
    items = [item_to_index_entry(item) for item in find_library_items(library_dir)]
    data = {
        "library": str(library_dir.resolve()),
        "generatedAt": _dt.datetime.now().isoformat(timespec="seconds"),
        "count": len(items),
        "items": items,
    }
    save_json(INDEX_PATH, data)
    return data


def load_eagle_index(library_dir: Path) -> dict | None:
    data = load_json(INDEX_PATH, {})
    if not data:
        return None
    try:
        if str(Path(data.get("library") or "").resolve()).lower() != str(Path(library_dir).resolve()).lower():
            return None
    except Exception:
        return None
    return data if isinstance(data.get("items"), list) else None


def indexed_entry_to_item(entry: dict) -> dict | None:
    metadata_path = Path(str(entry.get("metadata_path") or ""))
    info_dir = Path(str(entry.get("info_dir") or ""))
    if not metadata_path.exists() or not info_dir.exists():
        return None
    try:
        metadata = load_json(metadata_path, {})
    except Exception:
        return None
    thumbs = sorted(info_dir.glob("*_thumbnail.*"))
    return {
        "id": metadata.get("id") or entry.get("id") or info_dir.stem,
        "info_dir": info_dir,
        "metadata_path": metadata_path,
        "metadata": metadata,
        "thumbnail_path": thumbs[0] if thumbs else None,
        "search_text": entry.get("search_text") or "\n".join(str(metadata.get(k, "")) for k in ("id", "name", "url", "website", "annotation", "ext")),
    }


def find_eagle_item(library_dir: Path, bvid: str, title: str, source_path: str, item_id: str = "", timeout: float = 10.0, use_cache: bool = True):
    deadline = time.time() + timeout
    source_name = Path(source_path).stem if source_path else ""
    if use_cache:
        index = load_eagle_index(library_dir)
        if index:
            entries = index.get("items") or []
            if item_id:
                hit = next((entry for entry in entries if str(entry.get("id")) == item_id), None)
                item = indexed_entry_to_item(hit) if hit else None
                if item:
                    return item
            for entry in entries:
                text = str(entry.get("search_text") or "")
                if source_path and source_path in text:
                    item = indexed_entry_to_item(entry)
                    if item:
                        return item
                if source_name and source_name in text:
                    item = indexed_entry_to_item(entry)
                    if item:
                        return item
                if title and title == str(entry.get("name") or ""):
                    item = indexed_entry_to_item(entry)
                    if item:
                        return item
            for entry in entries:
                if bvid and bvid in str(entry.get("search_text") or ""):
                    item = indexed_entry_to_item(entry)
                    if item:
                        return item
    while time.time() < deadline:
        try:
            items = find_library_items(library_dir)
        except Exception:
            items = []
        if item_id:
            hit = next((item for item in items if str(item.get("id")) == item_id), None)
            if hit:
                return hit
        candidates = sorted(items, key=lambda x: x["metadata"].get("lastModified", 0), reverse=True)
        for item in candidates:
            text = item.get("search_text") or ""
            meta = item.get("metadata") or {}
            if source_path and source_path in text:
                return item
            if source_name and source_name in text:
                return item
            if title and title == str(meta.get("name") or ""):
                return item
        for item in candidates:
            if bvid and bvid in (item.get("search_text") or ""):
                return item
        time.sleep(0.7)
    return None


def ensure_folder(item: dict, library_dir: Path, folder_id: str) -> None:
    if not folder_id:
        return
    metadata = item.get("metadata") or {}
    folders = [str(x) for x in metadata.get("folders", []) or []]
    if folder_id not in folders:
        folders.append(folder_id)
        metadata["folders"] = folders
    now_ms = int(time.time() * 1000)
    metadata["lastModified"] = now_ms
    metadata_path = item.get("metadata_path")
    if metadata_path:
        Path(metadata_path).write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    mtime_path = library_dir / "mtime.json"
    mtime = load_json(mtime_path, {})
    mtime[str(item.get("id") or "")] = now_ms
    mtime["all"] = 1
    save_json(mtime_path, mtime)


def process_record(
    record: dict,
    library: Path,
    folder_id: str,
    mode: dict,
    import_to_eagle: bool = True,
    delete_source: bool = False,
) -> dict:
    source = Path(str(record.get("path") or ""))
    bvid = str(record.get("bvid") or "")
    title = str(record.get("title") or bvid)
    bili_tags = clean_tags(record.get("biliTags") or [])
    video = VideoItem(
        title=title,
        bvid=bvid,
        date=str(record.get("date") or ""),
        month=str(record.get("month") or ""),
        duration=record.get("duration") or "",
        cover=normalize_url(str(record.get("cover") or "")),
        source="download_records",
    )
    sheet = generate_contact_sheet(
        source,
        video,
        frame_count=int(mode["frames"]),
        columns=int(mode["columns"]),
        width=int(mode["width"]),
        overwrite=True,
        use_danmaku=bool(mode["danmaku"]),
    )
    item = None
    eagle_data = record.get("eagle") or {}
    if eagle_data.get("itemId"):
        item = find_eagle_item(library, bvid, title, str(source), str(eagle_data.get("itemId")))
    if import_to_eagle and item is None:
        import_tags = ["Bilibili", "video", bvid, *bili_tags]
        payload = {
            "items": [{
                "path": str(source),
                "name": title,
                "website": video.website,
                "annotation": f"BV: {bvid}\nSource video: {source}\nContact sheet: {sheet}",
                "tags": clean_tags(import_tags),
                "folderId": folder_id,
            }]
        }
        resp = requests.post(EAGLE_API + "/api/item/addFromPaths", json=payload, timeout=120)
        if not resp.ok:
            raise RuntimeError(f"Eagle import HTTP {resp.status_code}: {resp.text[:200]}")
        item = find_eagle_item(library, bvid, title, str(source), use_cache=False)
    if item:
        ensure_folder(item, library, folder_id)
        apply_match({"entry": {"bvid": bvid}, "item": item, "contact_sheet": sheet}, library, _dt.datetime.now().strftime("%Y%m%d_%H%M%S"))
        if bili_tags:
            eagle_api = api_for_library(library, EAGLE_API)
            ensure_bili_tag_group(library, bili_tags, api_base=eagle_api)
            append_bili_tags_to_item(item, library, bili_tags, api_base=eagle_api)
        record["eagle"] = {
            **eagle_data,
            "imported": True,
            "itemId": item.get("id") or "",
            "library": str(library),
            "folderId": folder_id,
            "contactSheet": str(sheet),
            "biliTags": bili_tags,
            "biliTagGroup": "BiliDownloader 标签" if bili_tags else "",
            "importedAt": _dt.datetime.now().isoformat(timespec="seconds"),
            "error": "",
        }
    else:
        record["eagle"] = {**eagle_data, "imported": False, "contactSheet": str(sheet), "error": "generated only"}
    if delete_source and record.get("eagle", {}).get("imported") and source.exists():
        source.unlink()
        record["eagle"]["deletedSource"] = True
    return record


class EagleBatchProcessor:
    def __init__(self, root: Tk):
        ensure_tkinter_loaded()
        self.root = root
        self.root.title("BiliDownloader Eagle 批处理器")
        self.root.geometry("1180x780")
        self.queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self.stop_event = threading.Event()
        self.records: dict[str, dict] = {}
        self.folders: list[dict] = []

        self.library_var = StringVar(value="")
        self.folder_var = StringVar(value="")
        self.mode_var = StringVar(value="平衡")
        self.limit_var = IntVar(value=0)
        self.force_var = BooleanVar(value=False)
        self.delete_var = BooleanVar(value=False)
        self.import_var = BooleanVar(value=True)
        self.progress_var = IntVar(value=0)
        self.status_var = StringVar(value="选择 Eagle 库后开始")

        self.build_ui()
        self.reload_records()
        self.root.after(120, self.drain_queue)

    def build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=14)
        outer.pack(fill=BOTH, expand=True)

        top = ttk.LabelFrame(outer, text="目标与范围", padding=10)
        top.pack(fill=X)

        row = ttk.Frame(top)
        row.pack(fill=X, pady=4)
        ttk.Label(row, text="Eagle 库").pack(side=LEFT)
        ttk.Entry(row, textvariable=self.library_var).pack(side=LEFT, fill=X, expand=True, padx=8)
        ttk.Button(row, text="选择", command=self.choose_library).pack(side=LEFT)
        ttk.Button(row, text="读取文件夹", command=self.load_folders).pack(side=LEFT, padx=(8, 0))
        ttk.Button(row, text="刷新索引", command=self.refresh_index).pack(side=LEFT, padx=(8, 0))
        ttk.Button(row, text="刷新下载记录", command=self.reload_records).pack(side=LEFT, padx=(8, 0))

        row = ttk.Frame(top)
        row.pack(fill=X, pady=4)
        ttk.Label(row, text="目标文件夹").pack(side=LEFT)
        self.folder_combo = ttk.Combobox(row, textvariable=self.folder_var, state="readonly")
        self.folder_combo.pack(side=LEFT, fill=X, expand=True, padx=8)

        opts = ttk.LabelFrame(outer, text="处理选项", padding=10)
        opts.pack(fill=X, pady=(12, 0))

        row = ttk.Frame(opts)
        row.pack(fill=X, pady=4)
        ttk.Label(row, text="速度模式").pack(side=LEFT)
        ttk.Combobox(row, textvariable=self.mode_var, values=list(SPEED_MODES), state="readonly", width=10).pack(side=LEFT, padx=(8, 20))
        ttk.Label(row, text="数量限制 0=全部").pack(side=LEFT)
        ttk.Entry(row, textvariable=self.limit_var, width=8).pack(side=LEFT, padx=(8, 20))
        ttk.Checkbutton(row, text="导入到 Eagle", variable=self.import_var).pack(side=LEFT, padx=(0, 14))
        ttk.Checkbutton(row, text="重做已导入封面", variable=self.force_var).pack(side=LEFT, padx=(0, 14))
        ttk.Checkbutton(row, text="成功后删除源视频", variable=self.delete_var).pack(side=LEFT)

        actions = ttk.Frame(outer)
        actions.pack(fill=X, pady=(12, 0))
        self.start_btn = ttk.Button(actions, text="开始处理", command=self.start)
        self.start_btn.pack(side=LEFT)
        self.stop_btn = ttk.Button(actions, text="停止", command=self.stop, state="disabled")
        self.stop_btn.pack(side=LEFT, padx=8)
        ttk.Button(actions, text="打开导出目录", command=self.open_exports).pack(side=RIGHT)

        progress = ttk.Frame(outer)
        progress.pack(fill=X, pady=(12, 0))
        ttk.Progressbar(progress, variable=self.progress_var, maximum=100, orient=HORIZONTAL).pack(fill=X, expand=True)
        ttk.Label(progress, textvariable=self.status_var).pack(fill=X, pady=(5, 0))

        body = ttk.PanedWindow(outer, orient=HORIZONTAL)
        body.pack(fill=BOTH, expand=True, pady=(12, 0))

        left = ttk.LabelFrame(body, text="队列预览", padding=8)
        self.table = ttk.Treeview(left, columns=("bvid", "title", "status", "path"), show="headings", height=18)
        for key, title, width in [
            ("bvid", "BV", 130),
            ("title", "标题", 320),
            ("status", "状态", 100),
            ("path", "本地文件", 360),
        ]:
            self.table.heading(key, text=title)
            self.table.column(key, width=width, anchor="w")
        self.table.pack(fill=BOTH, expand=True)
        body.add(left, weight=3)

        right = ttk.LabelFrame(body, text="日志", padding=8)
        self.log = ScrolledText(right, height=20, wrap="word")
        self.log.pack(fill=BOTH, expand=True)
        body.add(right, weight=2)

    def append_log(self, text: str) -> None:
        self.log.insert(END, text)
        self.log.see(END)

    def choose_library(self) -> None:
        path = filedialog.askdirectory(title="选择 Eagle .library 文件夹")
        if path:
            self.library_var.set(path)
            self.load_folders()

    def load_folders(self) -> None:
        library = Path(self.library_var.get().strip())
        if not library.exists():
            messagebox.showwarning("提示", "请先选择有效的 Eagle .library 文件夹")
            return
        self.folders = load_library_folders(library)
        values = ["默认位置"] + [f"{item.get('path')}  [{item.get('id')}]" for item in self.folders]
        self.folder_combo["values"] = values
        self.folder_var.set(values[0] if values else "")
        self.append_log(f"[folders] 读取 {len(self.folders)} 个文件夹\n")

    def refresh_index(self) -> None:
        library = Path(self.library_var.get().strip())
        if not library.exists():
            messagebox.showwarning("提示", "请先选择有效的 Eagle .library 文件夹")
            return
        data = refresh_eagle_index(library)
        self.append_log(f"[index] 已刷新 {data.get('count', 0)} 个 item\n")

    def selected_folder_id(self) -> str:
        match = re.search(r"\[([0-9A-Z]+)\]\s*$", self.folder_var.get())
        return match.group(1) if match else ""

    def reload_records(self) -> None:
        self.records = load_json(RECORDS_PATH, {})
        self.refresh_table()

    def queued_records(self) -> list[dict]:
        force = self.force_var.get()
        rows = []
        for record in self.records.values():
            path = Path(str(record.get("path") or ""))
            if not path.exists() or path.suffix.lower() not in {".mp4", ".mkv", ".webm", ".flv"}:
                continue
            if not force and (record.get("eagle") or {}).get("imported"):
                continue
            rows.append(record)
        rows.sort(key=lambda x: str(x.get("downloadedAt") or ""), reverse=True)
        limit = max(0, int(self.limit_var.get() or 0))
        return rows[:limit] if limit else rows

    def refresh_table(self) -> None:
        for item in self.table.get_children():
            self.table.delete(item)
        for record in self.queued_records()[:500]:
            eagle = record.get("eagle") or {}
            status = "已导入" if eagle.get("imported") else "待处理"
            self.table.insert("", END, values=(record.get("bvid", ""), record.get("title", ""), status, record.get("path", "")))
        self.status_var.set(f"可处理 {len(self.queued_records())} 个视频")

    def start(self) -> None:
        library = Path(self.library_var.get().strip())
        if self.import_var.get() and not eagle_available(EAGLE_API):
            messagebox.showwarning("提示", "请先打开 Eagle")
            return
        if not library.exists():
            messagebox.showwarning("提示", "请先选择有效的 Eagle .library 文件夹")
            return
        records = self.queued_records()
        if not records:
            messagebox.showinfo("提示", "没有可处理的视频")
            return
        self.stop_event.clear()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        thread = threading.Thread(target=self.worker, args=(records, library), daemon=True)
        thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.append_log("[stop] 已请求停止，当前视频处理完后会停下\n")

    def worker(self, records: list[dict], library: Path) -> None:
        mode = SPEED_MODES.get(self.mode_var.get(), SPEED_MODES["平衡"])
        apply_speed_mode(mode)
        folder_id = self.selected_folder_id()
        total = len(records)
        done = 0
        try:
            for index, record in enumerate(records, 1):
                if self.stop_event.is_set():
                    break
                bvid = str(record.get("bvid") or "")
                title = str(record.get("title") or bvid)
                self.queue.put(("status", (index - 1, total, f"{index}/{total} 生成套图: {title}")))
                try:
                    self.process_one(record, library, folder_id, mode)
                    done += 1
                    self.queue.put(("log", f"[ok] {bvid} {title}\n"))
                except Exception as exc:
                    self.queue.put(("log", f"[error] {bvid} {title}: {exc}\n"))
                self.queue.put(("status", (index, total, f"已完成 {index}/{total}")))
            self.queue.put(("done", f"完成 {done}/{total}"))
        except Exception as exc:
            self.queue.put(("done", f"异常结束: {exc}"))

    def process_one(self, record: dict, library: Path, folder_id: str, mode: dict) -> None:
        bvid = str(record.get("bvid") or "")
        record = process_record(record, library, folder_id, mode, import_to_eagle=self.import_var.get(), delete_source=self.delete_var.get())
        self.records[bvid] = record
        save_json(RECORDS_PATH, self.records)

    def drain_queue(self) -> None:
        while True:
            try:
                kind, value = self.queue.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                self.append_log(str(value))
            elif kind == "status":
                current, total, text = value
                self.progress_var.set(int(current * 100 / total) if total else 0)
                self.status_var.set(text)
            elif kind == "done":
                self.status_var.set(str(value))
                self.progress_var.set(100)
                self.start_btn.configure(state="normal")
                self.stop_btn.configure(state="disabled")
                self.reload_records()
        self.root.after(120, self.drain_queue)

    def open_exports(self) -> None:
        path = ROOT / "exports"
        path.mkdir(exist_ok=True)
        os.startfile(path)


def main() -> None:
    ensure_tkinter_loaded()
    root = Tk()
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    EagleBatchProcessor(root)
    root.mainloop()


if __name__ == "__main__":
    main()
