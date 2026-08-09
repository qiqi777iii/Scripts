# Scripts

集中维护和分发 userscript 与 Scripting App 脚本包。

## 仓库结构

- `userscripts/`：可直接安装到 userscript 管理器的浏览器脚本。
- `scripts/`：可导入 Scripting App 的完整脚本包。
- `surge/`：Surge 模块及其配套脚本。

## Userscript

| 脚本 | 安装 |
| --- | --- |
| 封面视频预览 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/cover-video-preview.user.js) |
| 视频自动最高画质 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/auto-select-highest-quality.user.js) |
| 工具栏 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/floating-toolbar.user.js) |
| 磁力链验车 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/magnet-link-checker.user.js) |
| MissAV Plyr 本地样式修复 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/missav-plyr-local-style.user.js) |
| MissAV浏览记录 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/missav-browsing-history.user.js) |
| 新标签页打开 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/new-tab-opener.user.js) |
| 快捷翻页 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/quick-pager.user.js) |
| 标签页检查 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/tab-checker.user.js) |
| 视频全屏 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/video-fullscreen.user.js) |
| 番号快速搜索 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/search-av-mobile.user.js) |
| Ohentai 弹窗广告拦截 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/ohentai-popup-blocker.user.js) |

## Scripting App 脚本包

| 脚本包 | 项目链接 |
| --- | --- |
| Claude额度 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/ClaudeUsage) |
| Codex额度 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/CodexUsage) |
| 标签页收藏 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/TabsSaver) |
| 视频打开记录 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/VideoOpenHistory) |
| 翻译器 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/Translator) |
| 媒体下载 | [地址](https://github.com/qiqi777iii/Scripts/tree/main/scripts/MediaDownloader) |

## Surge 模块

| 模块 | 安装 |
| --- | --- |
| 出站模式切换 | [安装](https://raw.githubusercontent.com/qiqi777iii/Scripts/main/surge/outbound-mode-switch.sgmodule) |

## 使用说明

### Userscript

点击对应的“安装”链接，通过支持 userscript 的浏览器扩展导入。脚本已配置 GitHub Raw 更新地址的，可由管理器检查后续版本。

### Scripting App 脚本包

复制对应项目链接，在 Scripting App 中通过远程资源导入完整目录。脚本包的组件、Intent、Widget 和其他配套文件会随项目一起导入。

> `scripts/TabsSaver/tabs-saver-button.user.js` 是标签页收藏单入口包的内置组件，由脚本包负责安装和更新，不需要单独导入。

### Surge 模块

复制模块链接，在 Surge 的「模块」中通过 URL 安装，模块内的脚本会自动从仓库拉取。
