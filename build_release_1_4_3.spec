# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


ROOT = r"E:\python&程序\BiliDownloader_0705"
ROOT_PATH = Path(ROOT)


def packaged_eagle_files():
    """Include Eagle helper code, but never carry locally generated exports."""
    source_root = ROOT_PATH / "eagle_integration"
    files = []
    for path in source_root.rglob("*"):
        relative = path.relative_to(source_root)
        if not path.is_file() or "exports" in relative.parts or "__pycache__" in relative.parts:
            continue
        files.append((str(path), str(path.parent.relative_to(ROOT_PATH))))
    return files

datas = [
    (rf"{ROOT}\webui", "webui"),
    (rf"{ROOT}\docs", "docs"),
    (rf"{ROOT}\README.md", "."),
]
datas += packaged_eagle_files()

binaries = [
    (rf"{ROOT}\ffmpeg.exe", "."),
    (rf"{ROOT}\aria2c.exe", "."),
]

hiddenimports = [
    "PIL._tkinter_finder",
    "PIL.ImageStat",
    "PIL.ImageChops",
    "PIL.ImageDraw",
    "PIL.ImageFont",
    "tkinter.ttk",
    "tkinter.scrolledtext",
]

tmp_ret = collect_all("yt_dlp")
datas += tmp_ret[0]
binaries += tmp_ret[1]
hiddenimports += tmp_ret[2]

tmp_ret = collect_all("qrcode")
datas += tmp_ret[0]
binaries += tmp_ret[1]
hiddenimports += tmp_ret[2]

a = Analysis(
    [rf"{ROOT}\web_app.py"],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BiliDownloaderStudio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="BiliDownloaderStudio",
)
