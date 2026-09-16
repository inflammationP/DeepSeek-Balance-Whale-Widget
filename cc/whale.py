# -*- coding: utf-8 -*-
"""
小鲸鱼桌宠 · Claude Code 版 —— 启动器

它只负责「把服务拉起来，再把页面用一个无边框置顶窗口显示出来」。
页面内容（鲸鱼立绘 / 泡泡 / 拖拽 / 音效 / 菜单）全部来自原版 assets/whale-widget.js，一行没改；
服务端是 cc/server.mjs（DSH 运行时替身），里面跑的也是原版 lib/index.js。

命令：
  python cc/whale.py            起服务 + 开桌宠窗口
  python cc/whale.py web        只起服务，用浏览器打开（配泡泡/音效/模型用这个，窗口太小不够点）
  python cc/whale.py stop       关掉服务和桌宠窗口
  python cc/whale.py status     看看现在什么状态
  python cc/whale.py config     打开配置文件目录

开窗两种方式，自动挑：
  ① pywebview  真·透明：鲸鱼浮在桌面上，没有窗口底、没有标题栏。装了就用。
               透明要两半凑齐（WebView2 不画底 + 窗体键色），少一半就是个方块 ——
               详见 KEY_RGB / make_form_transparent 上面的注释。
  ② Edge app   零安装兜底（Win11 自带 Edge）。浏览器做不到透明，会有白底方块；
               已用 Win32 加了置顶，不会藏到终端后面。
"""

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.mjs")
PORT = int(os.environ.get("WHALE_CC_PORT", "3081"))
URL = "http://127.0.0.1:%d/" % PORT
TITLE = "小鲸鱼"
LOG = os.path.join(tempfile.gettempdir(), "whale-cc.log")
WHALE_HOME = os.environ.get("WHALE_CC_HOME") or os.path.join(os.path.expanduser("~"), ".whale-cc")
SCALE_FILE = os.path.join(WHALE_HOME, ".dshw-size.json")

# 缩放范围与挂件前端一致（whale-widget.js 的 MIN_SCALE / MAX_SCALE）
MIN_SCALE, MAX_SCALE = 0.6, 2.5


