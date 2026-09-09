# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


ROOT_PATH = Path(SPECPATH).resolve()


def include_if_exists(path, destination="."):
    return [(str(path), destination)] if path.is_file() else []


def packaged_eagle_files():
    """Ship helper code and docs, never per-user Eagle exports or Python cache."""
    source_root = ROOT_PATH / "eagle_integration"
    files = []
    for path in source_root.rglob("*"):
        relative = path.relative_to(source_root)
        if not path.is_file() or "exports" in relative.parts or "__pycache__" in relative.parts:
            continue
        files.append((str(path), str(path.parent.relative_to(ROOT_PATH))))
    return files


datas = [
    (str(ROOT_PATH / "webui"), "webui"),
    (str(ROOT_PATH / "docs"), "docs"),
    (str(ROOT_PATH / "README.md"), "."),
]
datas += packaged_eagle_files()

binaries = []
binaries += include_if_exists(ROOT_PATH / "ffmpeg.exe")
binaries += include_if_exists(ROOT_PATH / "aria2c.exe")

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
    [str(ROOT_PATH / "web_app.py")],
    pathex=[str(ROOT_PATH)],
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
