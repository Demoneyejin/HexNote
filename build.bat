@echo off
REM Build HexNote.
REM Usage: build.bat
REM
REM Without credentials this builds the bring-your-own-key app (Team mode
REM only): users paste their own Google Cloud OAuth client on first launch.
REM
REM To also offer Solo mode ("Sign in with Google" using HexNote's own
REM verified OAuth client with the drive.file scope), put the client in a
REM .env file (never committed) or the environment:
REM   HEXNOTE_CLIENT_ID=....apps.googleusercontent.com
REM   HEXNOTE_CLIENT_SECRET=...
REM They are injected into the binary at compile time, never in source code.

REM Load .env file
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%a:~0,1%"=="#" set "%%a=%%b"
    )
)

if not "%HEXNOTE_CLIENT_ID%"=="" if not "%HEXNOTE_CLIENT_SECRET%"=="" goto bundled
if not "%HEXNOTE_CLIENT_ID%"=="" goto half
if not "%HEXNOTE_CLIENT_SECRET%"=="" goto half

echo Building HexNote without a bundled OAuth client (Team mode only)...
REM -s strips symbol table, -w strips DWARF debug info
wails build -ldflags "-s -w"
goto done

:half
echo ERROR: set both HEXNOTE_CLIENT_ID and HEXNOTE_CLIENT_SECRET, or neither.
exit /b 1

:bundled
echo Building HexNote with the bundled OAuth client (Solo + Team mode)...
REM No single quotes around -X values; Windows passes them literally
wails build -ldflags "-s -w -X hexnote/internal/drive.bundledClientID=%HEXNOTE_CLIENT_ID% -X hexnote/internal/drive.bundledClientSecret=%HEXNOTE_CLIENT_SECRET%"

:done
echo Done: build\bin\hexnote.exe
