# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

桌面应用：Electron 外壳在**进程内**启动 dsh 宿主，并通过 IPC fetch/WebSocket 载体复用现有 Web 客户端——没有 HTTP 服务器、没有端口，与 `dsh web` 共享同一个 `$DSH_HOME`。打开应用即启动 harness；关闭应用则以有界优雅退出销毁整棵树。

## 交付内容

- **进程内宿主**——[`src/start-host.ts`](src/start-host.ts) 运行 `desktop` profile（base + web-app bundle）的 profile-boot 序列，HTTP 传输行由 [`config/desktop.patch.yml`](config/desktop.patch.yml) 剥掉；主进程与宿主共享同一个进程生命周期。
- **`dsh://` 载体**——[`src/protocol.ts`](src/protocol.ts) 提供构建好的 web 前端，注入 boot 清单、传输 shim 与窗口 chrome；[`src/relay.ts`](src/relay.ts) + [`src/shim.ts`](src/shim.ts) 把客户端的 `/api` fetch 与 WebSocket 流量经 postMessage ⇄ IPC 转发。
- **WinUI 风格窗口**——无边框 + Window Controls Overlay + Mica：标题栏按钮颜色跟随系统主题，标题带是拖拽区，应用表面落在 Mica 材质上，退出全屏会恢复圆角。
- **启动动画**——字标居中于 Mica 材质之上，光带扫过字形（SVG 内部裁剪，无 CSS 片段引用），宿主启动期间展示。

## 打包

electron-builder 配置在 [`electron-builder.yml`](electron-builder.yml)：Windows 出 NSIS，macOS 出 dmg。两个约束决定了布局：

- **应用把整个组合闭包声明为直接依赖。** 启动链静态导入 peer 包，loader 在运行时从应用的 `node_modules` 按名解析每个补丁行的插件；electron-builder 只打包已声明的生产依赖。
- **`asar: false`。** 启动时会把 `$DSH_HOME/profiles/node_modules` 用 junction 指向应用的依赖树，而 Windows junction 无法穿进 asar。一切以真实文件发布。

发布工作流（`.github/workflows/build-desktop.yml`）在 `v*` tag 上构建两个平台的安装包并挂到 GitHub Release；CI 没有签名证书，因此安装包未签名。

## 开发

在仓库根目录构建一次（`pnpm run build`），然后从源码运行：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

单元测试与无钥匙启动快照在纯 Node 下运行（不需要 Electron）：

```sh
pnpm vitest run apps/desktop/tests
```

图标（`build/icon.png`，DeepSeek 鲸鱼标记）可用 `pnpm run build:icon` 从 `build/icon.svg` 重新生成。
