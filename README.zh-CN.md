# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把每个 YouTube 视频变成一份可以深入学习的资料。YouTube Digest 把字幕、双语翻译、AI 概览、内容讲解和时间戳笔记放进同一个 Chrome 侧边栏，让你可以持续学习视频中的知识和语言，同时不丢失原视频上下文。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过 AI 概览、章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、概览或笔记中的时间戳，快速跳转到对应位置。
- 保存自动润色的时间戳笔记，方便之后复习。
- 使用自己的 API Key，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

YouTube Digest 是一个需要自行提供 API Key 的开源项目，通过 GitHub 安装。目前没有上架 Chrome 应用商店，不赠送 API 额度，也没有开发者运营的服务器。

点击查看演示和教学视频（小白友好）：[https://www.bilibili.com/video/BV1dnuq6dEak/](https://www.bilibili.com/video/BV1dnuq6dEak/)

![YouTube Digest 双语演示](YouTube%20Digest%20demo%20bilingual.png)

## v1.3.3 更新

- 降低 YouTube 页面上的空闲开销：Note 按钮的重试循环原先会被每一次 DOM 变动重新挂起，导致重试预算被不断重置，原本「3 秒后放弃」的兜底变成在持续变动的页面上永久以 10 次/秒 轮询播放器。
- 工具栏按钮的重排加了 400ms 最小间隔；按钮还正常挂在可见容器里时只读一次几何尺寸就返回，不再对每个候选容器做 `querySelectorAll` + `getComputedStyle` 全扫。
- Note 按钮的 hover 状态只在真正变化时才写样式。
- B 站 1 秒一次的站内跳转轮询，在没有需要修复的东西时不再查询 DOM，非视频页完全不做事。
- 同一 B 站播放页、播放中的实测：本扩展约占 0.3 个百分点的脚本时间和 1.7 个百分点的主线程任务时间。

## v1.3.2 更新

- 修复装上扩展后 B 站播放页「UP 主头像 / 关注数 / 右侧推荐封面」加载不出来的问题。原因：Digest 按钮被插进了 B 站播放页工具栏（`.video-toolbar-left-main` / `#arc_toolbar_report`）。那些容器是 Vue 接管 SSR 结果的受控节点，插入外来子节点后它的 patch 对不上节点列表，整块区域就渲染失败，只有开着扩展时才会出现，关掉即恢复。
- B 站按钮改为挂在 `<body>` 上的独立浮层（`position: fixed`，右下角），完全不进入 B 站自己的 DOM 树；全屏播放时自动隐藏，不再盖住视频。
- 注入时机改为页面 `load` 之后延后 700ms，避开 B 站 hydration 窗口期。
- 新增回归测试，锁定「B 站按钮不得插入 B 站容器」这条约束。

## v1.3.1 更新

- 修复 YouTube 字幕只拿到一两句的问题：YouTube 现在要求 `/api/timedtext` 带 proof-of-origin token（`pot`），没有 pot 时接口返回 **HTTP 200 但响应体为空**，旧代码只看状态码，误判成"有字幕但内容为空"，最后掉进 30 秒 Whisper 兜底。
- 新增 `caption-pot-hook.js`（MAIN world，`document_start`）：挂钩播放器自己的字幕请求，记下带 pot 的签名 URL；内容脚本改写 `lang`/`fmt` 后直接取整条字幕轨。签名不含 lang/tlang，所以可以安全地把译文轨切回原轨。
- 字幕改为按 json3 解析，保留完整时间轴（本机实测 15 分 38 秒视频拿到 605 段，0:00 → 15:36）。
- 面板缓存加版本号（`DIGEST_CACHE_VERSION`），旧版本存下的残缺字幕会自动失效并重新抓取，不用手动清缓存。
- 为了取字幕临时打开 CC 后会自动关掉，不改变你的播放器设置。

## v1.3.0 更新

- 侧边栏现在支持 B 站：B 站播放页会注入 Digest 按钮，点开即用免费原生字幕，不消耗 Supadata 额度。
- 修复"点多少次图标都提示 `Extension has not been invoked`"：清单补上 `activeTab` 权限，并改回由 `action.onClicked` 打开面板（`openPanelOnActionClick` 会吞掉点击，导致授权永远不生效）。
- 面板提示需要唤醒时，点一次图标或按 `Alt+Shift+9` 会自动继续转录，不用再点第二次。
- 再次录音时自动清理上一次残留的音频流，避免出现 `Cannot capture a tab with an active stream`。
- Whisper 返回空文本时改为明确提示"视频未播放或已静音"，不再显示容易误解的 `returned 200`。

## v1.2.0 更新

- 搜索字幕中的单词或短语，并依次查看所有匹配位置。
- 在 Transcript、Overview 和 Notes 中共用 Original、中文和双语设置。新视频默认保持 Original，不会自动消耗翻译 token。
- 只翻译当前可见的 Overview 和 Notes 内容，并通过小批次渐进显示和缓存结果。
- 选中字幕后，可以直接讲解内容或保存带时间戳的笔记。
- 页面跳转后保留字幕阅读位置，并在离开 YouTube 视频页面时自动关闭侧边栏。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/zarazhangrui/youtube-digest

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。
2. 打开下方 Supadata 和 DeepSeek 官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个带字幕的 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 YouTube Digest 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 打开 [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest)。
2. 点击 **Code**，再选择 **Download ZIP**。
3. 选择一个长期保留的文件夹，并把项目解压到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。你也可以使用其他文件夹。
4. 在 Chrome 地址栏打开 `chrome://extensions`。
5. 打开右上角的“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
8. 如果需要，可以在 Chrome 扩展菜单中固定 YouTube Digest。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 YouTube Digest 并点击“重新加载”，然后刷新已经打开的 YouTube 页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API Key

YouTube Digest 需要你在自己的服务账号中准备两个 Key：

1. **Supadata API Key**，用于获取 YouTube 字幕。
2. **DeepSeek API Key**，用于生成概览、讲解内容、翻译和自动润色笔记。

### 获取 Supadata API Key

1. 打开 Supadata 官方[注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的新手引导。
3. Supadata 会在新手引导过程中自动生成 API Key。
4. 之后可以随时打开 [Supadata 控制台](https://dash.supadata.ai/)查找或管理 Key。
5. 复制 Key，并粘贴到 YouTube Digest 设置中的 **Supadata API key**。

如果页面流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 DeepSeek API Key

1. 打开 DeepSeek 官方 [API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 按照提示登录，或创建 DeepSeek 开放平台账号。
3. 点击 **Create new API key**，填写容易识别的名称，例如 `YouTube Digest`，然后创建 Key。
4. 立即复制 Key。完整 Key 可能只会显示一次。
5. 把 Key 粘贴到 YouTube Digest 设置中的 **DeepSeek API key**。
6. 如果 DeepSeek 提示余额不足，请在 DeepSeek 开放平台账号中充值后再试。

当前账号和接口说明请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 YouTube Digest 卡片中打开扩展选项。Key 只能粘贴到这些设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

发布版本只支持 DeepSeek V4 Flash：

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

YouTube Digest 会让所有 DeepSeek 请求使用非思考模式，以获得更快、更稳定的交互。设置中的接口地址和模型固定，只需要填写 DeepSeek API Key。如果想使用其他服务或模型，请在设置中复制安全的自定义 prompt，让编程 Agent 修改你自己的本地副本。不要把任何 API Key 放进 prompt 或对话。

API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 使用 YouTube Digest

1. 打开一个有字幕的普通 YouTube 视频页面。
2. 点击 YouTube Digest 扩展图标，打开侧边栏。
3. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。
4. 打开 **Overview**，查看 AI 生成的章节和重点引用。
5. 选中字幕，获取 AI 内容讲解。
6. 从播放器或重点引用中保存笔记，之后可以在 **Notes** 中查看。

## 当前支持范围

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面。
- Supadata 能够返回的原生字幕。YouTube Digest 会优先请求英文字幕，也可能显示其他可用的原生语言。
- 原文、简体中文和双语对照字幕。
- AI 概览、选中文本讲解、翻译和自动润色笔记。
- 本地笔记，以及最近字幕、概览和翻译的本地缓存。
- 发布版本的所有 AI 功能都使用 DeepSeek V4 Flash。其他服务需要修改本地代码，不属于发布版本的支持范围。

Shorts、直播、私密视频、受访问限制的视频，以及没有原生字幕的视频可能无法使用。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

## 字幕来源路由（三种场景）

YouTube Digest 现在按可用性路由字幕获取，不再每个视频都盲目消耗一次 Supadata：

1. **平台原生字幕（免费，不耗 Supadata）**：扩展会先在当前页面探测原生字幕，例如 YouTube 的 `captionTracks`、B 站免费字幕接口、或通用 HTML5 `video.textTracks`。找到就直接用于摘要，**0 消耗** Supadata。

2. **无原生字幕 → 本地 Whisper 转录（可选）**：如果没有平台字幕、且你在设置里开启了**本地 Whisper**，扩展会通过 `chrome.tabCapture` 捕获当前标签页的音频（对跨域播放器有效），发送到本地 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 服务（`whisper/whisper_server.py`）转写。转录在你的电脑上进行，不经过 Supadata。

3. **手动 Supadata 兜底**：Supadata 不再被自动调用。当既没有原生字幕、也没启用 Whisper 兜底时，侧边栏会显示手动**使用 Supadata（兜底）**按钮，只有你选择时才会消耗额度。

Supadata 仍然可用，但现在是可选路径，而不是默认路径。

### 运行本地 Whisper 服务（可选）

```bash
pip install -r whisper/requirements.txt
python whisper/whisper_server.py --model small --port 8000
```

然后在设置中开启**本地 Whisper**，保持默认服务地址 `http://127.0.0.1:8000`。和以前一样的限制：DRM / 加密流、以及尚未开始播放的视频无法捕获音频，所以该兜底只对可播放、未加密的视频有效。

两个实操注意点：

- B 站字幕接口只对**已登录**的会话返回字幕轨道。未登录时探测结果为空，流程会落到 Whisper 兜底。
- Chrome 只允许在"扩展已在该标签页被唤醒"之后捕获标签页音频，而**唤醒只认工具栏图标或快捷键**：页面里的 Digest 按钮能打开面板，但它不算授权。没唤醒时 Chrome 会返回 `Extension has not been invoked for the current page`，面板会提示你点一次图标，点完会自动接着转录，不用再点第二次。
- 也可以用快捷键 **Alt+Shift+9** 代替点图标：效果相同（同样会授予当前标签页的采集授权），适合图标被折叠进"扩展程序"菜单时使用。注意**刷新页面会撤销授权**，刷新后需要再按一次。
- 授权来自 manifest 里的 `activeTab` 权限加上一次真实调用；缺少 `activeTab` 时无论点多少次图标都会失败，所以不要把它从 `permissions` 里删掉。

## Supadata 免费额度和请求成本

截至 2026 年 8 月 9 日，[Supadata 价格页面](https://supadata.ai/pricing)显示免费版每月提供 **100 credits**，不需要信用卡，未使用的额度不会结转。价格可能变化，使用前请查看最新页面。

[Supadata 字幕接口文档](https://docs.supadata.ai/get-transcript)说明了不同模式的计费方式：

- 获取一次原生字幕消耗 **1 credit**，与视频时长无关。
- AI 生成字幕每分钟消耗 **2 credits**。YouTube Digest 不会使用这条路径，因为它强制使用 `mode=native`。
- 如果没有可用原生字幕并返回 HTTP `206`，仍会消耗 **1 credit**。

按照当前只获取原生字幕的方式，如果每次请求都成功，免费版每月大约可以查询 100 个视频。重试和没有字幕的查询也会消耗额度，所以实际成功数量可能更少。

DeepSeek 的额度与 Supadata 分开计算。YouTube Digest 不收款，也不转售 API 服务。建议为两个账号设置消费上限并定期查看用量。

## DeepSeek V4 Flash 价格

截至 2026 年 8 月 27 日，DeepSeek 官方[价格页面](https://api-docs.deepseek.com/quick_start/pricing/)列出的每 100 万 token 美元价格如下：

| Token 类型 | 非高峰 | 高峰 |
| --- | ---: | ---: |
| 缓存命中输入 | $0.007 | $0.014 |
| 缓存未命中输入 | $0.22 | $0.44 |
| 输出 | $0.66 | $1.32 |

高峰时段为周一至周五 UTC 01:00–04:00 和 06:00–10:00，其他时间使用非高峰价格。

一个实测的 20 分钟英文视频使用约 **32,600 个输入 token**，并在 43 个小批次中产生约 **3,500 到 4,500 个输出 token**。按当前价格，完整翻译该视频的费用约为：

- **非高峰：$0.003 到 $0.010 USD**。
- **高峰：$0.005 到 $0.020 USD**。

低值假设大部分重复输入命中 DeepSeek 缓存，高值假设输入未命中缓存。翻译按需执行并复用缓存，只翻译部分视频时费用会更低。使用前请查看官方页面确认最新价格。

## 用编程 Agent 改造成自己的版本

这是一个个人 Remix 项目，不接受上游 Issue 或 Pull Request。如果功能出错，或者你想增加新功能，请下载或 Fork 自己的副本，再让你的编程 Agent 帮你修复、改造和个性化。

YouTube Digest 使用原生 HTML、CSS 和 JavaScript，没有构建步骤，很适合用编程 Agent 做个人项目。你可以尝试：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 增加生词本，保存单词、原句、解释和视频时间戳。
- 把笔记和生词导出到 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 YouTube Digest 项目文件夹。然后打开 YouTube Digest 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

YouTube Digest 会直接从扩展向服务商发送请求：

1. 把标准化的 YouTube 视频地址发送给 Supadata，用于获取原生字幕。
2. 当你使用 AI 功能时，把字幕和相关视频信息发送给 DeepSeek。
3. 翻译或讲解等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
4. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

YouTube Digest 没有账号系统、广告、分析统计或行为追踪。Supadata 和 DeepSeek 仍会按照各自的条款和隐私政策处理数据。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 YouTube Digest，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 `https://www.youtube.com/watch?...` 页面。
- 在 `chrome://extensions` 中确认 YouTube Digest 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新 YouTube 页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### YouTube Digest 提示需要设置

- 打开 **Settings**，保存 DeepSeek Key。Supadata Key 只有在你想使用手动 Supadata 兜底时才需要；使用平台原生字幕或开启本地 Whisper 兜底时，Supadata 是可选的。
- 发布版本固定使用 DeepSeek V4 Flash，没有需要填写的 Base URL 或 Model 字段。
- 如果设置提示旧的自定义服务已移除，请重新填写 DeepSeek Key。旧 AI Key 已安全清除，避免被错误用于 DeepSeek。

### 找不到字幕

- 确认视频是公开的，并且有原生字幕。
- 如果你没有在设置中开启**本地 Whisper**，扩展不会自行转录音频。开启它（并启动 `whisper/whisper_server.py`）即可获得音频转录兜底。
- 使用手动 Supadata 兜底时，请注意：没有字幕的查询和手动重试也可能消耗额度。

缺少原生字幕时，扩展不会自动消耗 Supadata 额度；它会使用平台字幕、你的本地 Whisper 兜底，或先询问你再决定是否进行付费查询。

### AI 请求失败

- `401` 或 `403` 通常表示 DeepSeek Key 或账号权限有问题。
- `429` 通常表示达到了 DeepSeek 服务限速或消费上限。
- 确认 Key 来自上方链接的 DeepSeek 开放平台账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 YouTube 视频。自动检查通过，不代表真实服务请求和 YouTube 交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
