@echo off
REM ===========================================================================
REM  Little Whale desktop pet - Claude Code edition
REM
REM    run.cmd           start server + open the pet window
REM    run.cmd web       server only, open in browser (use this to configure)
REM    run.cmd stop      stop server and close the pet window
REM    run.cmd status    show current state
REM    run.cmd config    open the config folder
REM
REM  (ASCII only on purpose - cmd.exe reads .cmd as the OEM codepage, so non-ASCII
REM   text here gets mangled. All user-facing Chinese lives in whale.py instead.)
REM ===========================================================================
chcp 65001 >nul 2>&1
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

REM No args (or "run") = the double-click / one-key path: hand off to pythonw and
REM let this console die. The launcher sits and waits while the window is open
REM (p.wait / webview.start), so a plain "python" here parks a cmd.exe icon in the
REM taskbar for the whole session. pythonw has no console at all.
REM Subcommands keep the console - their output is the whole point.
if "%~1"=="" goto window
if /i "%~1"=="run" goto window
goto console

:window
REM pythonw missing (rare - e.g. some Store installs): fall back to a visible console.
where pythonw >nul 2>&1 || goto console
start "" pythonw "%~dp0whale.py" %*
exit /b

:console
python "%~dp0whale.py" %*
