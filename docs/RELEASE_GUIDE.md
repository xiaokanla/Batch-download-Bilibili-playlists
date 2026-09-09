# 发布指南

所有公开版本都使用同一套命名。不要在公开标签或发布文件中加入功能名、日期、
`clean`、`final` 或其他本地后缀。

## 命名规范

| 项目 | 固定格式 | 示例 |
| --- | --- | --- |
| Git 标签 | `vX.Y.Z` | `v1.4.4` |
| GitHub Release 标题 | `BiliDownloader Studio vX.Y.Z` | `BiliDownloader Studio v1.4.4` |
| Windows 压缩包 | `BiliDownloaderStudio-vX.Y.Z-windows-x64.zip` | `BiliDownloaderStudio-v1.4.4-windows-x64.zip` |
| 校验文件 | `BiliDownloaderStudio-vX.Y.Z-windows-x64.sha256` | `BiliDownloaderStudio-v1.4.4-windows-x64.sha256` |
| Eagle 插件包 | `BiliDownloader-TagGraph-vX.Y.Z.eagleplugin` | `BiliDownloader-TagGraph-v0.3.3.eagleplugin` |
| 本地构建目录 | `release/<asset-name>/` | `release/BiliDownloaderStudio-v1.4.4-windows-x64/` |

`web_app.py` 中的应用版本可以携带开发后缀，但数字前缀必须与发布版本一致。
例如 `1.4.4-download-engine` 发布时对应 `v1.4.4`。

## Windows 主程序发布

1. 更新 `APP_VERSION`、README、相关文档和更新说明。
2. 运行项目检查。
3. 在 `main` 分支提交全部源代码改动。
4. 复制 `docs/RELEASE_NOTES_TEMPLATE.md` 为本次版本说明文件，替换其中的占位内容。
5. 构建安装包：

```powershell
.\tools\Build-Release.ps1 -Version 1.4.4
```

6. 从新生成的 `release/` 目录中测试可执行程序。
7. 确认源代码工作区干净后再发布：

```powershell
.\tools\Build-Release.ps1 -Version 1.4.4 -NotesFile .\docs\release-notes-v1.4.4.md -Publish
```

脚本会创建 Git 标签、推送 `main` 和标签，并创建 GitHub Release。主程序 Release
固定只附带两个文件：压缩包和对应的 SHA-256 校验文件。

## Eagle 插件打包

先更新 `eagle_plugin_tag_graph/manifest.json`，再运行：

```powershell
.\tools\Build-EaglePlugin.ps1
```

插件包固定为一个 `.eagleplugin` 文件和一个 SHA-256 文件，不再额外发布内容相同的
`.zip` 文件。

## 隐私检查

Windows 主程序构建脚本会拒绝包含以下内容的压缩包：

- `userdata/`
- Login cookies
- Download history or SQLite databases
- Error logs
- Eagle exports and generated contact sheets

生成文件统一放在 `release/`，该目录已被 Git 忽略。发布前仍应检查压缩包内容，并从生成
目录运行一次程序。
