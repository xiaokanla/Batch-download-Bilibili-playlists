import base64
import datetime
import io
import json
import math
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import qrcode
import requests
from PIL import Image

import manager as manager_module
from manager import BiliManager
from utils import BiliResolver, WbiSigner
from worker import DownloadWorker


RESOURCE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(RESOURCE_DIR, "webui")
DEFAULT_USERDATA_DIR = os.path.join(APP_DIR, "userdata")
BOOTSTRAP_SETTINGS_PATH = os.path.join(DEFAULT_USERDATA_DIR, "app_settings.json")
APP_VERSION = "1.3.0-tag-cloud"
APP_FLAVOR = "release"


def bootstrap_userdata_dir():
    try:
        with open(BOOTSTRAP_SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        data_dir = str(data.get("dataDir") or "").strip()
        return data_dir if data_dir else DEFAULT_USERDATA_DIR
    except Exception:
        return DEFAULT_USERDATA_DIR


USERDATA_DIR = bootstrap_userdata_dir()
CACHE_DIR = os.path.join(USERDATA_DIR, "_web_cache")
DOWNLOAD_RECORDS_PATH = os.path.join(USERDATA_DIR, "download_records.json")
EAGLE_CONFIG_PATH = os.path.join(USERDATA_DIR, "eagle_config.json")
EAGLE_INDEX_PATH = os.path.join(USERDATA_DIR, "eagle_item_index.json")
BILI_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_title_search_cache.json")
BILI_CREATOR_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_creator_search_cache.json")
BILI_TAG_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_video_tags.json")
APP_SETTINGS_PATH = os.path.join(USERDATA_DIR, "app_settings.json")
EAGLE_DIR = os.path.join(RESOURCE_DIR, "eagle_integration")
if EAGLE_DIR not in sys.path:
    sys.path.insert(0, EAGLE_DIR)


def configure_userdata_paths(data_dir):
    """Keep all user-data files under the currently selected data directory."""
    global USERDATA_DIR, CACHE_DIR, DOWNLOAD_RECORDS_PATH
    global EAGLE_CONFIG_PATH, EAGLE_INDEX_PATH, BILI_SEARCH_CACHE_PATH
    global BILI_CREATOR_SEARCH_CACHE_PATH, BILI_TAG_CACHE_PATH, APP_SETTINGS_PATH

    USERDATA_DIR = os.path.abspath(str(data_dir or DEFAULT_USERDATA_DIR))
    CACHE_DIR = os.path.join(USERDATA_DIR, "_web_cache")
    DOWNLOAD_RECORDS_PATH = os.path.join(USERDATA_DIR, "download_records.json")
    EAGLE_CONFIG_PATH = os.path.join(USERDATA_DIR, "eagle_config.json")
    EAGLE_INDEX_PATH = os.path.join(USERDATA_DIR, "eagle_item_index.json")
    BILI_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_title_search_cache.json")
    BILI_CREATOR_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_creator_search_cache.json")
    BILI_TAG_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_video_tags.json")
    APP_SETTINGS_PATH = os.path.join(USERDATA_DIR, "app_settings.json")
    os.makedirs(USERDATA_DIR, exist_ok=True)


class WebBiliApp:
    def __init__(self):
        self.lock = threading.RLock()
        self.fav_data = {}
        self.fav_folders = []
        self.fav_videos = []
        self.manual_videos = []
        self.creator_videos = []
        self.creator_source = {"mid": "", "name": "", "total": 0}
        self.logs = []
        self.sync_progress = 0
        self.sync_running = False
        self.creator_sync_progress = 0
        self.creator_sync_running = False
        self.creator_search_lock = threading.Lock()
        self.last_creator_search_at = 0.0
        self.tag_task = {
            "running": False,
            "cancelled": False,
            "progress": 0,
            "total": 0,
            "done": 0,
            "cached": 0,
            "failed": 0,
            "status": "等待生成词云",
        }
        self.tag_cloud = {
            "source": "",
            "range": "",
            "month": "",
            "downloadedOnly": False,
            "items": 0,
            "itemsWithTags": 0,
            "tags": [],
            "tagBvids": {},
            "updatedAt": "",
        }
        self.worker = None
        os.makedirs(USERDATA_DIR, exist_ok=True)
        self.settings = {
            "dataDir": USERDATA_DIR,
            "downloadDir": "",
            "ffmpegPath": "",
            "ffprobePath": "",
            "aria2Path": "",
            "eagleExportDir": os.path.join(APP_DIR, "eagle_exports"),
            "errorLogPath": os.path.join(APP_DIR, "error_log.txt"),
        }
        self.settings.update(self.load_json_file(APP_SETTINGS_PATH, {}))
        self.settings["dataDir"] = self.settings.get("dataDir") or USERDATA_DIR
        configure_userdata_paths(self.settings["dataDir"])
        manager_module.BASE_DIR = USERDATA_DIR
        manager_module.NETSCAPE_TEMP = os.path.join(APP_DIR, "bili_netscape_temp.txt")
        manager_module.LAST_LOGIN_COOKIE = os.path.join(APP_DIR, "last_login_cookie.json")
        self.mgr = BiliManager()
        self.apply_runtime_paths()
        self.download_records = self.load_json_file(DOWNLOAD_RECORDS_PATH, {})
        self.bili_search_cache = self.load_json_file(BILI_SEARCH_CACHE_PATH, {})
        self.creator_search_cache = self.load_json_file(BILI_CREATOR_SEARCH_CACHE_PATH, {})
        if not isinstance(self.creator_search_cache, dict):
            self.creator_search_cache = {}
        self.tag_cache = self.load_json_file(BILI_TAG_CACHE_PATH, {})
        if not isinstance(self.tag_cache, dict):
            self.tag_cache = {}
        self.last_bili_search_at = 0.0
        eagle_defaults = {
            "libraryDir": "",
            "folderId": "",
            "speedMode": "\u5e73\u8861",
            "deleteAfterImport": True,
            "useDanmaku": True,
        }
        self.eagle = {**eagle_defaults, **self.load_json_file(EAGLE_CONFIG_PATH, {})}
        self.eagle_task = {
            "running": False,
            "total": 0,
            "done": 0,
            "percent": 0,
            "current": "",
            "status": "Idle",
            "stats": {"success": 0, "skipped": 0, "failed": 0},
            "errors": [],
            "paused": False,
            "cancelled": False,
            "type": "",
        }
        old_index = self.load_json_file(EAGLE_INDEX_PATH, {})
        self.eagle_index = {
            "library": old_index.get("library", "") if isinstance(old_index, dict) else "",
            "count": old_index.get("count", 0) if isinstance(old_index, dict) else 0,
            "generatedAt": old_index.get("generatedAt", "") if isinstance(old_index, dict) else "",
        }
        self.download = {
            "running": False,
            "total": 0,
            "file": 0,
            "title": "等待任务",
            "status": "Ready",
        }
        self.user = {"loggedIn": False, "name": "未登录", "mid": "guest"}
        self.env = self.check_env_tools()
        self.auto_login()

    def _reset_sidecar_files(self):
        targets = [
            os.path.join(APP_DIR, "last_login_cookie.json"),
            os.path.join(APP_DIR, "bili_netscape_temp.txt"),
            os.path.join(APP_DIR, "error_log.txt"),
        ]
        for path in targets:
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass

    def _remove_path(self, path):
        if not path:
            return
        try:
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            elif os.path.isfile(path):
                os.remove(path)
        except Exception:
            pass

    def _reset_data_tree(self, data_dir):
        if not data_dir:
            return
        data_dir = os.path.abspath(data_dir)
        try:
            if os.path.isdir(data_dir):
                shutil.rmtree(data_dir, ignore_errors=True)
            elif os.path.isfile(data_dir):
                os.remove(data_dir)
        except Exception:
            pass

    def reset_to_fresh_install(self):
        global USERDATA_DIR, CACHE_DIR, DOWNLOAD_RECORDS_PATH
        global EAGLE_CONFIG_PATH, EAGLE_INDEX_PATH, BILI_SEARCH_CACHE_PATH
        global BILI_CREATOR_SEARCH_CACHE_PATH, BILI_TAG_CACHE_PATH, APP_SETTINGS_PATH
        with self.lock:
            if self.sync_running or self.creator_sync_running or self.tag_task.get("running") or self.download.get("running") or self.eagle_task.get("running"):
                raise RuntimeError("请先停止正在运行的同步、词云、下载或 Eagle 任务")
            current_data_dir = os.path.abspath(self.settings.get("dataDir") or USERDATA_DIR)
        self._reset_data_tree(current_data_dir)
        self._reset_sidecar_files()
        self._remove_path(BOOTSTRAP_SETTINGS_PATH)
        USERDATA_DIR = DEFAULT_USERDATA_DIR
        CACHE_DIR = os.path.join(USERDATA_DIR, "_web_cache")
        DOWNLOAD_RECORDS_PATH = os.path.join(USERDATA_DIR, "download_records.json")
        EAGLE_CONFIG_PATH = os.path.join(USERDATA_DIR, "eagle_config.json")
        EAGLE_INDEX_PATH = os.path.join(USERDATA_DIR, "eagle_item_index.json")
        BILI_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_title_search_cache.json")
        BILI_CREATOR_SEARCH_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_creator_search_cache.json")
        BILI_TAG_CACHE_PATH = os.path.join(USERDATA_DIR, "bili_video_tags.json")
        APP_SETTINGS_PATH = os.path.join(USERDATA_DIR, "app_settings.json")
        manager_module.BASE_DIR = USERDATA_DIR
        manager_module.NETSCAPE_TEMP = os.path.join(APP_DIR, "bili_netscape_temp.txt")
        manager_module.LAST_LOGIN_COOKIE = os.path.join(APP_DIR, "last_login_cookie.json")
        with self.lock:
            self.settings = {
                "dataDir": USERDATA_DIR,
                "downloadDir": "",
                "ffmpegPath": "",
                "ffprobePath": "",
                "aria2Path": "",
                "eagleExportDir": os.path.join(APP_DIR, "eagle_exports"),
                "errorLogPath": os.path.join(APP_DIR, "error_log.txt"),
            }
            self.download_records = {}
            self.bili_search_cache = {}
            self.creator_search_cache = {}
            self.tag_cache = {}
            self.eagle = {
                "libraryDir": "",
                "folderId": "",
                "speedMode": "\u5e73\u8861",
                "deleteAfterImport": True,
                "useDanmaku": True,
            }
            self.eagle_index = {"library": "", "count": 0, "generatedAt": ""}
            self.download = {"running": False, "total": 0, "file": 0, "title": "等待任务", "status": "Ready"}
            self.fav_data = {}
            self.fav_folders = []
            self.fav_videos = []
            self.manual_videos = []
            self.creator_videos = []
            self.creator_source = {"mid": "", "name": "", "total": 0}
            self.logs = []
            self.sync_progress = 0
            self.sync_running = False
            self.creator_sync_progress = 0
            self.creator_sync_running = False
            self.tag_task = {
                "running": False,
                "cancelled": False,
                "progress": 0,
                "total": 0,
                "done": 0,
                "cached": 0,
                "failed": 0,
                "status": "等待生成词云",
            }
            self.tag_cloud = {
                "source": "",
                "range": "",
                "month": "",
                "downloadedOnly": False,
                "items": 0,
                "itemsWithTags": 0,
                "tags": [],
                "tagBvids": {},
                "updatedAt": "",
            }
            self.user = {"loggedIn": False, "name": "未登录", "mid": "guest"}
            self.eagle_task = {
                "running": False,
                "total": 0,
                "done": 0,
                "percent": 0,
                "current": "",
                "status": "Idle",
                "stats": {"success": 0, "skipped": 0, "failed": 0},
                "errors": [],
                "paused": False,
                "cancelled": False,
                "type": "",
            }
            self.save_json_file(APP_SETTINGS_PATH, self.settings)
            self._remove_path(BOOTSTRAP_SETTINGS_PATH)
            self.apply_runtime_paths()
            self.env = self.check_env_tools()
            try:
                self.mgr.logout()
            except Exception:
                pass
            self.mgr.init_paths()
        return {"ok": True, "message": "已恢复到初始状态。请刷新页面并重新登录。"}

    def load_json_file(self, path, default):
        if not os.path.exists(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, type(default)) else default
        except Exception:
            return default

    def save_json_file(self, path, data):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _valid_file(self, path):
        return bool(path) and os.path.isfile(str(path))

    def _valid_dir(self, path):
        return bool(path) and os.path.isdir(str(path))

    def apply_runtime_paths(self):
        configure_userdata_paths(self.settings.get("dataDir") or DEFAULT_USERDATA_DIR)
        manager_module.BASE_DIR = USERDATA_DIR
        if hasattr(self, "mgr"):
            self.mgr.init_paths()
            self.mgr.load_data()
        if hasattr(self, "download_records"):
            self.download_records = self.load_json_file(DOWNLOAD_RECORDS_PATH, {})
        if hasattr(self, "bili_search_cache"):
            self.bili_search_cache = self.load_json_file(BILI_SEARCH_CACHE_PATH, {})
        if hasattr(self, "creator_search_cache"):
            self.creator_search_cache = self.load_json_file(BILI_CREATOR_SEARCH_CACHE_PATH, {})
            if not isinstance(self.creator_search_cache, dict):
                self.creator_search_cache = {}
        if hasattr(self, "tag_cache"):
            self.tag_cache = self.load_json_file(BILI_TAG_CACHE_PATH, {})
            if not isinstance(self.tag_cache, dict):
                self.tag_cache = {}
        if hasattr(self, "eagle"):
            eagle_defaults = {
                "libraryDir": "",
                "folderId": "",
                "speedMode": "\u5e73\u8861",
                "deleteAfterImport": True,
                "useDanmaku": True,
            }
            self.eagle = {**eagle_defaults, **self.load_json_file(EAGLE_CONFIG_PATH, {})}
        if hasattr(self, "eagle_index"):
            old_index = self.load_json_file(EAGLE_INDEX_PATH, {})
            self.eagle_index = {
                "library": old_index.get("library", "") if isinstance(old_index, dict) else "",
                "count": old_index.get("count", 0) if isinstance(old_index, dict) else 0,
                "generatedAt": old_index.get("generatedAt", "") if isinstance(old_index, dict) else "",
            }
        mapping = {
            "BILI_FFMPEG_PATH": self.settings.get("ffmpegPath") or "",
            "BILI_FFPROBE_PATH": self.settings.get("ffprobePath") or "",
            "BILI_ARIA2_PATH": self.settings.get("aria2Path") or "",
            "BILI_EAGLE_EXPORT_DIR": self.settings.get("eagleExportDir") or os.path.join(EAGLE_DIR, "exports"),
            "BILI_ERROR_LOG": self.settings.get("errorLogPath") or os.path.join(APP_DIR, "error_log.txt"),
        }
        for key, value in mapping.items():
            if value:
                os.environ[key] = str(value)
            else:
                os.environ.pop(key, None)
        self.refresh_eagle_module_paths()

    def refresh_eagle_module_paths(self):
        export_dir = Path(os.environ.get("BILI_EAGLE_EXPORT_DIR") or os.path.join(EAGLE_DIR, "exports"))
        try:
            import export_to_eagle
            export_to_eagle.EXPORT_DIR = export_dir
            export_to_eagle.COVER_DIR = export_dir / "covers"
            export_to_eagle.MANIFEST_PATH = export_dir / "manifest.json"
        except Exception:
            pass
        try:
            import import_videos_to_eagle
            import_videos_to_eagle.VIDEO_MANIFEST_PATH = export_dir / "video_manifest.json"
            import_videos_to_eagle.CONTACT_SHEET_DIR = export_dir / "contact_sheets"
            import_videos_to_eagle.DANMAKU_CACHE_DIR = export_dir / "danmaku_cache"
        except Exception:
            pass

    def cache_path(self, fid):
        safe = re.sub(r"[^0-9A-Za-z_-]", "_", str(fid))
        os.makedirs(CACHE_DIR, exist_ok=True)
        return os.path.join(CACHE_DIR, f"fav_{safe}.json")

    def load_fav_cache(self, fid):
        path = self.cache_path(fid)
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def save_fav_cache(self, fid, videos):
        try:
            with open(self.cache_path(fid), "w", encoding="utf-8") as f:
                json.dump(videos, f, ensure_ascii=False)
        except Exception as exc:
            self.log(f"收藏夹缓存保存失败：{exc}")

    @staticmethod
    def _clean_tag_names(values):
        seen = set()
        result = []
        for value in values or []:
            name = re.sub(r"\s+", " ", str(value or "").strip())
            if not name or len(name) > 48:
                continue
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            result.append(name)
        return result[:40]

    def _tag_names_for_bvid(self, bvid):
        cached = self.tag_cache.get(str(bvid), {})
        if isinstance(cached, dict):
            return self._clean_tag_names(cached.get("tags"))
        if isinstance(cached, list):
            return self._clean_tag_names(cached)
        return []

    def _tag_source_items_locked(self, source):
        sources = {
            "fav": self.fav_videos,
            "creator": self.creator_videos,
            "manual": self.manual_videos,
        }
        if source not in sources:
            raise RuntimeError("无效的词云数据来源")
        return [dict(item) for item in sources[source] if str(item.get("bvid") or "").strip()]

    @staticmethod
    def _parse_video_date(value):
        try:
            return datetime.datetime.strptime(str(value or "")[:10], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return None

    def _tag_cloud_scope_locked(self, payload):
        source = str(payload.get("source") or "fav").strip()
        range_key = str(payload.get("range") or "12m").strip()
        month = str(payload.get("month") or "").strip()
        downloaded_only = bool(payload.get("downloadedOnly"))
        if range_key not in {"3m", "6m", "12m", "month"}:
            raise RuntimeError("无效的词云时间范围")
        if range_key == "month" and not re.fullmatch(r"\d{4}-\d{2}", month):
            raise RuntimeError("请选择要分析的月份")

        items = self._tag_source_items_locked(source)
        history = self.effective_history_set_locked()
        today = datetime.date.today()
        days_by_range = {"3m": 92, "6m": 184, "12m": 366}
        scoped = []
        seen = set()
        for item in items:
            bvid = str(item.get("bvid") or "").strip()
            if not bvid or bvid in seen:
                continue
            if downloaded_only and bvid not in history:
                continue
            video_date = self._parse_video_date(item.get("date"))
            if range_key == "month":
                if not video_date or item.get("month") != month:
                    continue
            elif not video_date or video_date < today - datetime.timedelta(days=days_by_range[range_key]):
                continue
            seen.add(bvid)
            scoped.append(item)
        return source, range_key, month, downloaded_only, scoped

    def _build_tag_cloud_locked(self, source, range_key, month, downloaded_only, items):
        counts = {}
        tag_bvids = {}
        items_with_tags = 0
        for item in items:
            bvid = str(item.get("bvid") or "").strip()
            tags = self._tag_names_for_bvid(bvid)
            if not tags:
                continue
            items_with_tags += 1
            for tag in tags:
                counts[tag] = counts.get(tag, 0) + 1
                tag_bvids.setdefault(tag, []).append(bvid)
        ordered = sorted(counts, key=lambda name: (-counts[name], name.casefold()))[:60]
        return {
            "source": source,
            "range": range_key,
            "month": month,
            "downloadedOnly": downloaded_only,
            "items": len(items),
            "itemsWithTags": items_with_tags,
            "tags": [{"name": name, "count": counts[name]} for name in ordered],
            "tagBvids": {name: tag_bvids[name] for name in ordered},
            "updatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        }

    def _fetch_video_tags(self, bvid):
        response = self.mgr.session.get(
            "https://api.bilibili.com/x/tag/archive/tags",
            params={"bvid": bvid},
            timeout=15,
        )
        if response.status_code in (403, 412, 429):
            raise RuntimeError("B 站暂时限制了标签读取，已停止词云生成")
        data = response.json()
        if data.get("code") in (-412, -352, 412, 352):
            raise RuntimeError("B 站暂时限制了标签读取，已停止词云生成")
        if data.get("code") != 0:
            raise RuntimeError(data.get("message", "读取视频标签失败"))
        return self._clean_tag_names(
            item.get("tag_name") or item.get("name")
            for item in (data.get("data") or [])
            if isinstance(item, dict)
        )

    def start_tag_cloud(self, payload):
        with self.lock:
            if self.sync_running or self.creator_sync_running:
                raise RuntimeError("请等待当前收藏夹或投稿同步结束后再生成词云")
            if self.tag_task.get("running"):
                raise RuntimeError("词云生成任务正在运行")
            source, range_key, month, downloaded_only, items = self._tag_cloud_scope_locked(payload)
            if not items:
                raise RuntimeError("当前时间范围内没有可分析的视频")
            missing_bvids = [
                str(item.get("bvid") or "").strip()
                for item in items
                if str(item.get("bvid") or "").strip() not in self.tag_cache
            ]
            cached_count = len(items) - len(missing_bvids)
            self.tag_cloud = self._build_tag_cloud_locked(source, range_key, month, downloaded_only, items)
            self.tag_task = {
                "running": bool(missing_bvids),
                "cancelled": False,
                "progress": 1 if not missing_bvids else 0,
                "total": len(missing_bvids),
                "done": 0,
                "cached": cached_count,
                "failed": 0,
                "status": "已使用本地标签缓存" if not missing_bvids else "准备低频读取视频标签",
            }
        if not missing_bvids:
            self.log(f"词云已从本地缓存生成：{len(items)} 个视频")
            return {"started": False, "cached": cached_count, "total": len(items)}

        def _task():
            failed = 0
            stopped_by_risk = False
            try:
                self.log(f"开始低频读取视频标签：{len(missing_bvids)} 个待补齐，缓存 {cached_count} 个")
                time.sleep(random.uniform(1.4, 2.6))
                for index, bvid in enumerate(missing_bvids, start=1):
                    with self.lock:
                        if self.tag_task.get("cancelled"):
                            break
                    if index > 1:
                        time.sleep(random.uniform(1.15, 1.9))
                    try:
                        tags = self._fetch_video_tags(bvid)
                        with self.lock:
                            self.tag_cache[bvid] = {
                                "tags": tags,
                                "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
                            }
                    except Exception as exc:
                        failed += 1
                        text = str(exc)
                        self.log(f"标签读取跳过 {bvid}: {text[:120]}")
                        if "限制" in text or "风控" in text:
                            stopped_by_risk = True
                    with self.lock:
                        self.tag_task["done"] = index
                        self.tag_task["failed"] = failed
                        self.tag_task["progress"] = index / len(missing_bvids)
                        self.tag_task["status"] = "已检测到风控，正在停止" if stopped_by_risk else f"正在读取标签 {index}/{len(missing_bvids)}"
                        if index % 8 == 0:
                            self.save_json_file(BILI_TAG_CACHE_PATH, self.tag_cache)
                    if stopped_by_risk:
                        break
            finally:
                with self.lock:
                    self.save_json_file(BILI_TAG_CACHE_PATH, self.tag_cache)
                    self.tag_cloud = self._build_tag_cloud_locked(source, range_key, month, downloaded_only, items)
                    cancelled = bool(self.tag_task.get("cancelled"))
                    self.tag_task["running"] = False
                    self.tag_task["progress"] = 1 if not stopped_by_risk and not cancelled else self.tag_task.get("progress", 0)
                    if stopped_by_risk:
                        self.tag_task["status"] = "已因风控停止，已缓存的标签仍可使用"
                    elif cancelled:
                        self.tag_task["status"] = "已取消，已读取的标签已保存"
                    else:
                        self.tag_task["status"] = f"词云已生成，失败 {failed} 个"
                if stopped_by_risk:
                    self.log("词云标签读取因风控响应停止")
                elif cancelled:
                    self.log("词云标签读取已取消")
                else:
                    self.log(f"词云生成完成：{len(items)} 个视频，标签覆盖 {self.tag_cloud['itemsWithTags']} 个")

        threading.Thread(target=_task, daemon=True).start()
        return {"started": True, "cached": cached_count, "total": len(items)}

    def cancel_tag_cloud(self):
        with self.lock:
            if self.tag_task.get("running"):
                self.tag_task["cancelled"] = True
                self.tag_task["status"] = "正在取消词云生成..."
        return {"ok": True}

    def normalize_url(self, url):
        if not url:
            return ""
        if url.startswith("//"):
            return "https:" + url
        if url.startswith("http://"):
            return "https://" + url[len("http://"):]
        return url

    @staticmethod
    def duration_to_seconds(value):
        text = str(value or "").strip()
        if not text:
            return 0
        try:
            return int(float(text))
        except (TypeError, ValueError):
            pass
        parts = text.split(":")
        try:
            seconds = 0
            for part in parts:
                seconds = seconds * 60 + int(part)
            return seconds
        except (TypeError, ValueError):
            return 0

    def check_env_tools(self):
        ffmpeg_candidates = [
            self.settings.get("ffmpegPath") or os.environ.get("BILI_FFMPEG_PATH") or "",
            os.path.join(APP_DIR, "ffmpeg.exe"),
            os.path.join(RESOURCE_DIR, "ffmpeg.exe"),
        ]
        ffprobe_candidates = [
            self.settings.get("ffprobePath") or os.environ.get("BILI_FFPROBE_PATH") or "",
            os.path.join(APP_DIR, "ffprobe.exe"),
            os.path.join(RESOURCE_DIR, "ffprobe.exe"),
        ]
        aria2_candidates = [
            self.settings.get("aria2Path") or os.environ.get("BILI_ARIA2_PATH") or "",
            os.path.join(APP_DIR, "aria2c.exe"),
            os.path.join(RESOURCE_DIR, "aria2c.exe"),
        ]
        return {
            "ffmpeg": any(self._valid_file(path) for path in ffmpeg_candidates) or shutil.which("ffmpeg") is not None,
            "ffprobe": any(self._valid_file(path) for path in ffprobe_candidates) or shutil.which("ffprobe") is not None,
            "aria2": any(self._valid_file(path) for path in aria2_candidates) or shutil.which("aria2c") is not None,
        }

    def _tool_diagnostic(self, key, executable_name, configured_path, bundled_name, required=True):
        candidates = [
            configured_path or "",
            os.path.join(APP_DIR, bundled_name),
            os.path.join(RESOURCE_DIR, bundled_name),
            shutil.which(executable_name) or "",
        ]
        seen = set()
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            if os.path.isfile(candidate) or shutil.which(candidate):
                version = ""
                try:
                    proc = subprocess.run(
                        [candidate, "-version"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        encoding="utf-8",
                        errors="ignore",
                        timeout=4,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    )
                    version = (proc.stdout or "").splitlines()[0][:120] if proc.stdout else ""
                except Exception:
                    version = "已找到，但版本信息读取失败"
                return {
                    "key": key,
                    "level": "ok",
                    "title": f"{key} 可用",
                    "detail": candidate,
                    "extra": version,
                }
        level = "error" if required else "warn"
        return {
            "key": key,
            "level": level,
            "title": f"{key} 未检测到",
            "detail": "请在路径设置中选择可执行文件，或把它放在程序目录旁边。",
            "extra": "",
        }

    def _dir_diagnostic(self, key, title, path, required=True):
        if not path:
            return {
                "key": key,
                "level": "error" if required else "warn",
                "title": f"{title}未设置",
                "detail": "请在路径设置中选择目录。",
                "extra": "",
            }
        try:
            os.makedirs(path, exist_ok=True)
            test_path = os.path.join(path, ".bili_write_test")
            with open(test_path, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(test_path)
            return {"key": key, "level": "ok", "title": f"{title}可写", "detail": path, "extra": ""}
        except Exception as exc:
            return {"key": key, "level": "error", "title": f"{title}不可写", "detail": path, "extra": str(exc)}

    def _file_parent_diagnostic(self, key, title, path):
        if not path:
            return {"key": key, "level": "warn", "title": f"{title}未设置", "detail": "会使用程序目录下的默认日志。", "extra": ""}
        parent = os.path.dirname(path) or "."
        result = self._dir_diagnostic(key, title, parent, required=True)
        result["title"] = f"{title}目录可写" if result["level"] == "ok" else f"{title}目录不可写"
        result["detail"] = path
        return result

    def run_diagnostics(self):
        with self.lock:
            settings = dict(self.settings)
            eagle_cfg = dict(self.eagle)
            user = dict(self.user)
            index = dict(self.eagle_index)
        items = [
            self._tool_diagnostic("FFmpeg", "ffmpeg", settings.get("ffmpegPath"), "ffmpeg.exe", required=True),
            self._tool_diagnostic("FFprobe", "ffprobe", settings.get("ffprobePath"), "ffprobe.exe", required=True),
            self._tool_diagnostic("Aria2", "aria2c", settings.get("aria2Path"), "aria2c.exe", required=False),
            self._dir_diagnostic("dataDir", "程序数据目录", settings.get("dataDir"), required=True),
            self._dir_diagnostic("downloadDir", "默认下载目录", settings.get("downloadDir"), required=False),
            self._dir_diagnostic("eagleExportDir", "Eagle 缓存目录", settings.get("eagleExportDir"), required=True),
            self._file_parent_diagnostic("errorLogPath", "错误日志", settings.get("errorLogPath")),
        ]
        if user.get("loggedIn"):
            items.append({"key": "login", "level": "ok", "title": "B站登录状态可用", "detail": user.get("name") or "", "extra": ""})
        else:
            items.append({"key": "login", "level": "warn", "title": "尚未登录 B站", "detail": "公开收藏夹可尝试同步；私密收藏夹和高清视频下载通常需要扫码登录。", "extra": ""})

        library_dir = eagle_cfg.get("libraryDir") or ""
        if library_dir:
            is_library = os.path.isdir(library_dir) and library_dir.lower().endswith(".library")
            items.append({
                "key": "eagleLibrary",
                "level": "ok" if is_library else "warn",
                "title": "Eagle 库路径已设置" if is_library else "Eagle 库路径可能不正确",
                "detail": library_dir,
                "extra": "请选择以 .library 结尾的 Eagle 库目录。" if not is_library else "",
            })
        else:
            items.append({"key": "eagleLibrary", "level": "warn", "title": "未设置 Eagle 库", "detail": "仅影响 Eagle 导入和封面替换。", "extra": ""})

        try:
            from export_to_eagle import EAGLE_API, eagle_available
            eagle_online = eagle_available(EAGLE_API)
            items.append({
                "key": "eagleApi",
                "level": "ok" if eagle_online else "warn",
                "title": "Eagle 本地 API 在线" if eagle_online else "Eagle 本地 API 未连接",
                "detail": EAGLE_API,
                "extra": "" if eagle_online else "需要先打开 Eagle，再执行导入或替换封面。",
            })
        except Exception as exc:
            items.append({"key": "eagleApi", "level": "warn", "title": "Eagle 检测失败", "detail": str(exc), "extra": ""})

        items.append({
            "key": "eagleIndex",
            "level": "ok" if index.get("count") else "warn",
            "title": "Eagle 索引已建立" if index.get("count") else "Eagle 索引未建立",
            "detail": f"{index.get('count', 0)} 项",
            "extra": index.get("generatedAt") or "库文件夹变化后建议刷新索引。",
        })

        rank = {"error": 2, "warn": 1, "ok": 0}
        summary_level = max((rank.get(item["level"], 0) for item in items), default=0)
        summary = {2: "需要处理", 1: "可用但有建议", 0: "状态良好"}[summary_level]
        return {"ok": True, "summary": summary, "items": items}

    def log(self, message):
        with self.lock:
            self.logs.append({"time": datetime.datetime.now().strftime("%H:%M:%S"), "text": str(message)})
            self.logs = self.logs[-400:]

    def public_state(self):
        with self.lock:
            effective_history = self.effective_history_set_locked()
            return {
                "user": self.user,
                "env": self.env,
                "favData": self.fav_data,
                "favFolders": self.fav_folders,
                "favVideos": self.fav_videos,
                "manualVideos": self.manual_videos,
                "creatorVideos": self.creator_videos,
                "creatorSource": self.creator_source,
                "tagCloud": self.tag_cloud,
                "tagTask": self.tag_task,
                "history": list(effective_history),
                "downloadRecords": self.download_records,
                "settings": self.settings,
                "eagle": self.eagle,
                "eagleTask": self.eagle_task,
                "eagleIndex": self.eagle_index,
                "logs": self.logs[-160:],
                "sync": {"running": self.sync_running, "progress": self.sync_progress},
                "creatorSync": {"running": self.creator_sync_running, "progress": self.creator_sync_progress},
                "download": self.download,
                "build": {"version": APP_VERSION, "flavor": APP_FLAVOR},
            }

    def set_app_settings(self, payload):
        allowed = {
            "dataDir",
            "downloadDir",
            "ffmpegPath",
            "ffprobePath",
            "aria2Path",
            "eagleExportDir",
            "errorLogPath",
        }
        with self.lock:
            for key in allowed:
                if key in payload:
                    self.settings[key] = str(payload.get(key) or "").strip()
            self.settings["dataDir"] = self.settings.get("dataDir") or USERDATA_DIR
            if self.settings.get("dataDir"):
                os.makedirs(self.settings["dataDir"], exist_ok=True)
            if self.settings.get("eagleExportDir"):
                os.makedirs(self.settings["eagleExportDir"], exist_ok=True)
            if self.settings.get("errorLogPath"):
                os.makedirs(os.path.dirname(self.settings["errorLogPath"]), exist_ok=True)
            self.save_json_file(APP_SETTINGS_PATH, self.settings)
            # Keep a copy in the selected directory so the data directory is
            # portable when it is moved to another computer.
            self.save_json_file(
                os.path.join(os.path.abspath(self.settings["dataDir"]), "app_settings.json"),
                self.settings,
            )
            if os.path.abspath(os.path.dirname(APP_SETTINGS_PATH)) != os.path.abspath(DEFAULT_USERDATA_DIR):
                self.save_json_file(BOOTSTRAP_SETTINGS_PATH, self.settings)
            elif os.path.abspath(self.settings["dataDir"]) != os.path.abspath(USERDATA_DIR):
                self.save_json_file(BOOTSTRAP_SETTINGS_PATH, self.settings)
            self.apply_runtime_paths()
            self.env = self.check_env_tools()
        return {"ok": True, "settings": self.settings, "env": self.env}

    def effective_history_set_locked(self):
        effective_history = set(self.mgr.history)
        if isinstance(self.download_records, dict):
            for bvid, record in self.download_records.items():
                if not bvid or record.get("manualUndone") is True:
                    continue
                eagle = record.get("eagle") or {}
                if record.get("downloadedAt") or record.get("path") or eagle.get("imported"):
                    effective_history.add(str(bvid))
        return effective_history

    def effective_history_set(self):
        with self.lock:
            return self.effective_history_set_locked()

    def auto_login(self):
        def _task():
            try:
                data = self.mgr.session.get("https://api.bilibili.com/x/web-interface/nav", timeout=15).json()
                if data.get("code") == 0:
                    mid = data["data"]["mid"]
                    uname = data["data"].get("uname", str(mid))
                    self.mgr.switch_user(mid)
                    self.mgr.load_data()
                    with self.lock:
                        self.user = {"loggedIn": True, "name": uname, "mid": str(mid)}
                    self.fetch_fav_folders(mid)
                    self.log(f"已登录：{uname}")
                else:
                    self.mgr.switch_user("guest")
            except Exception:
                pass
        threading.Thread(target=_task, daemon=True).start()

    def fetch_fav_folders(self, mid=None):
        if mid is None:
            mid = self.user.get("mid")
        if not mid or mid == "guest":
            return {}
        data = self.mgr.session.get(f"https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={mid}", timeout=15).json()
        if data.get("code") == 0:
            fav_folders = [{"name": item["title"], "fid": item["id"]} for item in data["data"]["list"]]
            fav_data = {item["name"]: item["fid"] for item in fav_folders}
            with self.lock:
                self.fav_data = fav_data
                self.fav_folders = fav_folders
            return fav_data
        raise RuntimeError(data.get("message", "获取收藏夹失败"))

    def qr_login_generate(self):
        data = self.mgr.session.get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", timeout=15).json()
        url = data["data"]["url"]
        key = data["data"]["qrcode_key"]
        qr = qrcode.QRCode()
        qr.add_data(url)
        qr.make()
        img = qr.make_image()
        buf = io.BytesIO()
        img.save(buf, "PNG")
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"key": key, "image": f"data:image/png;base64,{encoded}"}

    def qr_login_poll(self, key):
        data = self.mgr.session.get(f"https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={key}", timeout=15).json()
        code = data.get("data", {}).get("code")
        if code == 0:
            self.auto_login()
        return data.get("data", {})

    def logout(self):
        self.mgr.logout()
        with self.lock:
            self.user = {"loggedIn": False, "name": "未登录", "mid": "guest"}
            self.fav_data = {}
            self.fav_folders = []
            self.fav_videos = []
            self.creator_videos = []
            self.creator_source = {"mid": "", "name": "", "keyword": "", "total": 0}
        self.log("已退出登录")

    def import_external_fav(self, value):
        fid = None
        for pattern in [r"fid=(\d+)", r"ml(\d+)", r"^(\d+)$"]:
            match = re.search(pattern, value.strip())
            if match:
                fid = match.group(1)
                break
        if not fid:
            raise RuntimeError("无法识别收藏夹 ID")
        params = {"media_id": fid, "pn": 1, "ps": 1}
        img_key, sub_key = WbiSigner.get_wbi_keys(self.mgr.session)
        if img_key and sub_key:
            params = WbiSigner.enc_wbi(params, img_key, sub_key)
        data = self.mgr.session.get("https://api.bilibili.com/x/v3/fav/resource/list", params=params, timeout=15).json()
        if data.get("code") != 0:
            raise RuntimeError(data.get("message", "获取收藏夹失败"))
        title = data["data"]["info"]["title"]
        display = f"[外部] {title}"
        with self.lock:
            self.fav_data[display] = fid
            if not any(str(item["fid"]) == str(fid) for item in self.fav_folders):
                self.fav_folders.append({"name": display, "fid": fid})
        self.log(f"已导入外部收藏夹：{title}")
        return {"name": display, "fid": fid}

    def sync_fav(self, fid):
        if self.sync_running:
            raise RuntimeError("收藏夹同步正在进行")

        def _task():
            with self.lock:
                self.sync_running = True
                self.sync_progress = 0
            videos = []
            page_size = 20
            api_url = "https://api.bilibili.com/x/v3/fav/resource/list"
            cached_videos = self.load_fav_cache(fid)
            cached_by_bvid = {item.get("bvid"): item for item in cached_videos}
            cached_bvids = set(cached_by_bvid)
            first_sync = not cached_bvids
            # A new device has no local cache. Keep the first pass deliberately
            # serial and slow to avoid a burst immediately after login.
            request_gap = (1.35, 2.65) if first_sync else (0.75, 1.55)
            first_request_delay = random.uniform(1.2, 2.4) if first_sync else random.uniform(0.4, 1.0)
            if first_sync:
                # WBI key discovery is also a Bilibili request. Delay it too,
                # otherwise the list request would still follow login abruptly.
                time.sleep(first_request_delay)
            img_key, sub_key = WbiSigner.get_wbi_keys(self.mgr.session)
            headers = dict(self.mgr.session.headers)
            cookies = self.mgr.session.cookies.get_dict()

            def build_params(page):
                params = {"media_id": fid, "pn": page, "ps": page_size, "keyword": "", "order": "mtime", "type": 0, "tid": 0, "platform": "web"}
                if img_key and sub_key:
                    params = WbiSigner.enc_wbi(params, img_key, sub_key)
                return params

            def parse_medias(medias):
                items = []
                for media in medias:
                    dt = datetime.datetime.fromtimestamp(media["fav_time"])
                    items.append({
                        "title": media["title"],
                        "bvid": media["bvid"],
                        "date": dt.strftime("%Y-%m-%d"),
                        "year": dt.strftime("%Y"),
                        "month": dt.strftime("%Y-%m"),
                        "duration": media.get("duration", 0),
                        "cover": self.normalize_url(media.get("cover") or media.get("pic") or media.get("upper", {}).get("face") or ""),
                    })
                return items

            def fetch_page(page):
                delay = first_request_delay if page == 1 else random.uniform(*request_gap)
                time.sleep(delay)
                sess = self.mgr.session
                sess.headers.update(headers)
                sess.cookies.update(cookies)
                result = sess.get(api_url, params=build_params(page), timeout=15).json()
                if result.get("code") != 0:
                    if result.get("code") in (-412, -352, 412, 352):
                        raise RuntimeError(f"疑似触发风控，已停止同步：{result.get('message', '未知错误')}")
                    raise RuntimeError(result.get("message", "未知错误"))
                data = result.get("data") or {}
                medias = data.get("medias") or []
                info = data.get("info") or {}
                return page, parse_medias(medias), int(info.get("media_count") or len(medias))

            try:
                self.log("开始同步收藏夹")
                _, first_items, total_count = fetch_page(1)
                videos.extend(first_items)
                total_pages = max(1, math.ceil(total_count / page_size)) if first_items else 1
                incremental = bool(cached_bvids)
                if incremental:
                    self.log(f"收藏夹共 {total_count} 个视频，发现本地缓存，优先增量同步")
                else:
                    self.log(f"收藏夹共 {total_count} 个视频，首次同步采用低频串行模式，避免触发风控")
                with self.lock:
                    self.sync_progress = 1 / total_pages

                if incremental:
                    page = 2
                    overlap_hits = sum(1 for item in first_items if item.get("bvid") in cached_bvids)
                    max_incremental_pages = min(total_pages, 12)
                    while page <= max_incremental_pages and overlap_hits < 6:
                        try:
                            _, items, _ = fetch_page(page)
                            videos.extend(items)
                            overlap_hits += sum(1 for item in items if item.get("bvid") in cached_bvids)
                            with self.lock:
                                self.sync_progress = min(0.95, page / total_pages)
                            page += 1
                        except Exception as page_error:
                            if "疑似触发风控" in str(page_error):
                                self.log(str(page_error))
                                return
                            self.log(f"第 {page} 页增量同步失败：{page_error}")
                            break
                    if overlap_hits >= 6:
                        seen = {item["bvid"] for item in videos}
                        videos.extend([item for item in cached_videos if item.get("bvid") not in seen])
                        videos = videos[:total_count] if total_count else videos
                        self.log(f"增量同步完成：请求 {page - 1} 页，复用缓存 {max(0, len(videos) - len(seen))} 条")
                    else:
                        self.log("缓存命中不足，切换完整同步")
                        videos = first_items[:]
                        incremental = False

                if (not incremental) and total_pages > 1:
                    page_results = {}
                    failed_pages = []
                    done_pages = 1
                    for page_no in range(2, total_pages + 1):
                        try:
                            _, items, _ = fetch_page(page_no)
                            page_results[page_no] = items
                        except Exception as page_error:
                            if "疑似触发风控" in str(page_error):
                                self.log(str(page_error))
                                return
                            failed_pages.append(page_no)
                            self.log(f"第 {page_no} 页同步失败：{page_error}")
                        done_pages += 1
                        with self.lock:
                            self.sync_progress = done_pages / total_pages
                    for page_no in failed_pages:
                        try:
                            _, items, _ = fetch_page(page_no)
                            page_results[page_no] = items
                        except Exception as retry_error:
                            self.log(f"第 {page_no} 页同步失败：{retry_error}")
                    for page_no in sorted(page_results):
                        videos.extend(page_results[page_no])
                with self.lock:
                    self.fav_videos = videos
                    self.sync_progress = 1
                self.save_fav_cache(fid, videos)
                if total_count and len(videos) < total_count:
                    self.log(f"同步完成但数量偏少：已获取 {len(videos)} / 接口显示 {total_count}，可能有失效/私密/风控页")
                else:
                    self.log(f"同步完成：{len(videos)} 个视频")
            except Exception as exc:
                self.log(f"同步失败：{exc}")
            finally:
                with self.lock:
                    self.sync_running = False
        threading.Thread(target=_task, daemon=True).start()
        return {"started": True}

    def search_creator_accounts(self, value):
        query = str(value or "").strip()
        if not query:
            raise RuntimeError("请输入账号名称、UID 或主页链接")
        if len(query) > 120:
            raise RuntimeError("账号查询内容过长")

        cache_key = re.sub(r"\s+", " ", query).casefold()
        cache_ttl = 60 * 60 * 24 * 7

        # Search results are safe to reuse for a short period. This prevents
        # switching between the same account names from issuing duplicate
        # requests and also makes the UI recover cleanly after a rate limit.
        with self.creator_search_lock:
            now = time.time()
            cached = self.creator_search_cache.get(cache_key)
            if isinstance(cached, dict) and now - float(cached.get("time") or 0) < cache_ttl:
                results = cached.get("results")
                if isinstance(results, list):
                    self.log(f"账号检索命中缓存：{query} · {len(results)} 个候选")
                    return {"results": results, "cached": True}

            wait = 1.8 - (now - self.last_creator_search_at)
            if wait > 0:
                time.sleep(wait + random.uniform(0.1, 0.35))
            self.last_creator_search_at = time.time()

            # Resolve an explicit UID locally first; account-name search is
            # still only one low-frequency request and never starts a crawl.
            mid_match = re.search(r"space\.bilibili\.com/(\d+)", query, flags=re.IGNORECASE)
            if not mid_match and re.fullmatch(r"\d{1,20}", query):
                mid_match = re.match(r"(\d+)", query)

            if mid_match:
                mid = mid_match.group(1)
                data = self.mgr.session.get(
                    "https://api.bilibili.com/x/web-interface/card",
                    params={"mid": mid},
                    timeout=15,
                ).json()
                if data.get("code") in (-412, -352, 412, 352):
                    raise RuntimeError("B 站暂时限制了账号查询，请稍后再试")
                if data.get("code") != 0:
                    raise RuntimeError(data.get("message", "获取账号信息失败"))
                card = (data.get("data") or {}).get("card") or {}
                if not card:
                    raise RuntimeError("没有找到该账号")
                results = [{
                    "mid": str(card.get("mid") or mid),
                    "name": card.get("name") or mid,
                    "face": self.normalize_url(card.get("face") or ""),
                    "fans": int(card.get("fans") or 0),
                }]
            else:
                data = self.mgr.session.get(
                    "https://api.bilibili.com/x/web-interface/search/type",
                    params={"search_type": "bili_user", "keyword": query, "page": 1, "page_size": 10},
                    timeout=15,
                ).json()
                if data.get("code") in (-412, -352, 412, 352):
                    raise RuntimeError("B 站暂时限制了账号搜索，请稍后再试")
                if data.get("code") != 0:
                    raise RuntimeError(data.get("message", "搜索账号失败"))
                results = []
                for item in (data.get("data") or {}).get("result") or []:
                    mid = str(item.get("mid") or "").strip()
                    if not mid:
                        continue
                    results.append({
                        "mid": mid,
                        "name": re.sub(r"<[^>]+>", "", str(item.get("uname") or mid)),
                        "face": self.normalize_url(item.get("upic") or item.get("face") or ""),
                        "fans": int(item.get("fans") or 0),
                    })

            with self.lock:
                self.creator_search_cache[cache_key] = {
                    "time": time.time(),
                    "query": query,
                    "results": results[:20],
                }
                self.save_json_file(BILI_CREATOR_SEARCH_CACHE_PATH, self.creator_search_cache)

            self.log(f"账号检索完成：{len(results)} 个候选")
            return {"results": results, "cached": False}

    def sync_creator_videos(self, payload):
        mid = re.sub(r"\D", "", str(payload.get("mid") or ""))
        name = re.sub(r"\s+", " ", str(payload.get("name") or "").strip())[:80]
        if not mid:
            raise RuntimeError("请先选择一个账号")
        with self.lock:
            if self.sync_running or self.creator_sync_running:
                raise RuntimeError("已有 B 站列表同步任务在运行，请等待结束后再试")
            self.creator_sync_running = True
            self.creator_sync_progress = 0

        def parse_videos(items):
            videos = []
            for item in items:
                bvid = str(item.get("bvid") or "").strip()
                if not bvid:
                    continue
                created = int(item.get("created") or 0)
                dt = datetime.datetime.fromtimestamp(created) if created else datetime.datetime.now()
                videos.append({
                    "title": re.sub(r"<[^>]+>", "", str(item.get("title") or bvid)),
                    "bvid": bvid,
                    "date": dt.strftime("%Y-%m-%d"),
                    "year": dt.strftime("%Y"),
                    "month": dt.strftime("%Y-%m"),
                    "duration": self.duration_to_seconds(item.get("length") or item.get("duration")),
                    "cover": self.normalize_url(item.get("pic") or item.get("cover") or ""),
                })
            return videos

        def _task():
            page_size = 50
            api_url = "https://api.bilibili.com/x/space/wbi/arc/search"
            videos = []
            try:
                self.log(f"开始获取账号投稿：{name or mid}")
                # The login/session request and first list page are deliberately
                # separated. All pages remain serial and stop at risk-control codes.
                time.sleep(random.uniform(1.2, 2.2))
                img_key, sub_key = WbiSigner.get_wbi_keys(self.mgr.session)

                def fetch_page(page):
                    params = {
                        "mid": mid,
                        "pn": page,
                        "ps": page_size,
                        "tid": 0,
                        "keyword": "",
                        "order": "pubdate",
                        "platform": "web",
                        "web_location": 1550101,
                    }
                    if img_key and sub_key:
                        params = WbiSigner.enc_wbi(params, img_key, sub_key)
                    response = self.mgr.session.get(api_url, params=params, timeout=15).json()
                    if response.get("code") in (-412, -352, 412, 352):
                        raise RuntimeError("疑似触发风控，已停止获取账号投稿")
                    if response.get("code") != 0:
                        raise RuntimeError(response.get("message", "获取投稿失败"))
                    data = response.get("data") or {}
                    page_data = data.get("page") or {}
                    return parse_videos((data.get("list") or {}).get("vlist") or []), int(page_data.get("count") or 0)

                first_items, total = fetch_page(1)
                videos.extend(first_items)
                total_pages = max(1, math.ceil(total / page_size)) if first_items else 1
                with self.lock:
                    self.creator_sync_progress = 1 / total_pages
                for page in range(2, total_pages + 1):
                    time.sleep(random.uniform(1.35, 2.45))
                    items, _ = fetch_page(page)
                    videos.extend(items)
                    with self.lock:
                        self.creator_sync_progress = page / total_pages
                unique_videos = []
                seen = set()
                for item in videos:
                    if item["bvid"] in seen:
                        continue
                    seen.add(item["bvid"])
                    unique_videos.append(item)
                videos = unique_videos
                with self.lock:
                    self.creator_videos = videos
                    self.creator_source = {"mid": mid, "name": name or mid, "total": total}
                    self.creator_sync_progress = 1
                self.log(f"账号投稿获取完成：{len(videos)} 个视频")
            except Exception as exc:
                self.log(f"账号投稿获取失败：{exc}")
            finally:
                with self.lock:
                    self.creator_sync_running = False

        threading.Thread(target=_task, daemon=True).start()
        return {"started": True}

    def import_collection(self, value):
        bvids = self.resolve_bvids(value, limit=1)
        match = bvids[0] if bvids else None
        if not match:
            raise RuntimeError("无法识别 BV 号")
        bvid = match
        data = self.mgr.session.get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}", timeout=15).json()
        if data.get("code") != 0:
            raise RuntimeError(data.get("message", "API 请求失败"))
        season = data["data"].get("ugc_season")
        if not season:
            raise RuntimeError("该视频不属于合集")
        title = season.get("title", "未知合集")
        existing = {v["bvid"] for v in self.manual_videos}
        new_items = []
        for section in season.get("sections", []):
            for episode in section.get("episodes", []):
                ep_bvid = episode.get("bvid")
                if not ep_bvid or ep_bvid in existing:
                    continue
                arc = episode.get("arc", {})
                dt = datetime.datetime.fromtimestamp(arc.get("pubdate", time.time()))
                new_items.append({
                    "title": episode.get("title", ep_bvid),
                    "bvid": ep_bvid,
                    "date": dt.strftime("%Y-%m-%d"),
                    "year": dt.strftime("%Y"),
                    "month": title[:15],
                    "duration": arc.get("duration", 0),
                    "cover": episode.get("cover") or arc.get("pic") or "",
                })
        with self.lock:
            for item in reversed(new_items):
                self.manual_videos.insert(0, item)
        self.log(f"已导入合集：{len(new_items)} 个视频")
        return {"count": len(new_items)}

    def resolve_aid_to_bvid(self, aid):
        try:
            data = self.mgr.session.get(f"https://api.bilibili.com/x/web-interface/view?aid={aid}", timeout=15).json()
            if data.get("code") == 0:
                return data.get("data", {}).get("bvid")
        except Exception:
            return None
        return None

    def resolve_bvids(self, value, limit=80):
        text = str(value or "").strip()
        found = []

        def add_bvid(bvid):
            if bvid and bvid not in found:
                found.append(bvid)

        for bvid in re.findall(r"BV[0-9A-Za-z]{10}", text):
            add_bvid(bvid)
        for aid in re.findall(r"(?:av|aid=)(\d+)", text, flags=re.IGNORECASE):
            add_bvid(self.resolve_aid_to_bvid(aid))

        if found or not re.match(r"https?://|bilibili://", text):
            return found[:limit]

        try:
            headers = {
                "User-Agent": self.mgr.session.headers.get("User-Agent", "Mozilla/5.0"),
                "Referer": "https://www.bilibili.com/",
            }
            resp = self.mgr.session.get(text, headers=headers, timeout=15, allow_redirects=True)
            page_text = resp.text
            final_url = resp.url
            for source in (final_url, page_text):
                for bvid in re.findall(r"BV[0-9A-Za-z]{10}", source):
                    add_bvid(bvid)
                for aid in re.findall(r'"aid"\s*:\s*(\d+)|aid=(\d+)|av(\d+)', source, flags=re.IGNORECASE):
                    aid_value = next((x for x in aid if x), "")
                    add_bvid(self.resolve_aid_to_bvid(aid_value))
                if len(found) >= limit:
                    break
        except Exception as exc:
            self.log(f"特殊链接解析失败：{exc}")
        return found[:limit]

    def build_video_item(self, bvid):
        title = f"Extracted_{bvid}"
        cover = ""
        duration = 0
        try:
            data = self.mgr.session.get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}", timeout=15).json()
            if data.get("code") == 0:
                info = data.get("data") or {}
                title = info.get("title") or title
                cover = self.normalize_url(info.get("pic") or "")
                duration = info.get("duration") or 0
        except Exception:
            _, _, duration = BiliResolver.get_video_stream(bvid, self.mgr.session)
        item = {
            "title": title,
            "bvid": bvid,
            "date": datetime.datetime.now().strftime("%Y-%m-%d"),
            "year": "M",
            "month": "Manual",
            "duration": duration or 0,
            "cover": cover,
        }
        return item

    def extract_video(self, value):
        bvids = self.resolve_bvids(value)
        if not bvids:
            raise RuntimeError("无法识别 BV/av 号；如果是活动页，请确认链接可公开访问")
        existing = {v["bvid"] for v in self.manual_videos}
        new_items = []
        for bvid in bvids:
            if bvid in existing:
                continue
            try:
                new_items.append(self.build_video_item(bvid))
            except Exception as exc:
                self.log(f"提取 {bvid} 失败：{exc}")
        with self.lock:
            for item in reversed(new_items):
                self.manual_videos.insert(0, item)
        self.log(f"已从链接提取 {len(new_items)} 个视频")
        return {"items": new_items, "count": len(new_items), "found": len(bvids)}

    def mark_items(self, bvids, done):
        with self.lock:
            for bvid in bvids:
                if done:
                    self.mgr.history.add(bvid)
                    if bvid in self.download_records:
                        self.download_records[bvid].pop("manualUndone", None)
                else:
                    self.mgr.history.discard(bvid)
                    if bvid in self.download_records:
                        self.download_records[bvid]["manualUndone"] = True
            self.mgr.save_data()
            self.save_json_file(DOWNLOAD_RECORDS_PATH, self.download_records)
        return {"ok": True}

    def delete_items(self, bvids):
        bset = set(bvids)
        with self.lock:
            self.fav_videos = [item for item in self.fav_videos if item["bvid"] not in bset]
            self.manual_videos = [item for item in self.manual_videos if item["bvid"] not in bset]
            self.creator_videos = [item for item in self.creator_videos if item["bvid"] not in bset]
        return {"ok": True}

    def choose_file(self):
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askopenfilename(
            title="选择下载记录文件",
            filetypes=[
                ("BiliDownloader 记录包", "*.json"),
                ("所有 JSON 文件", "*.json"),
                ("所有文件", "*.*"),
            ]
        )
        root.destroy()
        return {"path": path}

    def choose_dir(self):
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askdirectory()
        root.destroy()
        return {"path": path}

    def import_history(self, path):
        if not path:
            raise RuntimeError("请选择 history.json 或旧程序 userdata 文件夹")
        if os.path.isdir(path):
            candidates = [
                os.path.join(path, "download_records.json"),
                os.path.join(path, "bili_history_bundle.json"),
                os.path.join(path, "history.json"),
                os.path.join(path, "bili_history.json"),
            ]
            path = next((p for p in candidates if os.path.exists(p)), "")
        if not path or not os.path.exists(path):
            raise RuntimeError("未找到可导入的历史记录文件")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        imported_records = {}
        values = []
        if isinstance(data, list):
            # Legacy export: a plain list of BV ids.
            values = data
        elif isinstance(data, dict):
            values = data.get("history") or data.get("bvids") or data.get("items") or []
            bundle_records = data.get("downloadRecords") or data.get("records")
            if isinstance(bundle_records, dict):
                imported_records.update(bundle_records)
            elif isinstance(bundle_records, list):
                for record in bundle_records:
                    if isinstance(record, dict):
                        bvid = str(record.get("bvid") or "").strip()
                        if bvid:
                            imported_records[bvid] = record

            # Also accept the native download_records.json format, whose keys
            # are BV ids and whose values contain title/path/downloadedAt.
            if not imported_records and not values:
                for key, record in data.items():
                    bvid = str(record.get("bvid") or key).strip() if isinstance(record, dict) else str(key).strip()
                    if re.match(r"^BV[a-zA-Z0-9]+$", bvid) and isinstance(record, dict):
                        imported_records[bvid] = {**record, "bvid": bvid}

        bvids = {
            str(x.get("bvid") if isinstance(x, dict) else x).strip()
            for x in values
            if re.match(r"^BV[a-zA-Z0-9]+$", str(x.get("bvid") if isinstance(x, dict) else x).strip())
        }
        bvids.update(
            bvid for bvid in imported_records
            if re.match(r"^BV[a-zA-Z0-9]+$", str(bvid).strip())
        )
        if not bvids:
            raise RuntimeError("文件中没有识别到可导入的 BV 记录")

        with self.lock:
            before = set(self.effective_history_set_locked())
            self.mgr.history.update(bvids)
            for bvid, record in imported_records.items():
                if not re.match(r"^BV[a-zA-Z0-9]+$", str(bvid).strip()) or not isinstance(record, dict):
                    continue
                normalized = {**record, "bvid": str(bvid).strip()}
                old = self.download_records.get(str(bvid), {})
                if isinstance(old, dict):
                    normalized = {**old, **normalized}
                self.download_records[str(bvid).strip()] = normalized
            self.mgr.save_data()
            self.save_json_file(DOWNLOAD_RECORDS_PATH, self.download_records)
            after = set(self.effective_history_set_locked())
        added = len(after - before)
        self.log(f"导入下载记录：新增 {added} 条，总计 {len(after)} 条，完整记录 {len(imported_records)} 条")
        return {"added": added, "total": len(after), "records": len(imported_records)}

    def export_history(self, path):
        if not path:
            raise RuntimeError("请选择导出目录")
        if os.path.isdir(path):
            path = os.path.join(path, "bili_history_bundle.json")
        with self.lock:
            data = {
                "format": "bili_downloader_history_bundle",
                "version": 2,
                "exportedAt": datetime.datetime.now().isoformat(timespec="seconds"),
                "history": sorted(self.effective_history_set_locked()),
                "downloadRecords": self.download_records if isinstance(self.download_records, dict) else {},
            }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        count = len(data["history"])
        record_count = len(data["downloadRecords"])
        self.log(f"已导出完整下载记录：{path}（{count} 条历史，{record_count} 条详细记录）")
        return {"path": path, "count": count, "records": record_count}

    def open_history_location(self):
        os.makedirs(USERDATA_DIR, exist_ok=True)
        target = DOWNLOAD_RECORDS_PATH if os.path.exists(DOWNLOAD_RECORDS_PATH) else USERDATA_DIR
        if os.name == "nt":
            if os.path.isfile(target):
                subprocess.Popen(["explorer", f"/select,{target}"])
            else:
                os.startfile(target)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
        self.log(f"已打开下载记录位置：{target}")
        return {"path": target, "dir": USERDATA_DIR}

    def record_download(self, bvid, item=None, file_path=""):
        if not bvid:
            return
        item = item or {}
        now = datetime.datetime.now().isoformat(timespec="seconds")
        with self.lock:
            old = self.download_records.get(bvid, {}) if isinstance(self.download_records, dict) else {}
            record = {
                **old,
                "bvid": bvid,
                "title": item.get("title") or old.get("title") or bvid,
                "cover": self.normalize_url(item.get("cover") or item.get("pic") or old.get("cover") or ""),
                "duration": item.get("duration", old.get("duration", "")),
                "date": item.get("date") or old.get("date") or "",
                "month": item.get("month") or old.get("month") or "",
                "path": file_path or old.get("path") or "",
                "downloadedAt": now,
                "eagle": old.get("eagle") or {"imported": False},
            }
            if file_path:
                record["eagle"] = {**record.get("eagle", {}), "imported": False, "error": ""}
            record.pop("manualUndone", None)
            self.download_records[bvid] = record
            self.mgr.history.add(bvid)
            self.mgr.save_data()
            self.save_json_file(DOWNLOAD_RECORDS_PATH, self.download_records)
        self.cache_danmaku_xml_async(bvid)

    def cache_danmaku_xml_async(self, bvid):
        if not bvid:
            return

        def _task():
            try:
                from import_videos_to_eagle import DANMAKU_CACHE_DIR, danmaku_xml_cache_path, parse_danmaku_xml_times

                DANMAKU_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                xml_path = danmaku_xml_cache_path(bvid)
                if xml_path.exists() and xml_path.stat().st_size > 0:
                    return
                headers = {
                    "User-Agent": self.mgr.session.headers.get("User-Agent", "Mozilla/5.0"),
                    "Referer": "https://www.bilibili.com/",
                }
                page_resp = self.mgr.session.get(
                    "https://api.bilibili.com/x/player/pagelist",
                    params={"bvid": bvid},
                    headers=headers,
                    timeout=12,
                )
                page_resp.raise_for_status()
                pages = (page_resp.json().get("data") or [])
                cid = pages[0].get("cid") if pages else None
                if not cid:
                    return
                time.sleep(random.uniform(0.2, 0.6))
                dm_resp = self.mgr.session.get(
                    "https://api.bilibili.com/x/v1/dm/list.so",
                    params={"oid": cid},
                    headers=headers,
                    timeout=15,
                )
                dm_resp.raise_for_status()
                parse_danmaku_xml_times(dm_resp.content)
                xml_path.write_bytes(dm_resp.content)
                self.log(f"Danmaku XML cached: {bvid}")
            except Exception as exc:
                self.log(f"Danmaku XML cache skipped {bvid}: {str(exc)[:120]}")

        threading.Thread(target=_task, daemon=True).start()

    def set_eagle_config(self, payload):
        with self.lock:
            if "libraryDir" in payload:
                self.eagle["libraryDir"] = payload.get("libraryDir") or ""
            if "folderId" in payload:
                self.eagle["folderId"] = payload.get("folderId") or ""
            if "speedMode" in payload:
                self.eagle["speedMode"] = payload.get("speedMode") or "平衡"
            if "deleteAfterImport" in payload:
                self.eagle["deleteAfterImport"] = bool(payload.get("deleteAfterImport"))
            if "useDanmaku" in payload:
                self.eagle["useDanmaku"] = bool(payload.get("useDanmaku"))
            self.save_json_file(EAGLE_CONFIG_PATH, self.eagle)
        return {"ok": True, "eagle": self.eagle}

    def get_eagle_folders(self, payload):
        from one_click_eagle_thumbnail import load_library_folders

        library_dir = payload.get("libraryDir") or self.eagle.get("libraryDir") or ""
        if not library_dir or not Path(library_dir).exists():
            raise RuntimeError("Eagle 库目录无效")
        folders = load_library_folders(Path(library_dir))
        return {"folders": folders}

    def refresh_eagle_index(self, payload):
        from eagle_batch_processor import refresh_eagle_index

        library_dir = payload.get("libraryDir") or self.eagle.get("libraryDir") or ""
        if not library_dir or not Path(library_dir).exists():
            raise RuntimeError("Eagle library dir is invalid")
        data = refresh_eagle_index(Path(library_dir))
        with self.lock:
            self.eagle_index = {
                "library": data.get("library") or "",
                "count": data.get("count") or 0,
                "generatedAt": data.get("generatedAt") or "",
            }
        self.log(f"Eagle index refreshed: {self.eagle_index['count']} items")
        return {"ok": True, "index": self.eagle_index}

    def _eagle_set_task(self, **updates):
        with self.lock:
            self.eagle_task.update(updates)

    def _eagle_task_error(self, message):
        with self.lock:
            errors = list(self.eagle_task.get("errors") or [])
            errors.append(str(message))
            self.eagle_task["errors"] = errors[-20:]
            stats = dict(self.eagle_task.get("stats") or {})
            stats["failed"] = int(stats.get("failed") or 0) + 1
            self.eagle_task["stats"] = stats

    def _eagle_task_stat(self, key, amount=1):
        with self.lock:
            stats = dict(self.eagle_task.get("stats") or {})
            stats[key] = int(stats.get(key) or 0) + int(amount)
            self.eagle_task["stats"] = stats

    def _eagle_should_stop(self):
        return bool(self.eagle_task.get("cancelled")) or not bool(self.eagle_task.get("running"))

    def _eagle_wait_if_paused(self):
        while self.eagle_task.get("paused") and not self.eagle_task.get("cancelled"):
            self._eagle_set_task(status="Paused")
            time.sleep(0.3)

    def pause_eagle_task(self, payload):
        paused = bool(payload.get("paused", True))
        with self.lock:
            if self.eagle_task.get("running"):
                self.eagle_task["paused"] = paused
                if not paused and self.eagle_task.get("status") == "Paused":
                    self.eagle_task["status"] = "Resuming"
        return {"ok": True, "paused": paused}

    def cancel_eagle_task(self):
        with self.lock:
            if self.eagle_task.get("running"):
                self.eagle_task["cancelled"] = True
                self.eagle_task["paused"] = False
                self.eagle_task["status"] = "Cancelling"
        return {"ok": True}

    def _clean_bili_title(self, value):
        value = re.sub(r"<[^>]+>", "", str(value or ""))
        value = value.replace("&quot;", '"').replace("&amp;", "&").replace("&#39;", "'")
        return value.strip()

    def _aid_to_bvid_local(self, aid):
        try:
            x = int(aid)
        except Exception:
            return ""
        table = list("fZodR9XQDSUm21yCkvt3qwe4pN6sJx8bB5g7h")
        positions = [11, 10, 3, 8, 4, 6]
        xor = 177451812
        add = 8728348608
        value = (x ^ xor) + add
        result = list("BV1  4 1 7  ")
        for index, pos in enumerate(positions):
            result[pos] = table[value // (58 ** index) % 58]
        return "".join(result)

    def _title_variants(self, title):
        from import_videos_to_eagle import normalize_text

        raw = str(title or "").strip()
        variants = {raw}
        cleaned = raw
        cleaned = re.sub(r"\b(?:av|Av|AV)\d+\b", " ", cleaned)
        cleaned = re.sub(r"\bP\d+\b|\bp\d+\b", " ", cleaned)
        cleaned = re.sub(r"[（(]\s*(?:中|日|韩|英|繁中|简中|官方中字)\s*[)）]", " ", cleaned)
        cleaned = re.sub(r"【\s*(?:中|日|韩|英|繁中|简中|官方中字)\s*】", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" -_｜|")
        variants.add(cleaned)

        parts = re.split(r"\s+p\d+\s+|\s+P\d+\s+", raw)
        variants.update(part.strip(" -_｜|") for part in parts if part.strip())
        for marker in ("【中】", "【日】", "【韩】", "【英】", "（中文版）", "(中文版)"):
            if marker in raw:
                tail = raw.split(marker, 1)[-1].strip()
                if tail:
                    variants.add(tail)
        normalized = []
        for value in variants:
            key = normalize_text(value)
            if key and key not in normalized:
                normalized.append(key)
        return normalized

    def _bili_title_search(self, title):
        from import_videos_to_eagle import normalize_text

        title = str(title or "").strip()
        cache_key = normalize_text(title)
        if not cache_key:
            return []
        now = time.time()
        cached = self.bili_search_cache.get(cache_key) if isinstance(self.bili_search_cache, dict) else None
        if isinstance(cached, dict) and now - float(cached.get("time") or 0) < 60 * 60 * 24 * 30:
            return cached.get("results") or []

        wait = 1.15 - (now - self.last_bili_search_at)
        if wait > 0:
            time.sleep(wait + random.uniform(0.05, 0.35))
        self.last_bili_search_at = time.time()

        params = {"search_type": "video", "keyword": title, "page": 1}
        headers = {
            "Referer": "https://search.bilibili.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        }
        data = self.mgr.session.get(
            "https://api.bilibili.com/x/web-interface/search/type",
            params=params,
            headers=headers,
            timeout=15,
        )
        try:
            data = data.json()
        except Exception:
            raise RuntimeError(f"Bilibili search returned non-JSON response ({getattr(data, 'status_code', 'unknown')})")
        if data.get("code") not in (0, None):
            raise RuntimeError(f"Bilibili search returned code {data.get('code')}: {data.get('message') or ''}")
        results = []
        for item in ((data.get("data") or {}).get("result") or []):
            bvid = str(item.get("bvid") or "").strip()
            found_title = self._clean_bili_title(item.get("title") or "")
            if bvid and found_title:
                results.append({"bvid": bvid, "title": found_title, "cover": self.normalize_url(item.get("pic") or "")})
        with self.lock:
            self.bili_search_cache[cache_key] = {"time": time.time(), "results": results[:20]}
            self.save_json_file(BILI_SEARCH_CACHE_PATH, self.bili_search_cache)
        return results

    def _strict_bili_match_by_title(self, title, allowed_bvids):
        from import_videos_to_eagle import normalize_text

        normalized = normalize_text(title or "")
        if not normalized:
            return None, "empty title"
        results = self._bili_title_search(title)
        exact = [item for item in results if normalize_text(item.get("title") or "") == normalized]
        if len(exact) != 1:
            return None, f"title search returned {len(exact)} exact matches"
        bvid = str(exact[0].get("bvid") or "")
        if bvid not in allowed_bvids:
            return None, f"{bvid} not in downloaded history"
        return exact[0], ""

    def _load_known_video_records(self):
        records = {}
        if isinstance(self.download_records, dict):
            for bvid, record in self.download_records.items():
                if bvid and isinstance(record, dict):
                    records[str(bvid)] = {**record, "bvid": str(bvid)}

        def merge_item(item, source=""):
            if not isinstance(item, dict):
                return
            bvid = str(item.get("bvid") or item.get("BV") or "").strip()
            if not bvid.startswith("BV"):
                return
            old = records.get(bvid, {})
            records[bvid] = {
                **item,
                **old,
                "bvid": bvid,
                "title": old.get("title") or item.get("title") or item.get("name") or bvid,
                "cover": old.get("cover") or self.normalize_url(item.get("cover") or item.get("pic") or ""),
                "duration": old.get("duration") or item.get("duration") or "",
                "date": old.get("date") or item.get("date") or "",
                "month": old.get("month") or item.get("month") or "",
                "_source": old.get("_source") or source,
            }

        for cache_path in Path(CACHE_DIR).glob("fav_*.json"):
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(data, list):
                for item in data:
                    merge_item(item, str(cache_path))

        for manifest_path in [
            Path(EAGLE_DIR) / "exports" / "manifest.json",
            Path(EAGLE_DIR) / "exports" / "video_manifest.json",
        ]:
            if not manifest_path.exists():
                continue
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(data, list):
                for item in data:
                    merge_item(item, str(manifest_path))
        return records

    def _build_download_record_title_index(self, records=None):
        index = {}
        records = records or self._load_known_video_records()
        for bvid, record in records.items():
            if not bvid or not isinstance(record, dict):
                continue
            for key in self._title_variants(record.get("title") or ""):
                index.setdefault(key, set()).add(str(bvid))
        return index

    def _build_eagle_item_record_index(self, records=None):
        index = {}
        records = records or self._load_known_video_records()
        for bvid, record in records.items():
            if not bvid or not isinstance(record, dict):
                continue
            item_id = str((record.get("eagle") or {}).get("itemId") or record.get("eagle_id") or "").strip()
            if item_id:
                index[item_id] = str(bvid)
        return index

    def _match_eagle_video_to_record(self, item, title, allowed_bvids, title_index, item_index):
        eagle_id = str(item.get("eagle_id") or "").strip()
        if eagle_id and item_index.get(eagle_id) in allowed_bvids:
            return {"bvid": item_index[eagle_id], "cover": ""}, "eagle-item-id"

        local_bvids = sorted(str(x) for x in (item.get("bvids") or set()) if str(x) in allowed_bvids)
        if len(local_bvids) == 1:
            return {"bvid": local_bvids[0], "cover": ""}, "local-bvid"
        if len(local_bvids) > 1:
            return None, f"multiple local bvids: {', '.join(local_bvids[:4])}"

        text = "\n".join(str(x or "") for x in [title, item.get("search_text")])
        av_bvids = sorted({
            self._aid_to_bvid_local(match)
            for match in re.findall(r"(?:av|Av|AV)(\d+)|aid=(\d+)", text)
            for match in ([match] if isinstance(match, str) else [x for x in match if x])
        })
        av_bvids = [bvid for bvid in av_bvids if bvid in allowed_bvids]
        if len(av_bvids) == 1:
            return {"bvid": av_bvids[0], "cover": ""}, "local-av"
        if len(av_bvids) > 1:
            return None, f"multiple av bvids: {', '.join(av_bvids[:4])}"

        local_title_bvids = set()
        for key in self._title_variants(title or ""):
            local_title_bvids.update(title_index.get(key) or [])
        local_title_bvids = sorted(local_title_bvids)
        local_title_bvids = [bvid for bvid in local_title_bvids if bvid in allowed_bvids]
        if len(local_title_bvids) == 1:
            return {"bvid": local_title_bvids[0], "cover": ""}, "local-title"
        if len(local_title_bvids) > 1:
            return None, f"download history has {len(local_title_bvids)} same-title records"

        match, reason = self._strict_bili_match_by_title(title, allowed_bvids)
        return match, reason

    def _record_eagle_result(self, bvid, eagle_data):
        with self.lock:
            record = self.download_records.get(bvid)
            if not record:
                return
            record["eagle"] = {**(record.get("eagle") or {}), **eagle_data}
            self.download_records[bvid] = record
            self.save_json_file(DOWNLOAD_RECORDS_PATH, self.download_records)

    def _find_eagle_item(self, library_dir, bvid, title, source_path, timeout=10):
        from apply_contact_sheets_to_eagle import find_library_items

        deadline = time.time() + timeout
        source_name = Path(source_path).stem if source_path else ""
        while time.time() < deadline:
            try:
                items = find_library_items(Path(library_dir))
            except Exception:
                items = []
            candidates = sorted(items, key=lambda x: x["metadata"].get("lastModified", 0), reverse=True)
            for item in candidates:
                meta = item.get("metadata") or {}
                text = item.get("search_text") or ""
                if source_path and str(source_path) in text:
                    return item
                if source_name and source_name in text:
                    return item
                if title and title == str(meta.get("name") or ""):
                    return item
            for item in candidates:
                text = item.get("search_text") or ""
                if bvid and bvid in text:
                    return item
            time.sleep(0.7)
        return None

    def _ensure_eagle_folder(self, item, library_dir, folder_id):
        if not folder_id:
            return
        metadata = item.get("metadata") or {}
        folders = [str(x) for x in metadata.get("folders", []) or []]
        if str(folder_id) in folders:
            return
        folders.append(str(folder_id))
        metadata["folders"] = folders
        metadata["lastModified"] = int(time.time() * 1000)
        metadata_path = item.get("metadata_path")
        if metadata_path:
            with open(metadata_path, "w", encoding="utf-8") as f:
                json.dump(metadata, f, ensure_ascii=False, separators=(",", ":"))
        mtime_path = Path(library_dir) / "mtime.json"
        try:
            mtime = self.load_json_file(str(mtime_path), {})
            mtime[str(item.get("id") or "")] = metadata["lastModified"]
            mtime["all"] = 1
            self.save_json_file(str(mtime_path), mtime)
        except Exception:
            pass

    def _import_one_record_to_eagle(self, record, library_dir, folder_id, delete_after, use_danmaku, progress_cb=None, force_rebuild=False):
        from eagle_batch_processor import SPEED_MODES, apply_speed_mode, process_record
        from export_to_eagle import EAGLE_API, eagle_available

        def stage(name, ratio):
            if progress_cb:
                progress_cb(name, ratio)

        bvid = str(record.get("bvid") or "").strip()
        title = str(record.get("title") or bvid or "Bilibili")
        source = Path(str(record.get("path") or ""))
        stage("Checking source", 0.03)
        if not bvid:
            raise RuntimeError("missing bvid")
        if not source.exists() or not source.is_file():
            raise RuntimeError(f"local video not found: {source}")
        library_path = Path(str(library_dir or ""))
        if not library_path.exists():
            raise RuntimeError("invalid Eagle library dir")
        if folder_id:
            from one_click_eagle_thumbnail import load_library_folders
            folder_ids = {str(item.get("id")) for item in load_library_folders(library_path)}
            if str(folder_id) not in folder_ids:
                raise RuntimeError(f"Eagle target folder not found: {folder_id}")
        if not eagle_available(EAGLE_API):
            raise RuntimeError("Eagle API is not reachable. Please open Eagle first.")

        speed_mode = self.eagle.get("speedMode") or "\u5e73\u8861"
        mode = dict(SPEED_MODES.get(speed_mode, SPEED_MODES["\u5e73\u8861"]))
        mode["danmaku"] = bool(use_danmaku)
        apply_speed_mode(mode)
        stage("Generating contact sheet", 0.14)
        stage("Importing to Eagle", 0.58)
        updated = process_record(
            record,
            library_path,
            str(folder_id) if folder_id else "",
            mode,
            import_to_eagle=True,
            delete_source=delete_after,
        )
        stage("Saving record", 0.98)
        self._record_eagle_result(bvid, updated.get("eagle") or {})

    def _apply_thumbnail_to_eagle_item(self, item, library_dir, bvid, record, source, title, use_danmaku):
        from apply_contact_sheets_to_eagle import apply_match
        from eagle_batch_processor import SPEED_MODES, apply_speed_mode
        from export_to_eagle import VideoItem
        from import_videos_to_eagle import generate_contact_sheet

        speed_mode = self.eagle.get("speedMode") or "\u5e73\u8861"
        mode = dict(SPEED_MODES.get(speed_mode, SPEED_MODES["\u5e73\u8861"]))
        mode["danmaku"] = bool(use_danmaku)
        apply_speed_mode(mode)
        bvid = str(bvid or "").strip()
        video = VideoItem(
            title=record.get("title") or title or bvid,
            bvid=bvid,
            date=record.get("date") or "",
            month=record.get("month") or "",
            duration=record.get("duration") or "",
            cover=self.normalize_url(record.get("cover") or ""),
            source=str(source),
        )
        sheet = generate_contact_sheet(
            Path(source),
            video,
            frame_count=int(mode["frames"]),
            columns=int(mode["columns"]),
            width=int(mode["width"]),
            overwrite=True,
            use_danmaku=bool(mode.get("danmaku")),
        )
        info_dir = Path(source).parent
        match_item = {
            "id": item.get("eagle_id"),
            "info_dir": info_dir,
            "metadata_path": info_dir / "metadata.json",
            "metadata": item.get("metadata") or {},
            "thumbnail_path": item.get("thumbnail_path"),
            "search_text": item.get("search_text") or "",
        }
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        apply_match({"entry": {"bvid": bvid}, "item": match_item, "contact_sheet": sheet}, Path(library_dir), stamp)
        if bvid:
            self._record_eagle_result(bvid, {"imported": True, "itemId": item.get("eagle_id"), "thumbnailUpdatedAt": datetime.datetime.now().isoformat(timespec="seconds")})

    def start_eagle_folder_thumbnails(self, payload):
        with self.lock:
            if self.eagle_task.get("running"):
                raise RuntimeError("Eagle task is already running")
        library_dir = payload.get("libraryDir") or self.eagle.get("libraryDir") or ""
        folder_id = payload.get("folderId") or self.eagle.get("folderId") or ""
        use_danmaku = bool(payload.get("useDanmaku", self.eagle.get("useDanmaku", True)))
        speed_mode = payload.get("speedMode") or self.eagle.get("speedMode") or "\u5e73\u8861"
        force = bool(payload.get("force"))
        self.set_eagle_config({
            "libraryDir": library_dir,
            "folderId": folder_id,
            "speedMode": speed_mode,
            "useDanmaku": use_danmaku,
        })
        library_path = Path(str(library_dir or ""))
        if not library_path.exists():
            raise RuntimeError("Eagle library dir is invalid")
        if not folder_id:
            raise RuntimeError("Please select an Eagle folder first")

        from import_videos_to_eagle import scan_eagle_library_videos
        from one_click_eagle_thumbnail import filter_items_by_folders, folder_descendant_ids, load_library_folders

        folders = load_library_folders(library_path)
        allowed = folder_descendant_ids(folders, {str(folder_id)})
        items = filter_items_by_folders(scan_eagle_library_videos(library_path), allowed)
        if not force:
            items = [item for item in items if not (item.get("metadata") or {}).get("customThumbnail")]
        if not items:
            raise RuntimeError("No local videos need thumbnail generation in selected Eagle folder")

        with self.lock:
            allowed_bvids = set(str(x) for x in self.effective_history_set_locked())
            known_records = self._load_known_video_records()
            records_by_bvid = dict(known_records)
            title_index = self._build_download_record_title_index(known_records)
            item_index = self._build_eagle_item_record_index(known_records)

        def _task():
            previous_headless = os.environ.get("BILI_WEB_HEADLESS")
            os.environ["BILI_WEB_HEADLESS"] = "1"
            total = len(items)
            self._eagle_set_task(
                running=True,
                total=total,
                done=0,
                percent=0,
                current="",
                status="Preparing folder thumbnails",
                stats={"success": 0, "skipped": 0, "failed": 0},
                errors=[],
                paused=False,
                cancelled=False,
                type="folder-thumbnails",
            )
            try:
                for index, item in enumerate(items, 1):
                    self._eagle_wait_if_paused()
                    if self._eagle_should_stop():
                        break
                    metadata = item.get("metadata") or {}
                    source = item.get("source_path")
                    title = str(metadata.get("name") or (Path(source).stem if source else "")).strip()
                    self._eagle_set_task(done=index - 1, percent=(index - 1) / total, current=title, status=f"{index}/{total} Matching record")
                    try:
                        if not source or not Path(source).exists():
                            raise RuntimeError("local video missing")
                        try:
                            match, reason = self._match_eagle_video_to_record(item, title, allowed_bvids, title_index, item_index)
                        except Exception as match_exc:
                            match, reason = None, str(match_exc)
                        if not match:
                            bvid = ""
                            record = {"title": title, "cover": ""}
                            item_use_danmaku = False
                            self.log(f"Eagle folder thumbnail local-only: {title} ({reason})")
                        else:
                            bvid = str(match.get("bvid") or "")
                            record = dict(records_by_bvid.get(bvid) or {})
                            record["bvid"] = bvid
                            record["title"] = record.get("title") or title
                            record["cover"] = self.normalize_url(record.get("cover") or match.get("cover") or "")
                            item_use_danmaku = use_danmaku
                        self._eagle_set_task(done=index - 1, percent=(index - 0.45) / total, current=title, status=f"{index}/{total} Generating thumbnail")
                        self._apply_thumbnail_to_eagle_item(item, library_dir, bvid, record, source, title, item_use_danmaku)
                        self._eagle_task_stat("success")
                        self.log(f"Eagle folder thumbnail updated: {bvid or 'local-only'} {title}")
                    except Exception as exc:
                        msg = f"{title}: {exc}"
                        self._eagle_task_error(msg)
                        self.log(f"Eagle folder thumbnail skipped: {msg}")
                    self._eagle_set_task(done=index, percent=index / total)
                status = "Cancelled" if self.eagle_task.get("cancelled") else "Done"
                self._eagle_set_task(running=False, current="", status=status, percent=(self.eagle_task.get("percent") or 0 if status == "Cancelled" else 1), paused=False)
            except Exception as exc:
                self._eagle_task_error(exc)
                self._eagle_set_task(running=False, current="", status="Error", paused=False)
            finally:
                if previous_headless is None:
                    os.environ.pop("BILI_WEB_HEADLESS", None)
                else:
                    os.environ["BILI_WEB_HEADLESS"] = previous_headless

        threading.Thread(target=_task, daemon=True).start()
        return {"started": True, "total": len(items)}
    def start_eagle_import(self, payload):
        with self.lock:
            if self.eagle_task.get("running"):
                raise RuntimeError("Eagle 导入任务正在运行")
        library_dir = payload.get("libraryDir") or self.eagle.get("libraryDir") or ""
        folder_id = payload.get("folderId") or self.eagle.get("folderId") or ""
        delete_after = bool(payload.get("deleteAfterImport", self.eagle.get("deleteAfterImport", True)))
        use_danmaku = bool(payload.get("useDanmaku", self.eagle.get("useDanmaku", True)))
        speed_mode = payload.get("speedMode") or self.eagle.get("speedMode") or "\u5e73\u8861"
        force = bool(payload.get("force"))
        bvids = set(payload.get("bvids") or [])
        self.set_eagle_config({
            "libraryDir": library_dir,
            "folderId": folder_id,
            "speedMode": speed_mode,
            "deleteAfterImport": delete_after,
            "useDanmaku": use_danmaku,
        })

        with self.lock:
            records = list(self.download_records.values()) if isinstance(self.download_records, dict) else []
        if bvids:
            records = [item for item in records if item.get("bvid") in bvids]
        records = [
            item for item in records
            if item.get("path") and os.path.exists(str(item.get("path")))
            and (force or not (item.get("eagle") or {}).get("imported"))
        ]
        if not records:
            raise RuntimeError("没有可导入的视频：需要已下载、源文件仍存在、且尚未导入 Eagle")

        def _task():
            previous_headless = os.environ.get("BILI_WEB_HEADLESS")
            os.environ["BILI_WEB_HEADLESS"] = "1"
            total = len(records)
            self._eagle_set_task(running=True, total=total, done=0, percent=0, current="", status="Preparing", stats={"success": 0, "skipped": 0, "failed": 0}, errors=[], paused=False, cancelled=False, type="import")
            try:
                for index, record in enumerate(records, 1):
                    self._eagle_wait_if_paused()
                    if self._eagle_should_stop():
                        break
                    bvid = record.get("bvid") or ""
                    title = record.get("title") or bvid
                    base_done = index - 1

                    def item_progress(stage_name, ratio):
                        ratio = max(0, min(0.99, float(ratio or 0)))
                        percent = (base_done + ratio) / total
                        self._eagle_set_task(
                            done=base_done,
                            percent=percent,
                            current=title,
                            status=f"{index}/{total} {stage_name}",
                        )

                    item_progress("Starting", 0)
                    try:
                        self._import_one_record_to_eagle(record, library_dir, folder_id, delete_after, use_danmaku, item_progress, force)
                        self._eagle_task_stat("success")
                        self.log(f"Eagle 导入完成：{title}")
                    except Exception as exc:
                        msg = f"{bvid} {title}: {exc}"
                        self._record_eagle_result(bvid, {"imported": False, "error": str(exc)})
                        self._eagle_task_error(msg)
                        self.log(f"Eagle 导入跳过：{msg}")
                    self._eagle_set_task(done=index, percent=index / total)
                status = "Cancelled" if self.eagle_task.get("cancelled") else "Done"
                self._eagle_set_task(running=False, current="", status=status, percent=1 if status == "Done" else self.eagle_task.get("percent", 0), paused=False)
            except Exception as exc:
                self._eagle_task_error(exc)
                self._eagle_set_task(running=False, current="", status="Error", paused=False)
            finally:
                if previous_headless is None:
                    os.environ.pop("BILI_WEB_HEADLESS", None)
                else:
                    os.environ["BILI_WEB_HEADLESS"] = previous_headless

        threading.Thread(target=_task, daemon=True).start()
        return {"started": True, "total": len(records)}

    def open_eagle_batch_processor(self):
        script = os.path.join(EAGLE_DIR, "eagle_batch_processor.py")
        if not os.path.exists(script):
            raise RuntimeError("Eagle batch processor not found")
        subprocess.Popen([sys.executable, script], cwd=EAGLE_DIR)
        return {"ok": True}

    def start_download(self, payload):
        if self.worker and self.download.get("running"):
            raise RuntimeError("下载任务正在运行")
        bvids = set(payload.get("bvids") or [])
        save_dir = payload.get("saveDir") or self.settings.get("downloadDir") or ""
        if not bvids:
            raise RuntimeError("请先选择视频")
        if not save_dir or not os.path.isdir(save_dir):
            raise RuntimeError("请选择有效保存目录")
        if save_dir != self.settings.get("downloadDir"):
            self.set_app_settings({"downloadDir": save_dir})
        all_items = self.fav_videos + self.manual_videos + self.creator_videos
        items = []
        seen = set()
        for item in all_items:
            if item["bvid"] in bvids and item["bvid"] not in seen:
                items.append(item)
                seen.add(item["bvid"])
        if not items:
            raise RuntimeError("没有找到可下载项目")
        quality = payload.get("quality") or "1080"
        audio_only = bool(payload.get("audioOnly"))
        dl_all = bool(payload.get("allParts"))
        try:
            speed = int(payload.get("speed") or 0)
        except Exception:
            speed = 0
        if not self.env["ffmpeg"] and not audio_only and quality in ["4K", "2K", "1080", "720"]:
            raise RuntimeError("缺少 FFmpeg，无法合并高清视频")

        def progress(percent, text, is_switch, current_idx=0, total_cnt=1):
            with self.lock:
                if percent == -1:
                    self.download.update({"running": False, "total": 1, "file": 1, "title": "任务完成", "status": "Ready"})
                    self.mgr.save_data()
                    return
                if is_switch:
                    self.download["total"] = max(0, min(1, percent))
                    self.download["title"] = f"Total: {min(current_idx + 1, total_cnt)}/{total_cnt} | {text}"
                else:
                    self.download["file"] = max(0, min(1, percent))
                    self.download["status"] = text

        def history_cb(bvid, item=None, file_path=""):
            self.record_download(bvid, item, file_path)

        def fail_cb(item):
            self.log(f"失败：{item['title']}")

        def log_proxy(message):
            self.log(message)

        with self.lock:
            self.download.update({"running": True, "total": 0, "file": 0, "title": "准备下载", "status": "Ready"})
        self.worker = DownloadWorker(items, save_dir, speed, quality, progress, history_cb, fail_cb, self.mgr.session, self.mgr.get_netscape_cookie_path, log_proxy, audio_only, dl_all)
        threading.Thread(target=self.worker.run, daemon=True).start()
        return {"started": True}

    def pause_download(self):
        if self.worker:
            self.worker.is_paused = not self.worker.is_paused
            return {"paused": self.worker.is_paused}
        return {"paused": False}

    def cancel_download(self):
        if self.worker:
            self.worker.is_cancelled = True
        with self.lock:
            self.download["status"] = "正在取消..."
        return {"ok": True}


APP = WebBiliApp()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type, cache=False):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if not cache:
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_image_proxy(self, url):
        url = APP.normalize_url(unquote(url))
        if not (url.startswith("https://i") or "hdslb.com" in url or "bili" in url):
            raise RuntimeError("不允许代理该图片地址")
        headers = {
            "User-Agent": APP.mgr.session.headers.get("User-Agent", "Mozilla/5.0"),
            "Referer": "https://www.bilibili.com/",
        }
        resp = requests.get(url, headers=headers, timeout=12)
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type") or "image/jpeg"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(resp.content)))
        self.end_headers()
        self.wfile.write(resp.content)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/":
                return self.send_file(os.path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8")
            if path == "/styles.css":
                return self.send_file(os.path.join(WEB_DIR, "styles.css"), "text/css; charset=utf-8")
            if path == "/app.js":
                return self.send_file(os.path.join(WEB_DIR, "app.js"), "application/javascript; charset=utf-8")
            if path == "/api/state":
                return self.send_json(APP.public_state())
            if path == "/api/app-info":
                return self.send_json({"name": "BiliDownloader Studio", "version": APP_VERSION, "flavor": APP_FLAVOR})
            if path == "/api/image":
                url = parse_qs(parsed.query).get("url", [""])[0]
                return self.send_image_proxy(url)
            if path == "/api/login/poll":
                key = parse_qs(parsed.query).get("key", [""])[0]
                return self.send_json(APP.qr_login_poll(key))
            self.send_error(404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            payload = self.read_json()
            if path == "/api/login/qr":
                return self.send_json(APP.qr_login_generate())
            if path == "/api/logout":
                APP.logout()
                return self.send_json({"ok": True})
            if path == "/api/folders":
                return self.send_json(APP.fetch_fav_folders())
            if path == "/api/import/fav":
                return self.send_json(APP.import_external_fav(payload.get("value", "")))
            if path == "/api/sync":
                return self.send_json(APP.sync_fav(str(payload.get("fid", ""))))
            if path == "/api/creator/search":
                return self.send_json(APP.search_creator_accounts(payload.get("query", "")))
            if path == "/api/creator/sync":
                return self.send_json(APP.sync_creator_videos(payload))
            if path == "/api/tags/cloud":
                return self.send_json(APP.start_tag_cloud(payload))
            if path == "/api/tags/cancel":
                return self.send_json(APP.cancel_tag_cloud())
            if path == "/api/import/season":
                return self.send_json(APP.import_collection(payload.get("value", "")))
            if path == "/api/manual/extract":
                return self.send_json(APP.extract_video(payload.get("value", "")))
            if path == "/api/mark":
                return self.send_json(APP.mark_items(payload.get("bvids", []), bool(payload.get("done"))))
            if path == "/api/delete":
                return self.send_json(APP.delete_items(payload.get("bvids", [])))
            if path == "/api/choose-file":
                return self.send_json(APP.choose_file())
            if path == "/api/choose-dir":
                return self.send_json(APP.choose_dir())
            if path == "/api/history/import":
                return self.send_json(APP.import_history(payload.get("path", "")))
            if path == "/api/history/export":
                return self.send_json(APP.export_history(payload.get("path", "")))
            if path == "/api/history/open-location":
                return self.send_json(APP.open_history_location())
            if path == "/api/settings":
                return self.send_json(APP.set_app_settings(payload))
            if path == "/api/diagnostics":
                return self.send_json(APP.run_diagnostics())
            if path == "/api/reset":
                if APP_FLAVOR != "test":
                    return self.send_json({"error": "恢复初始状态只在测试版开放"}, 403)
                return self.send_json(APP.reset_to_fresh_install())
            if path == "/api/eagle/config":
                return self.send_json(APP.set_eagle_config(payload))
            if path == "/api/eagle/folders":
                return self.send_json(APP.get_eagle_folders(payload))
            if path == "/api/eagle/index/refresh":
                return self.send_json(APP.refresh_eagle_index(payload))
            if path == "/api/eagle/import":
                return self.send_json(APP.start_eagle_import(payload))
            if path == "/api/eagle/folder-thumbnails":
                return self.send_json(APP.start_eagle_folder_thumbnails(payload))
            if path == "/api/eagle/pause":
                return self.send_json(APP.pause_eagle_task(payload))
            if path == "/api/eagle/cancel":
                return self.send_json(APP.cancel_eagle_task())
            if path == "/api/eagle/batch/open":
                return self.send_json(APP.open_eagle_batch_processor())
            if path == "/api/download/start":
                return self.send_json(APP.start_download(payload))
            if path == "/api/download/pause":
                return self.send_json(APP.pause_download())
            if path == "/api/download/cancel":
                return self.send_json(APP.cancel_download())
            self.send_error(404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 400)


def main():
    host = "127.0.0.1"
    port = None
    for candidate in range(8765, 8796):
        url = f"http://{host}:{candidate}"
        try:
            resp = requests.get(f"{url}/api/app-info", timeout=0.6)
            if resp.ok and resp.headers.get("Content-Type", "").startswith("application/json"):
                data = resp.json()
                if data.get("version") == APP_VERSION:
                    webbrowser.open(url)
                    return
        except Exception:
            pass
        try:
            resp = requests.get(f"{url}/api/state", timeout=0.6)
            if resp.ok and resp.headers.get("Content-Type", "").startswith("application/json"):
                print(f"Found a different BiliDownloader service at {url}; starting this build on another port.")
                continue
        except Exception:
            pass
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, candidate))
                port = candidate
                break
            except OSError:
                continue
    if port is None:
        raise RuntimeError("No available local port found from 8765 to 8795")
    server = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}"
    print(f"BiliDownloader Web UI: {url}")
    webbrowser.open(url)
    server.serve_forever()


if __name__ == "__main__":
    main()