def set_scale(v):
    """
    把缩放写进挂件的配置文件，下次启动生效（不用去点菜单里的滑块）。

    ⚠ 必须**读出来合并**再写回：这个文件是挂件自己维护的，除了 scale 还存着
    音量/音效组/吸附/泡泡开关等一堆设置，整个覆盖会把它们清掉。
    """
    v = max(MIN_SCALE, min(MAX_SCALE, float(v)))
    cfg = {}
    try:
        with open(SCALE_FILE, encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception:
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    cfg["scale"] = v
    os.makedirs(WHALE_HOME, exist_ok=True)
    with open(SCALE_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)
    return v


def say(msg):
    try:
        print("[小鲸鱼] " + msg, flush=True)
    except Exception:
        print("[whale] " + msg.encode("ascii", "replace").decode("ascii"), flush=True)


def server_alive(timeout=2.0):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % PORT, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def ensure_server(wait=20):
    if server_alive():
        say("服务已在跑 http://127.0.0.1:%d/" % PORT)
        return True
    node = shutil.which("node")
    if not node:
        say("找不到 node —— 请先装 Node.js（https://nodejs.org）")
        return False
    say("启动服务…")
    env = dict(os.environ, WHALE_CC_PORT=str(PORT))
    flags = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
    with open(LOG, "w", encoding="utf-8") as lf:
        subprocess.Popen([node, SERVER], stdout=lf, stderr=lf, env=env,
                         creationflags=flags, close_fds=True)
    for _ in range(wait * 2):
        time.sleep(0.5)
        if server_alive():
            say("服务已就绪 http://127.0.0.1:%d/" % PORT)
            return True
    say("服务起不来，看日志：" + LOG)
    return False


def stop_server():
    """只杀监听本端口的那个进程，不动别的程序。"""
    killed = 0
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace").stdout
        for line in out.splitlines():
            if "LISTENING" in line and (":%d " % PORT) in line:
                pid = line.split()[-1]
                if pid.isdigit():
                    subprocess.run(["taskkill", "/f", "/pid", pid],
                                   capture_output=True)
                    killed += 1
    except Exception as e:
        say("关服务出错：%s" % e)
    return killed


def kill_sibling_launchers():
    """
    杀掉其它正在跑的 whale.py（不含自己）。

    pywebview 的窗口是 python 进程自己开的，不像 Edge 那样能靠标题找到再 WM_CLOSE，
    光关服务它不会走 —— 所以 stop 时得把持有窗口的那个启动器一起收掉。
    """
    me = os.getpid()
    try:
        ps = (r"Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
              r"Where-Object {$_.CommandLine -like '*whale.py*'} | "
              r"ForEach-Object { $_.ProcessId }")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return 0
    killed = 0
    for tok in out.split():
        if tok.strip().isdigit():
            pid = int(tok)
            if pid != me:
                subprocess.run(["taskkill", "/f", "/pid", str(pid)], capture_output=True)
                killed += 1
    return killed


def close_window():
    """按标题关掉桌宠窗口，不碰你开的其它浏览器窗口。"""
    try:
        u = _user32()
        from ctypes import wintypes as wt
        u.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
        u.FindWindowW.restype = wt.HWND
        u.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
        u.PostMessageW.restype = wt.BOOL
        hwnd = u.FindWindowW(None, TITLE)
        if hwnd:
            u.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
            return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Win32 置顶（Edge 兜底路径用）
# ---------------------------------------------------------------------------
def _user32():
    """
    取 user32 并**声明好函数签名**。

    ⚠ 签名必须显式声明：ctypes 对没声明 argtypes 的函数按 c_int 传参，
    64 位下 HWND 会被截断成 32 位，SetWindowPos 于是拿着错句柄静默失败 ——
    表现为「函数返回成功找到了窗口，但那个窗口的 TOPMOST 死活是 False」（已踩过）。
    """
    u = ctypes.windll.user32
    if getattr(u, "_whale_typed", False):
        return u
    from ctypes import wintypes as wt
    # 注意：EnumWindows 不声明 argtypes —— 它要收一个 WINFUNCTYPE 回调，
    # 声明成 c_void_p 反而传不进去。回调参数由 WINFUNCTYPE 自己保证是 64 位，够用。
    u.IsWindowVisible.argtypes = [wt.HWND]
    u.IsWindowVisible.restype = wt.BOOL
    u.GetWindowTextLengthW.argtypes = [wt.HWND]
    u.GetWindowTextLengthW.restype = ctypes.c_int
    u.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.restype = ctypes.c_int
    u.GetWindowRect.argtypes = [wt.HWND, ctypes.c_void_p]
    u.GetWindowRect.restype = wt.BOOL
    u.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
    u.GetWindowLongW.restype = ctypes.c_long
    u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    u.SetWindowPos.restype = wt.BOOL
    u.GetSystemMetrics.argtypes = [ctypes.c_int]
    u.GetSystemMetrics.restype = ctypes.c_int
    u.SystemParametersInfoW.argtypes = [ctypes.c_uint, ctypes.c_uint,
                                        ctypes.c_void_p, ctypes.c_uint]
    u.SystemParametersInfoW.restype = wt.BOOL
    u.SetProcessDPIAware.restype = wt.BOOL
    u._whale_typed = True
    return u


def set_topmost_by_title(title):
    """
    把标题匹配的窗口设为 HWND_TOPMOST。

    ⚠ 这里**只**调 SetWindowPos，绝不去改 GWL_STYLE 剥标题栏：
    Chromium 的窗口在样式被改动后会重建自己，顺手把 WS_EX_TOPMOST 一起清掉 ——
    实测加了剥边框那步之后 TOPMOST 恒为 False，窗口被终端/编辑器盖住（已踩过）。

    带 SWP_NOACTIVATE，所以可以放心反复调用，不会把焦点从你正在打字的地方抢走。
    """
    try:
        u = _user32()
    except Exception:
        return 0
    HWND_TOPMOST = -1
    # NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW
    FLAGS = 0x0001 | 0x0002 | 0x0010 | 0x0040
    hits = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        # 只认「可见 + 有面积」的窗口：Chromium 会建一堆同名但不可见的辅助/宿主窗口，
        # 不过滤的话会瞄错对象 —— 置顶设到看不见的窗口上，屏幕上那个纹丝不动。
        if not u.IsWindowVisible(hwnd):
            return True
        n = u.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            if title in buf.value:
                hits.append(hwnd)
        return True

    u.EnumWindows(cb, 0)
    for hwnd in hits:
        u.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, FLAGS)
    return len(hits)


