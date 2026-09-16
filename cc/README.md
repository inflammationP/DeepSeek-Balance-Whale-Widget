# 小鲸鱼桌宠 · Claude Code 版

把原版挂件搬到 **Claude Code** 上，**不需要 DSH**。

## 它是怎么做到「原封不动」的

原版挂件其实是两半：

| 文件 | 是什么 | 这里怎么处理 |
|---|---|---|
| `assets/whale-widget.js` | 前端本体：立绘、泡泡、拖拽、音效、菜单（650KB，14000 行） | **一行没改** |
| `lib/index.js` | 宿主插件：注册 21 条 HTTP 路由、查余额、记账 | **一行没改** |

`lib/index.js` 只跟 DSH 的 `ctx` 要 7 样东西（注册路由、插页面、读写凭据、会话事件、信任栅栏、effect）。所以这里写了个 **DSH 运行时替身** `server.mjs`，把这 7 样用真实现填上，插件就照常跑起来了 —— 立绘、泡泡编辑器、音效组、角色管理、菜单，全部原样可用。

唯一需要"翻译"的是**会话事件**：DSH 有自己的轮次事件总线，Claude Code 没有。所以 `server.mjs` 里有个 transcript 跟随器，读 `~/.claude/projects/**/*.jsonl` 合成同形状的事件，「每轮对话消耗」泡泡因此照常工作。

## 跑起来

```cmd
cc\run.cmd            起服务 + 开桌宠窗口
cc\run.cmd web        只起服务，浏览器打开（Electron 全屏下菜单本来就能点；
                      这个是给你「不想开桌宠、只想配一下」时用的）
cc\run.cmd status     看看现在什么状态
cc\run.cmd stop       关掉服务和窗口
cc\run.cmd config     打开配置目录
cc\run.cmd --scale 1.2    调鲸鱼大小（不改 UI，见下）
```

### 调鲸鱼大小

两条路，随你：

1. **挂件菜单里的小滑块** —— 右键鲸鱼 → 菜单 → 大小（原版功能，0.6~2.5 步进 0.1），拖完即生效并存盘
2. **命令行写配置**（不想点菜单时用）：

```cmd
cc\run.cmd --scale 1.2
cc\run.cmd stop && cc\run.cmd      ← 挂件只在启动时读一次配置，要重开才看得到
```

当前全屏视口下的对应像素（`--dshwv-base = clamp(122, min(250, min(100vw,100vh)×0.28) × scale, 625)`）：

| scale | 0.6 | 0.8 | **1.0**（默认） | 1.2 | 1.5 | 2.0 | 2.5 |
|---|---|---|---|---|---|---|---|
| 鲸鱼 | 150px | 200px | **250px** | 300px | 375px | 500px | 625px |

配置存在 `~/.whale-cc/.dshw-size.json` 的 `scale` 字段。⚠ `whale.py --scale` 是**读出来合并再写回**的 ——
那个文件还存着音量/音效组/吸附/泡泡开关等设置，整个覆盖会把它们清掉。

需要 **Node.js**（起服务）+ **Python 3**（开窗），两个都是本来就在机器上的。

### 三种形态（按优先级自动挑）

| | 需要 | 窗口 | 底色 | 挡鼠标 |
|---|---|---|---|---|
| **① Electron**（推荐） | `cd cc/electron && npm i` | 全屏透明层 | **没有底** | 只在鲸鱼上接管，其余**点穿** |
| ② pywebview | `pip install pywebview` | 右下角 720×720 | 没有底 | ⚠ **整窗点穿，鲸鱼也点不到** |
| ③ Edge app | 无 | 右下角 300×300 | 白方块 | 会挡住底下 |

**只有 ① 能同时做到「透明」和「可点击」。** 装它：

```cmd
cd cc\electron
npm install
```

国内网络拉不下 Electron 二进制时用镜像：

```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules\electron\install.js
```

### ⚠ 环境里有 ELECTRON_RUN_AS_NODE 会静默坏事

