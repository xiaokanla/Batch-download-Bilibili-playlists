import threading
import time
import shutil
import os
import random
import re
import subprocess
import traceback  # 用于捕获详细错误
import yt_dlp
from yt_dlp.utils import DownloadError
from config import ERROR_LOG
from utils import BiliResolver


def subprocess_no_window_kwargs():
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": startupinfo,
    }


class DownloadWorker:
    def __init__(self, items, save_dir, speed_limit, quality, progress_cb, history_cb, fail_cb, session, cookie_gen, log_cb, is_audio_only, dl_all_parts=False):
        self.items = items
        self.save_dir = save_dir
        self.speed_limit = speed_limit
        self.quality = quality
        self.progress_cb = progress_cb
        self.history_cb = history_cb
        self.fail_cb = fail_cb
        self.session = session
        self.cookie_gen = cookie_gen
        self.log_cb = log_cb
        self.is_audio_only = is_audio_only
        self.dl_all_parts = dl_all_parts

        self.is_paused = False
        self.is_cancelled = False
        self._yt_dlp_blocked_until = 0
        self._yt_dlp_412_count = 0

        # 进度更新节流
        self._last_progress_time = 0
        self._progress_interval = 0.05  # 最少间隔 50ms，进度条更顺滑

        # 环境检测
        self.aria2_path = None
        self.check_environment()

    def check_environment(self):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        configured_ffmpeg = os.environ.get("BILI_FFMPEG_PATH", "")
        configured_aria2 = os.environ.get("BILI_ARIA2_PATH", "")
        local_ffmpeg = configured_ffmpeg if configured_ffmpeg and os.path.exists(configured_ffmpeg) else os.path.join(base_dir, 'ffmpeg.exe')
        local_aria2 = configured_aria2 if configured_aria2 and os.path.exists(configured_aria2) else os.path.join(base_dir, 'aria2c.exe')

        if os.path.exists(local_ffmpeg):
            if base_dir not in os.environ["PATH"]:
                os.environ["PATH"] += os.pathsep + base_dir
            self.has_ffmpeg = True
        else:
            self.has_ffmpeg = shutil.which('ffmpeg') is not None

        if os.path.exists(local_aria2):
            if base_dir not in os.environ["PATH"]:
                os.environ["PATH"] += os.pathsep + base_dir
            self.aria2_path = local_aria2 if configured_aria2 else 'aria2c'
            self.has_aria2 = True
        else:
            self.aria2_path = shutil.which('aria2c')
            self.has_aria2 = self.aria2_path is not None

    def clean_filename(self, name, limit=80):
        name = re.sub(r'[\\/*?:"<>|]', "", name)
        name = "".join(x for x in name if x.isprintable())
        if len(name) > limit:
            name = name[:limit]
        return name.strip()

    def log_error(self, title, error_obj, context=""):
        """记录详细错误日志到本地文件"""
        tb_str = traceback.format_exc()
        err_msg = (
            f"\n{'='*30}\n"
            f"[时间]: {time.ctime()}\n"
            f"[任务]: {title}\n"
            f"[阶段]: {context}\n"
            f"[错误类型]: {type(error_obj).__name__}\n"
            f"[错误信息]: {str(error_obj)}\n"
            f"[堆栈追踪]:\n{tb_str}\n"
            f"{'='*30}\n"
        )

        # 1. 界面简略提示
        self.log_cb(f"❌ {context} 错误: {str(error_obj)}")
        self.log_cb(f"👉 详情已写入 error_log.txt")

        # 2. 写入文件
        try:
            with open(os.environ.get("BILI_ERROR_LOG") or ERROR_LOG, "a", encoding="utf-8") as f:
                f.write(err_msg)
        except Exception as e:
            print(f"写入日志失败: {e}")

    def _is_yt_dlp_412(self, error_obj):
        text = str(error_obj).lower()
        return "http error 412" in text or "precondition failed" in text

    def _cooldown_yt_dlp(self):
        self._yt_dlp_412_count += 1
        cooldown = min(600, 90 * self._yt_dlp_412_count)
        self._yt_dlp_blocked_until = time.time() + cooldown
        self.log_cb(f"⚠️ yt-dlp metadata 被 B站返回 412，冷却 {cooldown} 秒；后续优先使用 API 直链模式")

    def progress_hook(self, d):
        while self.is_paused and not self.is_cancelled:
            time.sleep(0.5)

        if self.is_cancelled:
            raise Exception("USER_CANCEL")

        if d['status'] == 'downloading':
            # 节流：限制更新频率
            current_time = time.time()
            if current_time - self._last_progress_time < self._progress_interval:
                return
            self._last_progress_time = current_time

            try:
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
                p = d.get('downloaded_bytes', 0) / total
                msg = f"🚀 下载中" if self.has_aria2 else f"📥 {int(p*100)}%"
                self.progress_cb(p, msg, False)
            except:
                pass
        elif d['status'] == 'finished':
            self.progress_cb(1.0, "⚙️ 正在处理...", False)

    class MyLogger:
        def __init__(self, log_callback):
            self.log_cb = log_callback

        def debug(self, msg):
            pass

        def warning(self, msg):
            self.log_cb(f"⚠️ [内核警告]: {msg}")

        def error(self, msg):
            self.log_cb(f"❌ [内核错误]: {msg}")

    def _verify_audio_stream(self, file_path):
        """验证文件是否包含音频流"""
        try:
            result = subprocess.run(
                [self._find_local_ffprobe(), '-v', 'quiet', '-select_streams', 'a',
                 '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file_path],
                capture_output=True,
                text=True,
                timeout=30,
                **subprocess_no_window_kwargs(),
            )
            return 'audio' in result.stdout.lower()
        except:
            # 如果 ffprobe 失败，假设文件有效
            return True

    def _find_local_ffmpeg(self):
        """优先使用项目内 ffmpeg，其次使用系统 ffmpeg"""
        base_dir = os.path.dirname(os.path.abspath(__file__))
        configured = os.environ.get("BILI_FFMPEG_PATH", "")
        if configured and os.path.exists(configured):
            return configured
        local_ffmpeg = os.path.join(base_dir, 'ffmpeg.exe')
        if os.path.exists(local_ffmpeg):
            return local_ffmpeg
        ffmpeg_cmd = shutil.which('ffmpeg')
        return ffmpeg_cmd if ffmpeg_cmd else 'ffmpeg'

    def _find_local_ffprobe(self):
        """优先使用项目内 ffprobe，其次使用系统 ffprobe"""
        base_dir = os.path.dirname(os.path.abspath(__file__))
        configured = os.environ.get("BILI_FFPROBE_PATH", "")
        if configured and os.path.exists(configured):
            return configured
        local_ffprobe = os.path.join(base_dir, 'ffprobe.exe')
        if os.path.exists(local_ffprobe):
            return local_ffprobe
        ffprobe_cmd = shutil.which('ffprobe')
        return ffprobe_cmd if ffprobe_cmd else 'ffprobe'

    def _find_recent_media_file(self, since_ts, exts=('.mp4', '.mkv', '.webm', '.flv', '.m4a', '.mp3')):
        try:
            candidates = []
            for name in os.listdir(self.save_dir):
                path = os.path.join(self.save_dir, name)
                if not os.path.isfile(path):
                    continue
                if not name.lower().endswith(exts):
                    continue
                if os.path.getmtime(path) >= since_ts - 2:
                    candidates.append(path)
            return max(candidates, key=os.path.getmtime) if candidates else None
        except Exception:
            return None

    def _find_output_for_item(self, item, since_ts):
        latest = self._find_recent_media_file(since_ts)
        try:
            title = self.clean_filename(str(item.get('title') or ''), 80).lower()
            bvid = str(item.get('bvid') or '').lower()
            candidates = []
            for name in os.listdir(self.save_dir):
                path = os.path.join(self.save_dir, name)
                if not os.path.isfile(path):
                    continue
                lower = name.lower()
                if not lower.endswith(('.mp4', '.mkv', '.webm', '.flv', '.m4a', '.mp3')):
                    continue
                if os.path.getmtime(path) < since_ts - 10:
                    continue
                score = 0
                if bvid and bvid in lower:
                    score += 3
                if title and (title[:24] in lower or lower.startswith(title[:24])):
                    score += 2
                if score:
                    candidates.append((score, os.path.getmtime(path), path))
            if candidates:
                return max(candidates)[2]
        except Exception:
            pass
        return latest

    def _verify_recent_video_output(self, item, since_ts):
        if self.is_audio_only:
            return True
        latest_file = self._find_recent_media_file(since_ts, exts=('.mp4', '.mkv', '.webm', '.flv'))
        if not latest_file:
            self.log_cb("⚠️ 未定位到最新输出文件，跳过音频验证")
            return True
        if self._verify_audio_stream(latest_file):
            return True
        self.log_cb("⚠️ 输出文件缺少音频，删除后切换 API 直链重试")
        try:
            os.remove(latest_file)
        except Exception:
            pass
        return False

    def _notify_history(self, item, file_path=None):
        bvid = item.get('bvid') if isinstance(item, dict) else item
        try:
            self.history_cb(bvid, item, file_path or "")
        except TypeError:
            self.history_cb(bvid)
        except Exception as exc:
            self.log_error(str(item.get('title') if isinstance(item, dict) else bvid), exc, context="history_cb")

    def run(self):
        total_videos = len(self.items)
        cookie_file = self.cookie_gen()
        current_ua = self.session.headers.get('User-Agent', 'Mozilla/5.0')

        # 策略判断：4K/2K 默认走 API；普通清晰度只在单个视频失败时 fallback。
        prefer_api_mode = (self.quality in ["4K", "2K"])

        # 画质参数 - 改进格式选择器，确保包含音频
        if self.quality == "4K":
            format_str = "bestvideo[height=2160]+bestaudio/bestvideo[height<=2160]+bestaudio"
        elif self.quality == "2K":
            format_str = "bestvideo[height=1440]+bestaudio/bestvideo[height<=1440]+bestaudio"
        elif self.quality == "1080":
            format_str = "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio"
        elif self.quality == "720":
            format_str = "bestvideo[height=720]+bestaudio/bestvideo[height<=720]+bestaudio"
        elif self.quality == "480":
            format_str = "bestvideo[height=480]+bestaudio/bestvideo[height<=480]+bestaudio"
        else:
            format_str = "bestvideo+bestaudio/best"

        try:
            for i, item in enumerate(self.items):
                if self.is_cancelled:
                    break

                safe_title = self.clean_filename(item['title'], 20)
                self.progress_cb(i / total_videos, safe_title, True, i, total_videos)
                self.log_cb(f"[{i+1}/{total_videos}] 处理: {safe_title}")

                if i > 0:
                    time.sleep(0.5)

                item_started_at = time.time()
                output_file = None
                rate = self.speed_limit * 1024 if self.speed_limit > 0 else None
                success = False
                force_api_mode = prefer_api_mode or (time.time() < self._yt_dlp_blocked_until)
                if force_api_mode and not prefer_api_mode:
                    self.log_cb("🧊 yt-dlp 冷却中，跳过常规模式")

                base_opts = {
                    'ratelimit': rate,
                    'progress_hooks': [self.progress_hook],
                    'logger': self.MyLogger(self.log_cb),
                    'cookiefile': cookie_file,
                    'http_headers': {
                        'Referer': 'https://www.bilibili.com/',
                        'User-Agent': current_ua
                    },
                    'retries': 3,
                    'socket_timeout': 15,
                    'quiet': True,
                    'no_warnings': False,
                    'verbose': False,  # 减少输出噪音
                }

                if not self.dl_all_parts:
                    base_opts['playlist_items'] = '1'

                if self.has_aria2:
                    base_opts.update({
                        'external_downloader': self.aria2_path or 'aria2c',
                        # 保守提速：并发适中，避免触发站点风控
                        'external_downloader_args': {'aria2c': ['-x','8','-s','8','-k','1M','--min-split-size=1M','--max-tries=5','--retry-wait=2','--file-allocation=none']}
                    })

                # === 模式1: 常规 yt-dlp ===
                if not force_api_mode:
                    try:
                        if self.is_audio_only:
                            spec = "bestaudio/best"
                        else:
                            # 添加更多备选方案，确保能获取到音频
                            spec = f"{format_str}/bestvideo+bestaudio/best"

                        opts = base_opts.copy()
                        opts.update({
                            'outtmpl': f'{self.save_dir}/%(title)s.%(ext)s',
                            'format': spec,
                            'trim_file_name': 80,
                            'extractor_args': {'bilibili': {'player_client': ['android', 'web']}},
                            # 温和并发：降低限速/风控概率
                            'concurrent_fragment_downloads': 4,
                            # 关键：尽量要求音视频分离并强制合并，避免单独视频流落盘
                            'final_ext': 'mp4',
                            # 关键：强制指定合并输出格式为 MP4
                            'merge_output_format': 'mp4',
                            'prefer_ffmpeg': True,
                            'keepvideo': False,
                            'postprocessor_args': ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
                            # 确保合并时音频编码为 AAC（兼容性更好）
                            'postprocessors': [
                                {'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'}
                            ],
                        })

                        if self.has_ffmpeg:
                            opts['ffmpeg_location'] = os.path.dirname(self._find_local_ffmpeg())

                        self.log_cb("⏳ 尝试常规下载模式...")
                        download_started_at = time.time()
                        with yt_dlp.YoutubeDL(opts) as ydl:
                            ydl.download([f"https://www.bilibili.com/video/{item['bvid']}"])
                        success = True
                        output_file = self._find_output_for_item(item, download_started_at)
                        self.log_cb("✅ 下载完成")

                        # 如果结果文件无音频，交给 API 模式重试
                        if (not self.is_audio_only) and (not force_api_mode) and not self._verify_recent_video_output(item, download_started_at):
                            success = False
                            force_api_mode = True

                    except DownloadError as e:
                        if self._is_yt_dlp_412(e):
                            self._cooldown_yt_dlp()
                            force_api_mode = True
                            success = False
                            if self.has_aria2:
                                self.has_aria2 = False
                                base_opts.pop('external_downloader', None)
                                base_opts.pop('external_downloader_args', None)
                            self.log_cb("⚠️ 跳过 yt-dlp 重试，直接切换 API 直链模式...")
                            time.sleep(random.uniform(1.2, 2.4))
                        # 外部下载器在不同机器上兼容性不稳定；只要本轮用了 aria2，失败后先自动禁用 aria2 重试。
                        elif self.has_aria2:
                            self.log_cb("⚠️ 常规下载失败，自动禁用 aria2 并切换内置下载器重试...")
                            self.has_aria2 = False
                            base_opts.pop('external_downloader', None)
                            base_opts.pop('external_downloader_args', None)
                            retry_opts = base_opts.copy()
                            retry_opts.pop('external_downloader', None)
                            retry_opts.pop('external_downloader_args', None)
                            retry_opts.update({
                                'outtmpl': f'{self.save_dir}/%(title)s.%(ext)s',
                                'format': spec,
                                'trim_file_name': 80,
                                'extractor_args': {'bilibili': {'player_client': ['android', 'web']}},
                                'concurrent_fragment_downloads': 3,
                                'final_ext': 'mp4',
                                'merge_output_format': 'mp4',
                                'prefer_ffmpeg': True,
                                'keepvideo': False,
                                'postprocessor_args': ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
                                'postprocessors': [
                                    {'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'}
                                ],
                            })
                            if self.has_ffmpeg:
                                retry_opts['ffmpeg_location'] = os.path.dirname(self._find_local_ffmpeg())

                            try:
                                retry_started_at = time.time()
                                with yt_dlp.YoutubeDL(retry_opts) as ydl:
                                    ydl.download([f"https://www.bilibili.com/video/{item['bvid']}"])
                                success = True
                                output_file = self._find_output_for_item(item, retry_started_at)
                                self.log_cb("✅ 内置下载器重试成功")
                                if (not self.is_audio_only) and not self._verify_recent_video_output(item, retry_started_at):
                                    success = False
                                    force_api_mode = True
                            except Exception as retry_e:
                                if self._is_yt_dlp_412(retry_e):
                                    self._cooldown_yt_dlp()
                                    self.log_cb("⚠️ 内置下载器仍遇到 412，切换 API 直链模式...")
                                else:
                                    self.log_error(item['title'], retry_e, context="yt-dlp内置下载器重试")
                                    self.log_cb("⚠️ 内置下载器重试失败，尝试切换 API 直链模式...")
                                force_api_mode = True
                        else:
                            self.log_error(item['title'], e, context="yt-dlp常规模式")
                            self.log_cb("⚠️ 常规模式失败，尝试切换 API 直链模式...")
                            force_api_mode = True

                    except Exception as e:
                        # 记录常规模式失败，但不打断，继续尝试 API 模式
                        if self._is_yt_dlp_412(e):
                            self._cooldown_yt_dlp()
                            self.log_cb("⚠️ 常规模式遇到 412，切换 API 直链模式...")
                        else:
                            self.log_error(item['title'], e, context="yt-dlp常规模式")
                            self.log_cb("⚠️ 常规模式失败，尝试切换 API 直链模式...")
                        force_api_mode = True

                # === 模式2: API 直链 (Fallback) ===
                if force_api_mode:
                    try:
                        if not self.has_aria2:
                            base_opts.pop('external_downloader', None)
                            base_opts.pop('external_downloader_args', None)
                        if self.dl_all_parts:
                            self.log_cb("⚠️ 直链模式暂仅支持P1")
                        self.log_cb(f"🔄 启动 API 解析 ({self.quality})...")

                        stream, r_title, _ = BiliResolver.get_video_stream(item['bvid'], self.session, self.quality)

                        if stream:
                            s_title = self.clean_filename(r_title)
                            ext = 'm4a' if self.is_audio_only else 'mp4'
                            f_path = os.path.join(self.save_dir, f"{s_title}.{ext}")

                            # DASH 模式 (音视频分离)
                            if stream['type'] == 'dash' and self.has_ffmpeg and not self.is_audio_only:
                                v_tmp = os.path.join(self.save_dir, f"tmp_v_{int(time.time())}_{random.randint(1000,9999)}.mp4")
                                a_tmp = os.path.join(self.save_dir, f"tmp_a_{int(time.time())}_{random.randint(1000,9999)}.m4a")

                                try:
                                    self.log_cb("📥 下载视频流...")
                                    v_opt = base_opts.copy()
                                    v_opt['outtmpl'] = v_tmp
                                    with yt_dlp.YoutubeDL(v_opt) as ydl:
                                        ydl.download([stream['video_url']])

                                    self.log_cb("📥 下载音频流...")
                                    a_opt = base_opts.copy()
                                    a_opt['outtmpl'] = a_tmp
                                    with yt_dlp.YoutubeDL(a_opt) as ydl:
                                        ydl.download([stream['audio_url']])

                                    self.log_cb("⚙️ 正在合并音视频...")

                                    # 方案1: 尝试流复制（快速）
                                    merge_success = False
                                    try:
                                        result = subprocess.run(
                                            [self._find_local_ffmpeg(), '-y', '-i', v_tmp, '-i', a_tmp,
                                             '-c:v', 'copy', '-c:a', 'copy',
                                             '-movflags', '+faststart',
                                             '-loglevel', 'warning', f_path],
                                            check=True,
                                            capture_output=True,
                                            text=True,
                                            timeout=120,
                                            **subprocess_no_window_kwargs(),
                                        )
                                        merge_success = True
                                        self.log_cb("✅ 合并完成 (流复制)")
                                    except subprocess.CalledProcessError:
                                        # 方案2: 音频转码（兼容性）
                                        self.log_cb("⚠️ 流复制失败，尝试音频转码...")
                                        try:
                                            subprocess.run(
                                                [self._find_local_ffmpeg(), '-y', '-i', v_tmp, '-i', a_tmp,
                                                 '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                                                 '-movflags', '+faststart',
                                                 '-loglevel', 'warning', f_path],
                                                check=True,
                                                capture_output=True,
                                                text=True,
                                                timeout=180,
                                                **subprocess_no_window_kwargs(),
                                            )
                                            merge_success = True
                                            self.log_cb("✅ 合并完成 (音频转码)")
                                        except subprocess.CalledProcessError as e2:
                                            self.log_cb(f"❌ FFmpeg错误: {e2.stderr[:200] if e2.stderr else '未知'}")

                                    if merge_success:
                                        # 验证输出文件是否有音频流
                                        if self._verify_audio_stream(f_path):
                                            success = True
                                            output_file = f_path
                                        else:
                                            self.log_cb("⚠️ 输出文件缺少音频，尝试重新编码...")
                                            # 方案3: 完全重新编码
                                            try:
                                                subprocess.run(
                                                    [self._find_local_ffmpeg(), '-y', '-i', v_tmp, '-i', a_tmp,
                                                     '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                                                     '-c:a', 'aac', '-b:a', '192k',
                                                     '-movflags', '+faststart',
                                                     '-loglevel', 'warning', f_path],
                                                    check=True,
                                                    capture_output=True,
                                                    text=True,
                                                    timeout=300,
                                                    **subprocess_no_window_kwargs(),
                                                )
                                                if self._verify_audio_stream(f_path):
                                                    success = True
                                                    output_file = f_path
                                                    self.log_cb("✅ 重新编码成功")
                                            except Exception as e3:
                                                self.log_cb(f"❌ 重新编码失败: {str(e3)[:100]}")
                                    else:
                                        # 清理可能损坏的文件
                                        if os.path.exists(f_path):
                                            try: os.remove(f_path)
                                            except: pass

                                except Exception as inner_e:
                                    raise inner_e
                                finally:
                                    # 清理临时文件
                                    if os.path.exists(v_tmp): os.remove(v_tmp)
                                    if os.path.exists(a_tmp): os.remove(a_tmp)

                            # 单文件模式 (DURL) - 通常已有音频
                            else:
                                url = stream.get('audio_url') if self.is_audio_only else None
                                url = url or stream.get('url') or stream.get('video_url')
                                d_opt = base_opts.copy()
                                d_opt['outtmpl'] = f_path
                                with yt_dlp.YoutubeDL(d_opt) as ydl:
                                    ydl.download([url])

                                # 验证音频
                                if self.is_audio_only or self._verify_audio_stream(f_path):
                                    success = True
                                    output_file = f_path
                                    self.log_cb("✅ 下载完成")
                                else:
                                    self.log_cb("⚠️ 文件可能缺少音频流")
                                    try:
                                        if os.path.exists(f_path):
                                            os.remove(f_path)
                                    except Exception:
                                        pass

                        else:
                            self.log_cb("❌ API返回空数据 (可能需要会员或地区限制)")
                            with open(os.environ.get("BILI_ERROR_LOG") or ERROR_LOG, "a", encoding="utf-8") as f:
                                f.write(f"[{time.ctime()}] API解析为空: {item['title']} - {item['bvid']}\n")

                    except Exception as e:
                        self.log_error(item['title'], e, context="API模式")

                if success:
                    if not output_file:
                        output_file = self._find_output_for_item(item, item_started_at)
                    self._notify_history(item, output_file)
                    self.progress_cb((i + 1) / total_videos, f"完成: {safe_title}", True, i + 1, total_videos)
                else:
                    self.fail_cb(item)

        except Exception as global_e:
            self.log_error("全局线程", global_e, context="Worker主循环")

        finally:
            if cookie_file and os.path.exists(cookie_file):
                try: os.remove(cookie_file)
                except: pass
            self.progress_cb(-1, "DONE", False)
