# 开发者指南

## 1. 项目结构

```text
BiliDownloader_0705/
  web_app.py                  # 本地 Web API 服务
  worker.py                   # 下载任务 worker
  manager.py                  # 登录、Cookie、历史记录管理
  utils.py                    # B 站解析工具
  webui/
    index.html                # Web UI 结构
    app.js                    # 前端状态、事件和渲染
    styles.css                # 样式
  eagle_integration/
    export_to_eagle.py        # Eagle API 导入与封面下载
    import_videos_to_eagle.py # 视频扫描、抽帧、套图生成
    apply_contact_sheets_to_eagle.py # 写入 Eagle 自定义缩略图
    eagle_batch_processor.py  # 独立 Eagle 批处理器
  userdata/                   # 用户数据，开源时不要提交
```

## 2. 配置文件

主要配置保存在 `userdata/app_settings.json`：

```json
{
  "dataDir": "E:/BiliDownloaderData",
  "downloadDir": "E:/Videos",
  "ffmpegPath": "D:/tools/ffmpeg.exe",
  "ffprobePath": "D:/tools/ffprobe.exe",
  "aria2Path": "D:/tools/aria2c.exe",
  "eagleExportDir": "E:/BiliDownloaderCache/eagle_exports",
  "errorLogPath": "E:/BiliDownloaderData/error_log.txt"
}
```

`dataDir` 是启动级配置。程序启动时会先读取默认 `userdata/app_settings.json`，如果其中设置了 `dataDir`，后续缓存、下载记录和用户历史会优先使用该目录。修改 `dataDir` 后需要重启。

程序会把 `download_records.json`、`history.json`、收藏夹缓存、Eagle 索引、搜索缓存和 `bili_video_tags.json` 标签缓存统一放在当前 `dataDir`。切换自定义数据目录时，相关路径也会同步更新；不要在代码中单独拼接默认 `userdata` 路径。

## 3. Web API

常用接口：

- `GET /api/state`：获取完整前端状态。
- `POST /api/login/qr`：生成登录二维码。
- `POST /api/sync`：同步收藏夹。
- `POST /api/creator/search`：按账号名称、UID 或空间主页查找账号候选。
- `POST /api/creator/sync`：低频串行获取指定账号的公开投稿；前端用顶部搜索栏本地筛选。
- `POST /api/tags/cloud`：手动生成标签词云；仅补齐本地 `bili_video_tags.json` 中不存在的 BV 标签。
- `POST /api/tags/cancel`：请求停止当前标签词云任务。
- `POST /api/download/start`：启动下载。
- `POST /api/eagle/import`：导入已下载视频到 Eagle。
- `POST /api/eagle/folder-thumbnails`：修复 Eagle 文件夹内本地视频缩略图。
- `POST /api/settings`：保存路径设置。

## 4. 下载流程

1. 前端提交选中的 BV 和下载设置。
2. `web_app.py` 汇总当前收藏夹、账号投稿或手动列表中的视频元数据。
3. 创建 `DownloadWorker`。
4. `worker.py` 使用 yt-dlp 下载视频。
5. 如果使用外部 Aria2 失败，会自动禁用 Aria2 并回退。
6. 下载成功后调用 `record_download`，写入 `download_records.json` 和历史记录。
7. 异步缓存弹幕 XML，供后续套图抽帧使用。

## 5. Eagle 套图流程

### 已下载视频导入 Eagle

1. 从 `download_records.json` 找到本地视频。
2. 用 `import_videos_to_eagle.generate_contact_sheet` 生成套图。
3. 调 Eagle 本地 API 导入视频。
4. 写入 Eagle metadata，自定义缩略图。
5. 可选删除原下载文件。

### 修复 Eagle 文件夹封面

1. 扫描 `.library/images/*.info` 中的视频。
2. 默认跳过 `customThumbnail=true` 的项目。
3. 尝试匹配 BV：
   - Eagle metadata 中的 BV、URL、标签、备注。
   - `download_records.json`。
   - `userdata/_web_cache/fav_*.json`。
   - `eagle_integration/exports/*manifest.json`。
   - 必要时低频标题搜索。
4. 匹配成功：使用 B 站封面和本地弹幕缓存辅助抽帧。
5. 匹配失败：不请求封面、不读取弹幕，直接本地抽帧。
6. 写入 Eagle 缩略图并更新 `mtime.json`。

## 6. 风控设计

开发新功能时请遵守：

- 优先用本地缓存和历史记录。
- 请求 B 站接口前先判断是否必要。
- 不做高并发标题搜索。
- 新设备首次同步收藏夹使用低频串行分页；遇到 `-412`、`-352`、`412`、`352` 立即停止。
- 账号投稿检索只返回候选账号；确认账号后才启动投稿分页。投稿分页同样必须低频串行，遇到风控码立即停止。
- 标准收藏夹/投稿同步不得自动读取视频标签。标签只能由用户手动发起词云生成，逐个串行读取，并缓存到 `bili_video_tags.json`。
- 标签请求首次等待约 1.4-2.6 秒，后续请求间隔约 1.15-1.9 秒；遇到 `-412`、`-352`、`403`、`412` 或 `429` 必须立即停止。
- 对 412、429、403 立即降级或跳过。
- 不因追求速度牺牲账号安全。

## 7. 历史记录迁移格式

“导出记录”生成的 `bili_history_bundle.json` 是完整迁移包，包含 `history` 和 `downloadRecords` 两部分。导入端同时兼容完整迁移包、原生 `download_records.json`、旧版纯 BV 列表以及旧版 `history.json` / `bili_history.json`。导入时必须同时写入当前设备的 `history.json` 和 `download_records.json`，否则前端可能只能看到 BV 去重状态，无法恢复标题、路径和下载时间等详细信息。

## 8. 开源清理清单

提交前确认 `.gitignore` 排除：

- `userdata/`
- `last_login_cookie.json`
- `bili_netscape_temp.txt`
- `error_log.txt`
- Eagle `.library` 目录
- 下载视频目录
- `eagle_integration/exports/` 中的个人缓存

## 9. 验证命令

```bash
python -m py_compile web_app.py worker.py
python -m py_compile eagle_integration/*.py
node --check webui/app.js
```

Windows PowerShell 下可以使用：

```powershell
$files = @("web_app.py","worker.py") + (Get-ChildItem eagle_integration -Filter *.py | ForEach-Object { $_.FullName })
python -m py_compile @files
node --check webui\app.js
```
