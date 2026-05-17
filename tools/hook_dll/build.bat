@echo off
setlocal

set "VCVARS="

rem Use 8.3 short paths here to avoid cmd.exe parsing issues with "(x86)".
if exist "C:\Progra~2\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=C:\Progra~2\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if not defined VCVARS if exist "C:\Progra~1\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=C:\Progra~1\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if not defined VCVARS if exist "C:\Progra~1\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=C:\Progra~1\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
if not defined VCVARS if exist "C:\Progra~1\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=C:\Progra~1\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat"
if not defined VCVARS if exist "C:\Progra~1\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=C:\Progra~1\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat"

if not exist "%VCVARS%" (
    echo Visual Studio C++ build tools were not found.
    echo Expected: %VCVARS%
    exit /b 1
)

rem player.exe is a 32-bit process, so both the hook DLL and injector must be x86.
call "%VCVARS%" x86 >nul
if errorlevel 1 (
    echo Failed to initialize the x86 MSVC build environment.
    exit /b 1
)

echo Building x86 diagnostic hook DLL...
cl /nologo /LD /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS ^
    opengametranslator_hook.c ^
    /Fe:opengametranslator_hook.dll ^
    /link kernel32.lib user32.lib

if errorlevel 1 (
    echo Build FAILED: opengametranslator_hook.dll
    exit /b 1
)

echo Building x86 injector...
cl /nologo /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS ^
    injector.c ^
    /Fe:injector.exe ^
    /link kernel32.lib

if errorlevel 1 (
    echo Build FAILED: injector.exe
    exit /b 1
)

echo Building x86 launcher...
cl /nologo /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS ^
    launcher.c ^
    /Fe:launcher.exe ^
    /link kernel32.lib

if errorlevel 1 (
    echo Build FAILED: launcher.exe
    exit /b 1
)

echo.
echo Build successful:
echo   opengametranslator_hook.dll
echo   injector.exe
echo   launcher.exe
