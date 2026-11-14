@echo off
REM Build HexNote.
REM Usage: build.bat
REM
REM Without credentials this builds the bring-your-own-key app: users paste
REM their own Google Cloud OAuth client on first launch.
REM
REM To build in HexNote's own "Sign in with Google" (HexNote's OAuth client,
REM full drive scope), put the client in a .env file (never committed) or the
REM environment:
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

echo Building HexNote without a bundled OAuth client (bring your own key)...
REM -s strips symbol table, -w strips DWARF debug info
wails build -ldflags "-s -w"
goto done

:half
echo ERROR: set both HEXNOTE_CLIENT_ID and HEXNOTE_CLIENT_SECRET, or neither.
exit /b 1

:bundled
echo Building HexNote with the bundled OAuth client (built-in Sign in with Google)...
REM No single quotes around -X values; Windows passes them literally
wails build -ldflags "-s -w -X hexnote/internal/drive.bundledClientID=%HEXNOTE_CLIENT_ID% -X hexnote/internal/drive.bundledClientSecret=%HEXNOTE_CLIENT_SECRET%"

:done
echo Done: build\bin\hexnote.exe
