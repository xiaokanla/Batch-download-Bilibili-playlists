from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class SQLiteStore:
    """Small SQLite storage layer with legacy JSON import and JSON mirrors."""

    SCHEMA_VERSION = 1

    def __init__(self, data_dir: str | os.PathLike[str]):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "bili_downloader.db"
        self.lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.lock, self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS download_records (
                    bvid TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history (
                    user_uid TEXT NOT NULL,
                    bvid TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (user_uid, bvid)
                );
                CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_uid);
                CREATE TABLE IF NOT EXISTS fav_cache (
                    fid TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tag_cache (
                    bvid TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS json_cache (
                    cache_type TEXT NOT NULL,
                    cache_key TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (cache_type, cache_key)
                );
                CREATE INDEX IF NOT EXISTS idx_json_cache_type ON json_cache(cache_type);
                """
            )
            connection.execute(
                """
                INSERT INTO meta(key, value, updated_at)
                VALUES('schema_version', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (str(self.SCHEMA_VERSION), time.time()),
            )

    @staticmethod
    def _read_json(path: str | os.PathLike[str], default: Any) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as stream:
                return json.load(stream)
        except (OSError, ValueError, TypeError):
            return default

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def _load_map(self, table: str, key_name: str) -> dict[str, Any]:
        with self.lock, self._connection() as connection:
            rows = connection.execute(
                f"SELECT {key_name}, payload FROM {table}"
            ).fetchall()
        result = {}
        for row in rows:
            try:
                result[str(row[key_name])] = json.loads(row["payload"])
            except (ValueError, TypeError):
                continue
        return result

    def _save_map(self, table: str, key_name: str, values: dict[str, Any]) -> None:
        now = time.time()
        rows = [
            (str(key), self._json(value), now)
            for key, value in values.items()
            if str(key).strip()
        ]
        with self.lock, self._connection() as connection:
            connection.execute(f"DELETE FROM {table}")
            if rows:
                connection.executemany(
                    f"""
                    INSERT INTO {table}({key_name}, payload, updated_at)
                    VALUES(?, ?, ?)
                    """,
                    rows,
                )

    def load_download_records(self, legacy_path: str | os.PathLike[str] | None = None) -> dict:
        records = self._load_map("download_records", "bvid")
        if records or not legacy_path or not os.path.exists(legacy_path):
            return records
        legacy = self._read_json(legacy_path, {})
        if not isinstance(legacy, dict):
            return {}
        normalized = {}
        for key, value in legacy.items():
            if isinstance(value, dict):
                bvid = str(value.get("bvid") or key).strip()
                if bvid:
                    normalized[bvid] = {**value, "bvid": bvid}
        if normalized:
            self.save_download_records(normalized)
        return normalized

    def save_download_records(self, records: dict) -> None:
        self._save_map("download_records", "bvid", records if isinstance(records, dict) else {})

    def save_download_record(self, bvid: str, record: dict) -> None:
        key = str(bvid or "").strip()
        if not key:
            return
        now = time.time()
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO download_records(bvid, payload, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(bvid) DO UPDATE SET
                    payload=excluded.payload,
                    updated_at=excluded.updated_at
                """,
                (key, self._json(record), now),
            )

    def load_history(self, user_uid: str, legacy_path: str | os.PathLike[str] | None = None) -> set[str]:
        uid = str(user_uid or "guest")
        with self.lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT bvid FROM history WHERE user_uid = ?",
                (uid,),
            ).fetchall()
        history = {str(row["bvid"]) for row in rows}
        if history or not legacy_path or not os.path.exists(legacy_path):
            return history
        legacy = self._read_json(legacy_path, [])
        if not isinstance(legacy, list):
            return set()
        history = {str(value).strip() for value in legacy if str(value).strip()}
        if history:
            self.save_history(uid, history)
        return history

    def save_history(self, user_uid: str, history: set[str] | list[str]) -> None:
        uid = str(user_uid or "guest")
        values = sorted({str(value).strip() for value in history if str(value).strip()})
        now = time.time()
        with self.lock, self._connection() as connection:
            connection.execute("DELETE FROM history WHERE user_uid = ?", (uid,))
            connection.executemany(
                """
                INSERT INTO history(user_uid, bvid, updated_at)
                VALUES(?, ?, ?)
                """,
                [(uid, value, now) for value in values],
            )

    def load_fav_cache(self, fid: str, legacy_path: str | os.PathLike[str] | None = None) -> list:
        key = str(fid or "").strip()
        with self.lock, self._connection() as connection:
            row = connection.execute(
                "SELECT payload FROM fav_cache WHERE fid = ?",
                (key,),
            ).fetchone()
        if row:
            value = self._read_json_value(row["payload"], [])
            return value if isinstance(value, list) else []
        if not legacy_path or not os.path.exists(legacy_path):
            return []
        legacy = self._read_json(legacy_path, [])
        if isinstance(legacy, list):
            self.save_fav_cache(key, legacy)
            return legacy
        return []

    def save_fav_cache(self, fid: str, videos: list) -> None:
        key = str(fid or "").strip()
        if not key:
            return
        now = time.time()
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO fav_cache(fid, payload, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(fid) DO UPDATE SET
                    payload=excluded.payload,
                    updated_at=excluded.updated_at
                """,
                (key, self._json(videos if isinstance(videos, list) else []), now),
            )

    def load_tag_cache(self, legacy_path: str | os.PathLike[str] | None = None) -> dict:
        cache = self._load_map("tag_cache", "bvid")
        if cache or not legacy_path or not os.path.exists(legacy_path):
            return cache
        legacy = self._read_json(legacy_path, {})
        if isinstance(legacy, dict):
            self.save_tag_cache(legacy)
            return legacy
        return {}

    def save_tag_cache(self, cache: dict) -> None:
        self._save_map("tag_cache", "bvid", cache if isinstance(cache, dict) else {})

    def save_tag(self, bvid: str, value: Any) -> None:
        key = str(bvid or "").strip()
        if not key:
            return
        now = time.time()
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO tag_cache(bvid, payload, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(bvid) DO UPDATE SET
                    payload=excluded.payload,
                    updated_at=excluded.updated_at
                """,
                (key, self._json(value), now),
            )

    def load_json_cache(
        self,
        cache_type: str,
        legacy_path: str | os.PathLike[str] | None = None,
    ) -> dict:
        kind = str(cache_type)
        with self.lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT cache_key, payload FROM json_cache WHERE cache_type = ?",
                (kind,),
            ).fetchall()
        cache = {}
        for row in rows:
            try:
                cache[str(row["cache_key"])] = json.loads(row["payload"])
            except (ValueError, TypeError):
                continue
        if cache or not legacy_path or not os.path.exists(legacy_path):
            return cache
        legacy = self._read_json(legacy_path, {})
        if isinstance(legacy, dict):
            self.save_json_cache(kind, legacy)
            return legacy
        return {}

    def save_json_cache(self, cache_type: str, values: dict) -> None:
        kind = str(cache_type)
        rows = [
            (kind, str(key), self._json(value), time.time())
            for key, value in (values.items() if isinstance(values, dict) else [])
            if str(key).strip()
        ]
        with self.lock, self._connection() as connection:
            connection.execute("DELETE FROM json_cache WHERE cache_type = ?", (kind,))
            if rows:
                connection.executemany(
                    """
                    INSERT INTO json_cache(cache_type, cache_key, payload, updated_at)
                    VALUES(?, ?, ?, ?)
                    """,
                    rows,
                )

    @staticmethod
    def _read_json_value(value: str, default: Any) -> Any:
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return default

    def load_single(
        self,
        key: str,
        legacy_path: str | os.PathLike[str] | None = None,
        default: Any = None,
    ) -> Any:
        with self.lock, self._connection() as connection:
            row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if row:
            return self._read_json_value(row["value"], default)
        if not legacy_path or not os.path.exists(legacy_path):
            return default
        value = self._read_json(legacy_path, default)
        if value is not None:
            self.save_single(key, value)
        return value

    def save_single(self, key: str, value: Any) -> None:
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO meta(key, value, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value=excluded.value,
                    updated_at=excluded.updated_at
                """,
                (str(key), self._json(value), time.time()),
            )
