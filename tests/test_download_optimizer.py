import unittest
from unittest.mock import patch

from utils import BiliResolver
from worker import DownloadWorker


class DownloadOptimizerTests(unittest.TestCase):
    def test_regular_cdn_is_preferred_over_mcdn(self):
        stream = {
            "baseUrl": "https://example.mcdn.bilivideo.cn/video.m4s",
            "backupUrl": [
                "https://upos-sz-mirrorcos.bilivideo.com/video.m4s",
                "https://example.mcdn.bilivideo.cn/video.m4s",
            ],
        }

        urls = BiliResolver.stream_urls(stream)

        self.assertEqual(urls[0], "https://upos-sz-mirrorcos.bilivideo.com/video.m4s")
        self.assertEqual(len(urls), 2)

    def test_base_url_order_is_kept_for_regular_cdns(self):
        stream = {
            "base_url": "https://upos-a.bilivideo.com/video.m4s",
            "backup_url": ["https://upos-b.bilivideo.com/video.m4s"],
        }

        self.assertEqual(
            BiliResolver.stream_urls(stream),
            [
                "https://upos-a.bilivideo.com/video.m4s",
                "https://upos-b.bilivideo.com/video.m4s",
            ],
        )

    def test_parallel_streams_share_eight_connection_budget(self):
        args = DownloadWorker._aria2_args(4)

        self.assertEqual(args[args.index("-x") + 1], "4")
        self.assertEqual(args[args.index("-s") + 1], "4")
        self.assertIn("--continue=true", args)

    def test_connection_budget_is_capped(self):
        args = DownloadWorker._aria2_args(32)

        self.assertEqual(args[args.index("-x") + 1], "8")
        self.assertEqual(args[args.index("-s") + 1], "8")

    def test_high_quality_selectors_use_real_target_heights(self):
        self.assertIn("height=1440", DownloadWorker._format_selector("2K"))
        self.assertIn("height<=1440", DownloadWorker._format_selector("2K"))
        self.assertIn("height=2160", DownloadWorker._format_selector("4K"))
        self.assertIn("height<=2160", DownloadWorker._format_selector("4K"))

    def test_direct_download_uses_backup_cdn_after_failure(self):
        calls = []

        class FakeYDL:
            def __init__(self, _opts):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def download(self, urls):
                calls.extend(urls)
                if "primary" in urls[0]:
                    raise RuntimeError("primary CDN unavailable")

        download_worker = DownloadWorker.__new__(DownloadWorker)
        download_worker.has_aria2 = False
        download_worker.is_cancelled = False
        download_worker.log_cb = lambda _message: None

        with patch("worker.yt_dlp.YoutubeDL", FakeYDL):
            download_worker._download_direct_stream(
                ["https://primary.example/video", "https://backup.example/video"],
                "output.mp4",
                {},
                4,
            )

        self.assertEqual(
            calls,
            ["https://primary.example/video", "https://backup.example/video"],
        )

    def test_direct_download_falls_back_when_aria2_fails(self):
        transports = []

        class FakeYDL:
            def __init__(self, opts):
                self.opts = opts

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def download(self, _urls):
                external = bool(self.opts.get("external_downloader"))
                transports.append("aria2" if external else "native")
                if external:
                    raise RuntimeError("aria2 unavailable")

        download_worker = DownloadWorker.__new__(DownloadWorker)
        download_worker.has_aria2 = True
        download_worker.is_cancelled = False
        download_worker.log_cb = lambda _message: None

        with patch("worker.yt_dlp.YoutubeDL", FakeYDL):
            download_worker._download_direct_stream(
                ["https://cdn.example/video"],
                "output.mp4",
                {"external_downloader": "aria2c"},
                4,
            )

        self.assertEqual(transports, ["aria2", "native"])


if __name__ == "__main__":
    unittest.main()
