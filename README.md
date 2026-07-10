# QiQi-Safari-script

用于集中维护和分发 Safari userscript 与 Scripting App 脚本包。

## 仓库结构

```text
QiQi-Safari-script/
├── userscripts/                 # Safari userscript
│   ├── floating-pager.user.js
│   ├── magnet-link-checker.user.js
│   ├── new-tab-opener.user.js
│   ├── search-av-mobile.user.js
│   ├── senplayer-video-button.user.js
│   └── video-player.user.js
└── scripts/                     # Scripting App 脚本包
    ├── Claude额度/
    └── Codex额度/
```

## Safari userscript

| 脚本 | 功能 | 安装 |
| --- | --- | --- |
| [悬浮翻页](userscripts/floating-pager.user.js) | 自动识别上一页、下一页，并显示可拖动的悬浮翻页按钮。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/floating-pager.user.js) |
| [磁力链验车](userscripts/magnet-link-checker.user.js) | 为网页中的磁力链接提供验车和复制功能。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/magnet-link-checker.user.js) |
| [新标签页打开](userscripts/new-tab-opener.user.js) | 通过悬浮开关控制网页链接是否在 Safari 新标签页中打开。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/new-tab-opener.user.js) |
| [Search-av-mobile](userscripts/search-av-mobile.user.js) | 识别网页番号，并提供面向移动端的快捷搜索功能。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/search-av-mobile.user.js) |
| [SenPlayer 播放](userscripts/senplayer-video-button.user.js) | 捕获当前网页视频地址，并通过 SenPlayer 打开播放。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/senplayer-video-button.user.js) |
| [播放当前页视频](userscripts/video-player.user.js) | 在网页中提供播放、暂停、快进、后退和全屏等悬浮控制。 | [安装 / 更新](https://raw.githubusercontent.com/qiqi777iii/QiQi-Safari-script/main/userscripts/video-player.user.js) |

### 安装方法

1. 在 iPhone 或 iPad 上安装支持 userscript 的 Safari 扩展。
2. 点击表格中的“安装 / 更新”。
3. 由扩展识别并安装 `.user.js` 文件。
4. 脚本中配置了 `@updateURL` 和 `@downloadURL` 时，可继续从本仓库获取更新。

## Scripting App 脚本包

| 脚本包 | 用途 | 目录 |
| --- | --- | --- |
| Claude额度 | 查看 Claude 使用额度。 | [打开脚本包](https://github.com/qiqi777iii/QiQi-Safari-script/tree/main/scripts/Claude%E9%A2%9D%E5%BA%A6) |
| Codex额度 | 查看 Codex 使用额度。 | [打开脚本包](https://github.com/qiqi777iii/QiQi-Safari-script/tree/main/scripts/Codex%E9%A2%9D%E5%BA%A6) |

Scripting App 脚本只维护 `scripts/<脚本名>/` 中的完整源码包。本仓库不再维护 `releases/` ZIP 副本。

## 维护约定

- 普通 Safari userscript 统一放在 `userscripts/`。
- Scripting App 脚本包统一放在 `scripts/<脚本名>/`。
- 仓库主目录不重复保存 userscript。
- userscript 的远程更新地址统一指向 `main/userscripts/<文件名>.user.js`。
- Scripting 脚本包直接以 `scripts/<脚本名>/` 目录作为维护源。

## 说明

部分脚本基于其他开源脚本修改，具体来源、作者和许可证以相应脚本文件头部的元数据为准。网页结构或 Safari 扩展行为发生变化时，脚本功能可能需要同步调整。
