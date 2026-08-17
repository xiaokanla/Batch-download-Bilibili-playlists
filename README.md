# BiliDownloader Studio

BiliDownloader Studio 是一个面向 B 站收藏夹批量下载、历史去重、Eagle 视频导入和视频套图封面生成的本地 Web 工具。

> 当前正式版：`v1.2.7-dropdownfix`

## 下载

普通用户建议直接下载 Release 里的正式版压缩包，解压后运行 `BiliDownloaderStudio.exe`，不需要配置 Python 环境。

最新正式包：

- `BiliDownloaderStudio_Release_1.2.7_DropdownFix_20260818.zip`
- zip SHA256：`E9212036F1DBB4C485668DB4C28CB8FE389FE7ABA2A52FF333B9A4333F39ADD4`
- exe SHA256：`352AE761B1E07EB559887A9DB7CA8D8C6326035FB4C4A598AB5C8A30D7A0DB07`

## 主要功能

- 扫码登录 B 站并同步收藏夹。
- 按收藏夹、月份、时长、下载状态筛选视频。
- 批量下载选中视频，支持暂停、取消、限速、音频下载和分 P 下载。
- 导入/导出历史下载记录，换设备后避免重复下载。
- 一键打开下载记录文件位置，方便迁移记录。
- 将已下载视频导入 Eagle 指定文件夹。
- 为 Eagle 视频生成套图缩略图：优先使用 B 站封面和弹幕峰值帧，匹配不到 BV 时自动退回本地抽帧。
- 自定义路径：数据目录、下载目录、FFmpeg、FFprobe、Aria2、Eagle 缓存导出目录、错误日志。
- 网页 Eagle 导入和封面生成任务默认不弹额外系统窗口，进度和错误都显示在网页里。

## 快速开始

### 使用 exe

1. 从 GitHub Release 下载正式版压缩包。
2. 解压到任意目录。
3. 双击 `BiliDownloaderStudio.exe`。
4. 程序会自动打开本地网页界面。
5. 按界面里的新手引导完成登录、同步、下载或 Eagle 导入。

### 从源码运行

1. 安装 Python 3.10 或更高版本。
2. 安装依赖：

```bash
pip install -r requirements.txt
```

3. 启动：

```bash
python web_app.py
```

4. 浏览器打开：

```text
http://127.0.0.1:8765
```

## Eagle 导入说明

1. 先打开 Eagle。
2. 在 BiliDownloader 右侧 Eagle 区域选择 `.library` 目录。
3. 选择目标 Eagle 文件夹。
4. 选择速度模式。
5. 点击“导入已下载视频到 Eagle”。
6. 任务进度、成功数、失败数和错误信息会显示在网页面板里。

如果勾选“导入成功后删除本地视频”，程序会在 Eagle 导入和封面处理成功后删除下载目录里的源视频，以节省空间。

## 文档

- [用户指南](docs/USER_GUIDE.md)
- [开发者指南](docs/DEVELOPER_GUIDE.md)

## 风控原则

本项目默认采用保守策略：缓存数据、低频请求、优先使用本地记录，不通过高并发请求提高速度。请不要把并发、请求频率或重试策略改得过于激进。

## 开源提醒

不要提交以下个人文件：

- `last_login_cookie.json`
- `bili_netscape_temp.txt`
- `userdata/`
- Eagle 库目录
- 下载视频目录
- 任何 Cookie、账号、私人收藏夹缓存

## 最新修复

### v1.2.7-dropdownfix

- 修复收藏夹下拉框被“筛选”面板遮挡的问题。
- 静态 UI 文件改为禁缓存加载，避免运行旧页面导致修复不生效。
- 新增“打开记录位置”按钮，方便迁移 `download_records.json`。

### v1.2.6-nopopup

- 修复网页导入 Eagle 时可能弹出大量系统窗口的问题。
- 修复 Eagle 导入流程误触发 `tkinter.ttk` 导致失败的问题。
- 修复打包版缺少 `PIL.ImageStat` 导致封面/套图生成失败的问题。
- 让 `ffmpeg` / `ffprobe` 后台运行时不再弹出额外窗口。
- 正式版隐藏“恢复初始状态”，测试版保留该功能。