若该变量被设成 `1`，`electron.exe` 会**退化成纯 Node 跑**：`require('electron')` 拿不到
`app`/`BrowserWindow`（全是 undefined），`electron --version` 报的是 **Node 版本号**而不是
Electron 版本。`whale.py` 里已显式清掉它，但你自己手敲命令时要注意。

## 为什么必须用 Electron（这一节是踩坑重灾区）

**pywebview + WebView2 做不到「透明 + 可点击」两者兼得**，这是硬限制，不是参数没调对：

> Win32 的分层窗口命中检测**只认窗体自己那一层**，而 WebView2 是子窗口、画在另一层。
> 窗体表面整片都是键色 → 系统判定「全透明」→ **整个窗口都点穿，连鲸鱼都点不到**。
> 实测：`WindowFromPoint` 在鲸鱼身上返回的是底下的编辑器窗口。

于是只有两个坏选项：

| 做法 | 视觉 | 交互 |
|---|---|---|
| 抠色键 | 透明 ✓ | **全点穿，鲸鱼也点不到** ✗ |
| 不抠色键 | 方块底 ✗ | 正常 ✓ |

（过程中还踩了两次更糟的：只做 WebView2 那半透 → **白方块**；
只做窗体那半 → **整块实心色糊满全屏**。所以窗口**故意不做全屏**，
失败最多是个方块而不是盖住整屏。）

**Electron 的做法**：窗口 `transparent: true` 拿到真透明，再用
`setIgnoreMouseEvents(true)` 让整窗点穿 —— 但它同时把光标位置给到页面，
页面判断光标是否落在鲸鱼/面板上，是就通知主进程关掉点穿。两边都拿到。

⚠ 其中最关键的一条：**光标位置必须由主进程 `screen.getCursorScreenPoint()` 取**。
窗口点穿时，页面自己的 `mousemove` 坐标是**错的**（实测光标在屏幕右下角，
页面收到的是 `(796,412)`）—— 判定逻辑再准，喂错坐标也没用。这个坑让前两轮验证全部误判。

透明不灵时的退路：`cc\run.cmd --opaque`（白底小窗口）。

## 数据从哪来

### 余额

直接问 DeepSeek：`GET https://api.deepseek.com/user/balance`。密钥按这个顺序找：