def topmost_watchdog(title, stop):
    """
    定期补一次置顶，直到窗口关闭。

    无条件重设而不是「先查再补」：窗口还没被创建出来时枚举结果为空，
    「查」会误判成「已经是置顶了」从而什么都不做（第一版就栽在这）。
    SetWindowPos 本身就够便宜也幂等，带上 SWP_NOACTIVATE 反复调没有副作用。
    """
    while not stop.is_set():
        try:
            set_topmost_by_title(title)
        except Exception:
            pass
        stop.wait(3)


# ---------------------------------------------------------------------------
# 真·透明（桌宠）
# ---------------------------------------------------------------------------
# 透明是**两半**，缺一不可 —— 只做一半的结果都是个方块：
#
#   ① WebView2 那半：transparent=True → pywebview 把 DefaultBackgroundColor 设成
#      Transparent，让 WebView2 自己不画底色。**只做这半 = 白方块**，
#      因为底下 WinForms 窗体的白底会透出来。
#   ② 窗体那半：给 Form 设 TransparencyKey（下面 make_form_transparent）。
#      **只做这半 = 整块实心色**，因为 WebView2 会把页面底色画满、盖住窗体的抠色。
#
# 另外：光靠 SetWindowLong(WS_EX_LAYERED)+LWA_COLORKEY 去抠是**没用的** ——
# 那作用于窗体自己的绘制面，管不到 WebView2 子窗口画的内容（实测全屏纯黑）。
# 必须走 WinForms 的 TransparencyKey，它会把子控件一起算进去。
#
# ⚠ KEY_RGB 必须和界面里绝不会出现的颜色一致：用纯白/纯黑会把泡泡卡片的底色一起抠穿。
KEY_RGB = (255, 0, 255)  # 洋红，Windows 桌宠的传统键色


def make_form_transparent(form):
    """
    给 pywebview 的 WinForms 窗体设键色 —— 补上 pywebview 漏掉的那一半透明。

    pywebview 只做了 WebView2 的 DefaultBackgroundColor，窗体自己还画着白底，
    所以单靠 transparent=True 得到的是「白方块」。
    设 TransparencyKey 后，窗体上该颜色的像素变透明**且自动点穿**。
    """
    from System.Drawing import Color
    key = Color.FromArgb(KEY_RGB[0], KEY_RGB[1], KEY_RGB[2])
    form.BackColor = key
    form.TransparencyKey = key


def _apply_form_key(win):
    """webview.start 的回调：GUI 起来后再动窗体（太早拿不到 native）"""
    time.sleep(1.2)
    try:
        form = win.native
    except Exception as e:
        say("⚠ 拿不到原生窗体，透明可能不生效：%s" % e)
        return
    if form is None:
        say("⚠ 原生窗体为空，透明可能不生效")
        return
    try:
        # WinForms 控件只能从 UI 线程碰，否则抛跨线程异常 —— 用 Invoke 绕回 UI 线程
        from System import Action
        form.Invoke(Action(lambda: make_form_transparent(form)))
        say("窗体键色已设 RGB%s（该色处透明且点穿）" % (KEY_RGB,))
    except Exception as e:
        say("⚠ 窗体键色设置失败：%s" % e)
        try:
            make_form_transparent(form)
            say("窗体键色已设（直调）")
        except Exception as e2:
            say("⚠ 直调也失败：%s —— 会显示为方块底" % e2)


