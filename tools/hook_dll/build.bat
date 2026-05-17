@echo off
setlocal

set "VSROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
set "MSVC_VER=14.44.35207"
set "SDK_VER=10.0.26100.0"

set "MSVC=%VSROOT%\VC\Tools\MSVC\%MSVC_VER%"
set "SDK=C:\Program Files (x86)\Windows Kits\10"

set "CL=%MSVC%\bin\Hostx64\x64\cl.exe"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDK_VER%\ucrt;%SDK%\Include\%SDK_VER%\um;%SDK%\Include\%SDK_VER%\shared"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDK_VER%\ucrt\x64;%SDK%\Lib\%SDK_VER%\um\x64"

"%CL%" /nologo /LD /O2 /MT ^
    opengametranslator_hook.c ^
    /Fe:opengametranslator_hook.dll ^
    /link /NODEFAULTLIB:libcmt.lib kernel32.lib user32.lib

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Build successful: opengametranslator_hook.dll
) else (
    echo.
    echo Build FAILED.
)