1. `~/.whale-cc/credentials.json`（在挂件菜单里填的 key 会存这）
2. 环境变量同名变量
3. **Claude Code 自己的 key** —— 从 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` 读

> ⚠ 第 3 条有**硬性守卫**：只有当 `ANTHROPIC_BASE_URL` 确实指向 `deepseek.com` 时才会用。
> 否则（比如你的 CC 用的是真 Anthropic key）把 token 发去 api.deepseek.com 就是凭据外泄 —— 这种情况一律拒绝。
>
> 凭据文件按 `0600` 权限写入，且**只落盘不上报**。

### 每轮消耗 / 今日已用

- **每轮消耗**：跟随 `~/.claude/projects/**/*.jsonl`，按 `message.id` 去重后换算金额
- **今日已用**：走挂件原本的账本（余额差 + 会话事件），零改动

## 两个必须知道的口径

**① 按 `message.id` 去重，不能按行求和。** Claude Code 会把**一次 API 响应**按 content block 拆成多条 `assistant` 行，每行携带逐字段完全相同的 `usage`。实测某个会话 1282 行只对应 501 条真实请求 —— 直接求和会**多算 2.7 倍**。

（也别用 `requestId`：实测同一文件里它只有 1 个值，完全没法用。）

**② transcript 从末尾开始跟，不回放历史。** 否则一启动就把几百条旧轮次当成新消耗，疯狂弹泡泡。

## 文件

```
cc/
├── server.mjs        DSH 运行时替身 + HTTP 服务 + transcript 跟随器
├── whale.py          启动器：拉起服务，自动挑开窗方式
├── run.cmd           一键入口（纯 ASCII —— cmd.exe 按 OEM 代码页读 .cmd，中文会烂）
├── electron/
│   ├── main.js       主进程：全屏透明窗口 + 光标轮询 + 点穿开关
│   ├── preload.js    命中判定：鲸鱼逐像素 alpha（复刻挂件 isWhaleHit）+ UI 面板
│   └── package.json  npm install 装 Electron 用
└── README.md         本文件
```

配置与账本在 `~/.whale-cc/`，与 DSH 的 `~/.dsh` 完全隔离。会话日志只读 `~/.claude/projects`，**从不写入**。

## 踩过的坑（改代码前先看）

| 现象 | 原因 |
|---|---|
| 窗口全白，什么都没渲染 | 挂件开头有「页面自检」：只在 `#root` 里找到输入框时才挂载，否则**静默退出**。`server.mjs` 里那个 0 尺寸替身 `contenteditable` 就是喂它的，**别删** |
| 白屏（第二种） | 挂件只在 init 和 `resize` 时算位置。Edge app 窗口创建期间视口还是默认值，等窗口缩小时它已经定位到窗口外了。页面里补发 `resize` 的那段就是治这个，**别删** |
| `TOPMOST` 死活是 False | `ctypes.windll.user32` 不声明 `argtypes` 时按 `c_int` 传参，**64 位 HWND 被截断**，`SetWindowPos` 静默失败。`whale.py` 的 `_user32()` 就是干这个的 |
| 置顶又掉了 | 改 `GWL_STYLE` 剥标题栏会让 Chromium 重建窗口、连带清掉 `WS_EX_TOPMOST`。所以**只调 `SetWindowPos`**，别碰样式 |
| `run.cmd` 里中文变乱码 | cmd.exe 按 OEM 代码页读 `.cmd`。所以 `run.cmd` 全 ASCII，中文全在 `whale.py` 里输出 |
| 白色方块底 / 整块实心色 | pywebview 那条路的两半透明没凑齐。直接用 Electron（见上） |
| 鲸鱼点不到、什么都点穿 | 要么是 pywebview 的色键（整窗点穿），要么是 Electron 里光标坐标喂错了 —— 后者必须用主进程 `screen.getCursorScreenPoint()`，别信页面的 `mousemove` |
| 拖拽拖到一半断掉 | 光标快速移动时短暂离开鲸鱼轮廓 → 切回点穿。`preload.js` 用 `dragging` 标志在按下期间强制保持可交互 |
| **鼠标一靠近鲸鱼，你在用的窗口就失活被压下去** | 窗口默认是「可激活」的 —— 光标进鲸鱼那一刻它从「点穿」切成「接收鼠标」，系统就把它当活动窗口。解法是 `focusable: false`（Windows 上的 `WS_EX_NOACTIVATE`）：**能点能拖，但永不抢焦点**。注意它**不影响鼠标事件**，只是不要键盘焦点 |
| 点进输入框打不了字 | 上一条的代价。`preload.js` 在 `mousedown` 落在 `input/textarea/[contenteditable]` 上时发 `whale:focus` 临时开一下，失焦再还回去 |
| 鲸鱼拖不出去 / 只能在窗口内拖 | 只有 Electron 是全屏窗口，才能拖到任意位置。pywebview / Edge 都是小窗口，天然受限 |
| 改了 `--scale` 没反应 | 文件名必须是 **`.dshw-size.json`**（`dshw-` 前缀）。它和 `.dshwv-usage.json` 那批**不是**同一前缀，很容易写成 `.dshwv-size.json`（多一个 v）或 `.dsh-size.json`（少一个 w）—— 两种写法都不报错，静默退回内置默认值 1.5 |

## 想动原版挂件的话

`assets/whale-widget.js` 改了直接生效 —— **硬刷新页面**（关掉窗口重开）。`lib/index.js` 改了要**重启服务**（`run.cmd stop` 再 `run.cmd`）。

顺带一提：仓库根目录那份 `lib/index.js` 还带了一个「Claude Code 本地会话」厂商模板（在小鲸鱼记账 → 模型里选），挂上它就能在挂件里看到本地会话的今日/累计 token 与折算金额。
