# Agent Note：Electron 桌面客户端——进程内宿主、dsh:// 载体，以及打包发布对闭包的要求

Status: implemented

[English](2026-08-14-electron-desktop-app.md) | 中文

## Problem

DeepSeek Harness 只有 Web 客户端：用户需要自己启动后端、找到端口、再打开浏览器。桌面客户端必须自动管理后端——打开应用即启动 harness，关闭即干净退出——并且要有原生手感。GUI 分层设计笔记（2026-07-19）已经定下架构：Electron 主进程就是宿主进程，而且"新应用需要零新包"——装配全部写在应用内，复用已有的 bundle、网关和客户端。

## Decision

**宿主进程内运行，渲染层复用现有 Web 客户端，由自定义 scheme 承载。** `startHost` 运行与 CLI 相同的 profile-boot 序列（desktop profile = base + web-app bundle，desktop 补丁层剥掉 HTTP 传输行），然后把构建好的 web dist 通过 `dsh://` 协议处理器提供出去。客户端对 `/api` 路径的 `fetch`/`WebSocket` 被 shim 替换，经 `postMessage` ⇄ preload ⇄ IPC 中继到主进程的传输层，后者用与 web 载体相同的 `createSharedFetchHandler`/下链帧泵分发。没有 HTTP 服务器、没有端口；`$DSH_HOME` 与 `dsh web` 共享。

**页面权威必须是回环分类的。** 客户端从 `location.hostname` 推导 `connection.isLoopback`，非回环页面会把每个设置作用域绑定为内存模式（插件配置卡片什么都不渲染）。`dsh://localhost` 获得与 web 客户端从 `http://localhost` 相同的分类。

**打包应用把整个组合闭包声明为直接依赖。** electron-builder 只打包应用声明的生产闭包。启动链静态导入 peer 包（`cordis-plugin-group`、各能力 peer），loader 又会在运行时从应用的 node_modules 按名解析每个补丁行的插件。两组都必须成为直接依赖——pnpm 才会装它们的 peer——并且闭包扫描（打包图上所有静态 `@deepseek-ai` 导入加补丁行名）必须报告零缺口。

**应用以非打包形式发布（`asar: false`）。** 启动时会把 `$DSH_HOME/profiles/node_modules` 用 junction 指向应用的依赖树，loader 才能从 profile 根解析各插件行。Windows junction 无法穿进 asar（它是一个文件），所以 asar 打包下每个 loader 条目都失败、启动画面挂起。非打包后所有路径都是真实文件。重新打 tag 前先用模拟的非打包布局启动了一遍打包闭包验证。

**WinUI 风格窗口外壳。** 无边框 `titleBarStyle: hidden` + Window Controls Overlay + Mica；标题栏按钮颜色通过 `setTitleBarOverlay` 跟随 `nativeTheme`；标题带是拖拽区，由注入脚本盖戳（CSS 位置选择器不行——插槽渲染器把列包在 `display: contents` 锚点里）；退出全屏时重新应用材质让 DWM 恢复圆角；启动动画的扫光用 SVG 内部的 `clipPath` 裁剪到字标上（不用 CSS `url()` 引用——它们在注入文档里不可靠）。

**通过 tag 触发的工作流发布。** 推送 `v*` tag 会在托管 runner 上构建 macOS dmg + Windows NSIS 并把两者挂到 GitHub Release。`@electron/get` 用 pnpm override 钉在 `^3.1.0`：electron-builder 26.15 要从它读 `ElectronDownloadCacheMode`，而锁文件默认落在 3.0.0，导致每次打包都崩溃。

## Consequences

桌面应用在快照测试里无钥匙启动（`apps/desktop/tests/start-host.snapshot.ts`），51 个单测覆盖传输、协议、中继、shim、关闭、窗口状态和窗口 chrome。安装包未签名（CI 没有证书，`CSC_IDENTITY_AUTO_DISCOVERY=false`），每次 tag 前在真实安装上验证启动界面与 UI。本地 Windows 打包在网络屏蔽 GitHub release 下载时需要 `ELECTRON_MIRROR`；托管 runner 直接下载。`dsh://localhost` origin 和拖拽带/chrome CSS 只属于桌面端——web 客户端与 `dsh web` 行为不变。

## Alternatives considered

- **子进程宿主**——分层笔记已否决：冷启动、端口占用、第二个 `$DSH_HOME` 锁域；进程内宿主正是该设计的要点。
- **`asar` + `asarUnpack: node_modules/**`**——解包后的文件确实存在，但 heal junction 经 `require` 解析到 `app.asar` 路径，而指向文件内部路径的 Windows junction 在 OS 层面就是坏的，Electron 的 asar 重定向来不及生效。
- **CSS `mask: url(#id)` 扫光**——把光效裁剪到内容上不能依赖注入文档里的 CSS 级片段引用；SVG 内部 `clipPath` + `use`（与鲸鱼标记自身 clip 相同的机制）才可靠。
- **`dsh://app` 页面权威**——会让设置作用域进入内存模式、插件配置页空白；必须用回环权威。