def pet_keeper(title, stop):
    """
    置顶看门狗：定期补一次置顶，直到窗口关闭。

    窗口可能被 WebView2 重建，所以每轮都补，不能只做一次。
    无条件重设而不是「先查再补」：窗口还没创建出来时枚举结果为空，
    「查」会误判成「已经是置顶了」从而什么都不做（第一版就栽在这）。
    """
    while not stop.is_set():
        try:
            set_topmost_by_title(title)
        except Exception:
            pass
        stop.wait(3)


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def geom(size, margin):
    """
    算窗口位置：贴屏幕工作区（去掉任务栏）的右下角。

    ⚠ 全程用**逻辑像素**：Edge 的 --window-size/--window-position 和 GetSystemMetrics
    都是逻辑值，而本进程没声明 DPI 感知 → 系统会给它逻辑坐标。两者一致，不要混入物理像素，
    否则 150% 缩放下会算到屏幕外（实测 2560x1600 @150% 时物理/逻辑差 1.5 倍）。
    """
    try:
        u = _user32()
        sw, sh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)  # SM_CXSCREEN / SM_CYSCREEN
        r = _RECT()
        if u.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0):  # SPI_GETWORKAREA
            sw, sh = r.right, r.bottom
    except Exception:
        sw, sh = 1920, 1080
    return sw - size - margin, sh - size - margin, size, size


def find_edge():
    for p in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if os.path.exists(p):
            return p
    return None


def have_pywebview():
    try:
        import webview  # noqa: F401
        return True
    except Exception:
        return False


def electron_dir():
    return os.path.join(HERE, "electron")


def have_electron():
    """cc/electron 里装没装 electron（npm install 过没有）"""
    exe = os.path.join(electron_dir(), "node_modules", "electron", "dist", "electron.exe")
    return os.path.isfile(exe)


def open_electron():
    """
    首选路径：Electron 全屏透明层。

    它能同时做到「透明」和「可点击」—— pywebview/WebView2 做不到，
    详见 cc/electron/main.js 顶部的说明。窗口铺满整屏，所以鲸鱼能拖到任何位置。
    """
    exe = os.path.join(electron_dir(), "node_modules", "electron", "dist", "electron.exe")
    say("开窗：Electron 全屏透明层（可点可拖，空白处点穿）")
    env = dict(os.environ, WHALE_CC_PORT=str(PORT))
    # ⚠ 必须清掉：只要环境里有 ELECTRON_RUN_AS_NODE，electron.exe 就退化成纯 Node 跑，
    # 表现是 require('electron') 拿不到 API（app/BrowserWindow 全是 undefined），
    # 而且 `--version` 报的是 Node 版本号而不是 Electron 版本 —— 极难一眼看出（已踩过）。
    env.pop("ELECTRON_RUN_AS_NODE", None)
    p = subprocess.Popen([exe, electron_dir()], env=env, cwd=electron_dir())
    try:
        p.wait()
    except KeyboardInterrupt:
        pass
    return 0


def open_window(size, margin, opaque=False):
    if not opaque and have_electron():
        return open_electron()
    x, y, w, h = geom(size, margin)
    if have_pywebview():
        return open_pywebview(x, y, w, h, transparent=not opaque)
    return open_edge(x, y, w, h)


def open_pywebview(x, y, w, h, transparent=False):
    import webview
    # 各版本支持的参数不同，逐个退化，别因为一个 kwarg 整个崩掉。
    # 注意 background_color 在 6.x 只收 6 位色值（'#00000000' 会抛 ValueError，
    # 不是 TypeError）—— 所以别再传 8 位色值。
    #
    # ⚠ 窗口故意**不做全屏**：透明一旦没生效，全屏 + 置顶就是一块盖满屏幕的实心色
    #   （已经踩过一次，用户整屏被糊住）。小窗口失败最多是个方块，安全得多。
    base = dict(width=w, height=h, x=x, y=y)
    for extra in (
        dict(frameless=True, easy_drag=True, on_top=True, transparent=transparent),
        dict(frameless=True, easy_drag=True, on_top=True),
        dict(frameless=True, on_top=True),
        dict(),
    ):
        kw = dict(base, **extra)
        try:
            win = webview.create_window(TITLE, URL, **kw)
            say("开窗：pywebview %s%s"
                % ("%dx%d，透明 + 置顶 + 无边框" % (w, h) if kw.get("frameless")
                   else "%dx%d" % (w, h), ""))
            if not transparent:
                say("  （--opaque：白底小窗口模式，非透明）")
            stop = threading.Event()
            threading.Thread(target=pet_keeper, args=(TITLE, stop), daemon=True).start()
            # GUI 起来后再补上窗体那半透明；太早拿不到 win.native
            webview.start(_apply_form_key if transparent else None, win if transparent else None)
            stop.set()
            return 0
        except (TypeError, ValueError) as e:
            say("pywebview 不吃这组参数（%s），退化重试" % type(e).__name__)
            continue
        except Exception as e:
            say("pywebview 开窗失败：%s" % e)
            break
    say("pywebview 不可用，退回 Edge")
    return open_edge(x, y, w, h)


