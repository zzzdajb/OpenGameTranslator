#!/bin/bash
# Build OpenGameTranslator hook DLL from bash
# Uses MSVC BuildTools 2022 x86

VCVARS="C:/Progra~2/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvarsall.bat"
HOOK_DIR="C:/York/Works/Programming/OpenGameTranslator/tools/hook_dll"

# Create temp batch file
BAT_FILE=$(wslpath -w "$HOME/AppData/Local/Temp/build_hook.bat" 2>/dev/null || echo "C:/Users/York/AppData/Local/Temp/build_hook.bat")

cat > "$(wslpath -u "$BAT_FILE" 2>/dev/null || echo "/c/Users/York/AppData/Local/Temp/build_hook.bat")" << 'ENDOFBAT'
@echo off
call "C:\Progra~2\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul 2>&1
if errorlevel 1 (
    echo VS x86 env failed
    exit /b 1
)
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
echo Building hook DLL...
cl /nologo /LD /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS opengametranslator_hook.c /Fe:opengametranslator_hook.dll /link kernel32.lib user32.lib
if errorlevel 1 exit /b 1
echo Building injector...
cl /nologo /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS injector.c /Fe:injector.exe /link kernel32.lib
if errorlevel 1 exit /b 1
echo Building launcher...
cl /nologo /Od /MT /W3 /D_CRT_SECURE_NO_WARNINGS launcher.c /Fe:launcher.exe /link kernel32.lib
if errorlevel 1 exit /b 1
echo OK
ENDOFBAT

powershell.exe -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '$BAT_FILE' -Wait -NoNewWindow" 2>&1

# Check results
ls -la "$HOOK_DIR/opengametranslator_hook.dll" "$HOOK_DIR/injector.exe" "$HOOK_DIR/launcher.exe" 2>&1