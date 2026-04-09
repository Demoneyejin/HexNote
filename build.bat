@echo off
REM Build HexNote with OAuth credentials injected from .env
REM Usage: build.bat
REM Credentials are injected into the binary at compile time — never in source code.

REM Load .env file
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%a:~0,1%"=="#" set "%%a=%%b"
    )
)

if "%HEXNOTE_CLIENT_ID%"=="" (
    echo ERROR: HEXNOTE_CLIENT_ID not set. Create a .env file.
    exit /b 1
)
if "%HEXNOTE_CLIENT_SECRET%"=="" (
    echo ERROR: HEXNOTE_CLIENT_SECRET not set. Create a .env file.
    exit /b 1
)

echo Building HexNote with bundled credentials...
REM -s strips symbol table, -w strips DWARF debug info
REM No single quotes around -X values — Windows passes them literally
wails build -ldflags "-s -w -X hexnote/internal/drive.bundledClientID=%HEXNOTE_CLIENT_ID% -X hexnote/internal/drive.bundledClientSecret=%HEXNOTE_CLIENT_SECRET%"
echo Done: build\bin\hexnote.exe
