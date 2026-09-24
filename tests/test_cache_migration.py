import tempfile
import threading
import unittest
from pathlib import Path

from web_app import (
    WebBiliApp,
    cache_path_stats,
    collect_cache_files,
    files_have_same_content,
    validate_cache_migration_paths,
)


class CacheMigrationTests(unittest.TestCase):
    def test_rejects_nested_and_non_empty_destinations(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "source"
            source.mkdir()
            with self.assertRaises(RuntimeError):
                validate_cache_migration_paths(source, source / "nested")

            destination = base / "destination"
            destination.mkdir()
            (destination / "existing.txt").write_text("occupied", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                validate_cache_migration_paths(source, destination)

    def test_stats_and_content_verification(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            (base / "one.bin").write_bytes(b"1234")
            (base / "nested").mkdir()
            (base / "nested" / "two.bin").write_bytes(b"56789")
            stats = cache_path_stats(base)
            self.assertEqual(stats["files"], 2)
            self.assertEqual(stats["bytes"], 9)
            self.assertTrue(files_have_same_content(base / "one.bin", base / "one.bin"))

    def test_worker_switches_path_and_keeps_backup_by_default(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "source"
            destination = base / "destination"
            source.mkdir()
            (source / "cache.json").write_text('{"ok": true}', encoding="utf-8")
            app = self._fake_app(source)

            app._cache_migration_worker(
                "eagle",
                source,
                destination,
                collect_cache_files(source),
                False,
            )

            self.assertEqual(Path(app.settings["eagleExportDir"]), destination)
            self.assertTrue((destination / "cache.json").is_file())
            self.assertTrue((source / "cache.json").is_file())
            self.assertEqual(app.cache_migration["progress"], 1)
            self.assertFalse(app.cache_migration["running"])

    def test_worker_removes_only_verified_old_files(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "source"
            destination = base / "destination"
            source.mkdir()
            (source / "cache.bin").write_bytes(b"verified-cache")
            app = self._fake_app(source)

            app._cache_migration_worker(
                "eagle",
                source,
                destination,
                collect_cache_files(source),
                True,
            )

            self.assertTrue((destination / "cache.bin").is_file())
            self.assertFalse(source.exists())
            self.assertFalse(app.cache_migration["error"])

    def test_worker_restores_old_setting_when_switch_fails(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "source"
            destination = base / "destination"
            source.mkdir()
            (source / "cache.bin").write_bytes(b"keep-the-source")
            app = self._fake_app(source)
            original = app.settings["eagleExportDir"]
            writes = {"count": 0}

            def fail_first_write(*args, **kwargs):
                writes["count"] += 1
                if writes["count"] == 1:
                    raise OSError("simulated settings failure")

            app.save_json_file = fail_first_write
            app._cache_migration_worker(
                "eagle",
                source,
                destination,
                collect_cache_files(source),
                False,
            )

            self.assertEqual(app.settings["eagleExportDir"], original)
            self.assertTrue((source / "cache.bin").is_file())
            self.assertFalse(app.cache_migration["running"])
            self.assertIn("失败", app.cache_migration["status"])

    def test_cleanup_can_preserve_bootstrap_pointer(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            bootstrap = source / "app_settings.json"
            cache = source / "cache.bin"
            bootstrap.write_text('{"dataDir": "migrated"}', encoding="utf-8")
            cache.write_bytes(b"old-cache")
            files = collect_cache_files(source)
            cleanup_files = [item for item in files if item[1].as_posix() != "app_settings.json"]

            WebBiliApp._remove_migrated_cache_files(source, cleanup_files)

            self.assertTrue(bootstrap.is_file())
            self.assertFalse(cache.exists())

    @staticmethod
    def _fake_app(source):
        app = WebBiliApp.__new__(WebBiliApp)
        app.lock = threading.RLock()
        app.settings = {"dataDir": str(source.parent / "data"), "eagleExportDir": str(source)}
        app.cache_migration = {
            "running": True,
            "progress": 0,
            "status": "testing",
            "error": "",
        }
        app.save_json_file = lambda *args, **kwargs: None
        app.apply_runtime_paths = lambda: None
        app.log = lambda message: None
        return app


if __name__ == "__main__":
    unittest.main()