def open_edge(x, y, w, h):
    edge = find_edge()
    if not edge:
        say("找不到 Edge，也没装 pywebview —— 没法开窗。")
        say("装一个：python -m pip install pywebview")
        return 1
    say("开窗：Edge app 模式（无透明背景；装 pywebview 可换真·透明桌宠）")
    profile = os.path.join(tempfile.gettempdir(), "whale-cc-edge-profile")
    p = subprocess.Popen([
        edge, "--app=" + URL + "?opaque=1",   # 浏览器做不到色键，只能用白底
        "--window-size=%d,%d" % (w, h),
        "--window-position=%d,%d" % (x, y),
        "--user-data-dir=" + profile,
        "--no-first-run",
    ])
    # 置顶交给看门狗：窗口要几秒才出来，冷启动更久，与其在这里等不如让它一直盯着
    stop = threading.Event()
    threading.Thread(target=topmost_watchdog, args=(TITLE, stop), daemon=True).start()
    say("置顶看门狗已启动（每 3 秒补一次，不抢焦点）")
    try:
        p.wait()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
    return 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("cmd", nargs="?", default="run",
                    choices=["run", "web", "stop", "status", "config"])
    ap.add_argument("--size", type=int, default=int(os.environ.get("WHALE_CC_SIZE", "720")),
                    help="窗口边长（默认 720；鲸鱼大小随视口走，720 → 约 202px）")
    ap.add_argument("--margin", type=int, default=24)
    ap.add_argument("--opaque", action="store_true",
                    help="不要透明：白底小窗口（透明在你机器上不灵时的退路）")
    ap.add_argument("--scale", type=float, default=None,
                    help="鲸鱼缩放 %.1f~%.1f（不改 UI 直接写配置；下次启动生效）"
                         % (MIN_SCALE, MAX_SCALE))
    args = ap.parse_args()

    if args.cmd == "stop":
        closed = close_window()          # Edge 那条路：按标题发 WM_CLOSE
        sibs = kill_sibling_launchers()  # pywebview 那条路：窗口属于启动器进程本身
        n = stop_server()
        say("服务已关（%d 个进程）" % n if n else "服务本来就没在跑")
        say("窗口已关" if (closed or sibs) else "没有开着的窗口")
        return 0

    if args.cmd == "status":
        alive = server_alive()
        say("服务：%s" % ("在跑 http://127.0.0.1:%d/" % PORT if alive else "没在跑"))
        if have_electron():
            how = "Electron 全屏透明层（透明 + 可点，空白处点穿）"
        elif have_pywebview():
            how = "pywebview（透明，但整窗点穿 —— 装了 Electron 才能点）"
        else:
            how = "Edge app（不透明小窗口）"
        say("开窗方式：%s" % how)
        say("日志：%s" % LOG)
        return 0 if alive else 1

    if args.cmd == "config":
        os.makedirs(WHALE_HOME, exist_ok=True)
        say("配置目录：" + WHALE_HOME)
        try:
            subprocess.Popen(["explorer", WHALE_HOME])
        except Exception:
            pass
        return 0

    if args.scale is not None:
        v = set_scale(args.scale)
        was_running = server_alive()
        say("缩放已设为 %.1f（范围 %.1f~%.1f），存到 %s"
            % (v, MIN_SCALE, MAX_SCALE, SCALE_FILE))
        if was_running:
            # 挂件只在启动时读一次 config，改文件不会热生效
            say("服务在跑 —— 要看到新尺寸得重开：先 `run.cmd stop` 再 `run.cmd`")

    if not ensure_server():
        return 1

    if args.cmd == "web":
        say("浏览器打开 " + URL)
        try:
            os.startfile(URL)
        except Exception:
            subprocess.Popen(["cmd", "/c", "start", "", URL])
        return 0

    return open_window(args.size, args.margin, opaque=args.opaque)


if __name__ == "__main__":
    sys.exit(main())
