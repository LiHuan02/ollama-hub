# Ollama Hub

一个轻量、开源、零依赖的 Ollama 可视化管理工具。可以在浏览器里搜索、筛选、安装、卸载和查看本地 Ollama 模型，不必再复制官网命令到终端。

- **本地 Web 版**：双击 `start.bat` 即可启动，适合只想本地使用的人
- **Chrome / Edge 扩展版**：固定在浏览器工具栏，点图标就打开，无需手动启动 Web 服务
- 不需要 `npm install`，只需要 Node.js 18+（仅 Web 版需要）
- 本地 Web 服务只绑定 `127.0.0.1`，不会开放到局域网

> **公开项目**：采用 [MIT License](LICENSE)。不收集任何数据；模型管理操作只发往本机 Ollama。

## 功能

### 模型市场

- **推荐（默认）/ 最新 / 最多下载**三种排序：推荐流优先展示近期常用的 GLM、DeepSeek 等模型；最多下载保留累计下载榜单
- 名称搜索，以及能力筛选：工具调用、思考、视觉、向量、云端
- 高级筛选：最近更新（7/30/90 天、一年内）、下载量门槛、官方/社区来源
- 展开模型卡片查看全部版本 Tag：文件大小、上下文窗口、输入类型、更新时间
- 支持官方模型及「作者/模型」形式的社区模型
- 一键拉取模型，显示实时下载进度、传输速度；下载开始后等待完成，失败任务可清除后重新拉取
- 父模型卡显示已安装版本数；展开版本表可精确区分“已安装 / 同内容已安装 / 未安装”
- 直接输入模型名，或粘贴完整的 `ollama pull qwen3:4b` 命令拉取

### 本地模型管理

- 查看已安装模型的参数规模、量化等级、模型家族、能力、磁盘占用与更新时间
- 查看详情：参数定义、对话模板、Modelfile
- 一键删除本地模型，带确认提示
- 查看内存/显存中正在运行的模型，并可立即卸载

### 本地聊天

- 基于 Ollama 原生 `/api/chat` 的多轮流式对话，支持系统提示词、温度、停止生成和 token 速度显示
- 会话可新建、重命名、删除；聊天记录和草稿仅存于当前浏览器的本地存储，不会上传或云同步
- 自动排除 embedding 向量模型；无聊天模型时会提示到模型市场安装

### 本机适配与帮助

- Web 版在启动时自动检测 Windows 的内存和每张 GPU 的显存；可在帮助页重新检测或手工覆盖（浏览器扩展受权限限制需手工填写）
- 换一台电脑启动会按新硬件自动重算；给每个版本估算 **轻松 / 勉强 / 基本不可运行** 压力
- 帮助页介绍常见 Tag、量化后缀、按显存选模型的建议与常见问题

压力等级是估算，不等同于实测：计算使用 `模型文件大小 × 1.35 + 0.8GB`，会随上下文长度、并发数、GPU offload 设置、当前已加载模型而变化；“轻松”要求模型可基本装入单张 GPU 显存，避免多卡显存简单相加造成误导。

## Web 版启动

前提：Ollama 已启动（桌面版开着即可，或执行 `ollama serve`）。

双击 [start.bat](start.bat)，它会自动打开浏览器：

```bash
node ollama_hub.mjs
```

默认页面地址是 `http://127.0.0.1:11435`。再次双击 `start.bat` 时，如果服务已经在运行，会直接打开已有页面，而不会要求手动输入地址或再开一个实例。

```bash
node ollama_hub.mjs --port 8080   # 指定端口
node ollama_hub.mjs --no-open     # 不自动打开浏览器
```

默认连接 `http://127.0.0.1:11434`。如果 Ollama 在其它地址，可设置环境变量：

```bat
set OLLAMA_HOST=http://127.0.0.1:11434
start.bat
```

## 浏览器扩展版（Chrome / Edge）

扩展版的功能与 Web 版一致，点击工具栏的 Ollama Hub 图标即可打开管理页，不需要点 `.bat`。

1. 打开 Chrome 的 `chrome://extensions`，或 Edge 的 `edge://extensions`
2. 打开右上角的「开发人员模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目下的 `extension` 文件夹
5. 将 Ollama Hub 固定到浏览器工具栏

> 每次修改 Web UI 或解析器后，运行一次 `node tools/build-extension.mjs`，然后在扩展管理页点击扩展的刷新按钮。`extension/index.html` 和 `extension/lib/site-parser.mjs` 是构建产物，不要直接修改。

扩展通过 Chrome 的 `host_permissions` 访问本机 `127.0.0.1:11434` 与 `ollama.com`，不会访问其它网站。**首次使用扩展前请双击项目根目录的 [enable_extension_cors.bat](enable_extension_cors.bat)，然后完全退出并重开 Ollama 桌面版**；该一次性配置会长期保留，即使电脑重启和 Ollama 开机自启也有效。未配置时 Ollama 会拒绝 `chrome-extension://` origin，扩展的详情、拉取和聊天会显示 HTTP 403。

更新本项目后请在扩展管理页点击扩展的“刷新”按钮；新版已将脚本外置以符合 Manifest V3 CSP，旧版扩展会因内联脚本被拦截而一直显示加载中。

## 为什么没有集成到 Ollama 桌面软件本身？

Ollama 桌面版没有公开的插件注入机制；修改其安装文件既不稳定，也会在官方更新后被覆盖。因此本项目提供：

- 零依赖的本地 Web 控制台（最轻量）
- 常驻浏览器工具栏的 MV3 扩展（最接近原生插件体验）

两者均使用官方 Ollama HTTP API，不改动 Ollama 本体。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `ollama_hub.mjs` | Web 版服务端：Ollama API 代理、官网抓取、硬件检测、启动处理 |
| `public/index.html` | 共享前端（Claude 风格主题；无第三方资源） |
| `lib/site-parser.mjs` | ollama.com 搜索页和版本页解析器 |
| `extension/` | 可加载的 Chrome / Edge Manifest V3 扩展 |
| `tools/build-extension.mjs` | 将前端与解析器同步到扩展构建目录 |
| `start.bat` | Windows 双击启动脚本 |
| `enable_extension_cors.bat` | 为独立扩展配置 Ollama 的 Chrome/Edge origin 白名单 |

## 开发与排查

```bash
# 语法检查
node --check ollama_hub.mjs
node --check extension/background.js

# 构建扩展目录
node tools/build-extension.mjs
```

### 下载任务与 Hub 终端

为避免中断后残留文件难以安全处理，下载过程不提供取消按钮；失败任务可从任务面板清除后重新拉取。

网页启动后可能会看到一个运行中的 `node ollama_hub.mjs --no-open` 终端，这是 Hub 本地服务（默认端口 11435），用于提供页面和代理请求；它不是 Ollama 本体，也不是模型下载卡死。关闭它会让网页版停止访问，但不会删除模型或关闭 Ollama 桌面版。

官网页面如果改版，模型市场可能无法解析，此时仍可使用「直接拉取」输入框。修复时优先检查 `lib/site-parser.mjs`。
