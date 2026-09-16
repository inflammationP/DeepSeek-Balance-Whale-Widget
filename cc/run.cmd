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
python "%~dp0whale.py" %*
