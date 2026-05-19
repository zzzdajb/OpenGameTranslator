# AGTK / Cocos2d-JS native 诊断工具

这里的工具只用于确认 AGTK / Cocos2d-JS 游戏的原生文本函数位置，并抓取进入文本显示函数的参数。当前阶段是诊断，不会替换文本，也不会修改游戏资源文件。

## 1. 构建

在 Windows 的普通 `cmd.exe` 中运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
```

预期生成：

```text
opengametranslator_hook.dll
injector.exe
```

注意：`player.exe` 是 32-bit 程序，所以脚本会强制构建 x86 DLL 和 x86 注入器。

## 2. 运行游戏

如果之前已经注入过诊断 DLL，先关闭游戏再重新启动。Windows 对同一路径 DLL 会复用已加载模块，不重启游戏可能不会加载新版 DLL。

启动游戏，并尽量进入能看到真实对话文本的位置：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\games\maya
run-me.bat
```

## 3. 注入诊断 DLL

游戏保持运行，再打开一个新的 `cmd.exe`：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
injector.exe player.exe opengametranslator_hook.dll
```

如果提示 `OpenProcess failed`，用“以管理员身份运行”的 `cmd.exe` 重试。

## 4. 需要提供给 Codex 的信息

运行后请提供这些内容：

- 注入器命令行输出。
- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `C:\York\Works\Programming\OpenGameTranslator\games\maya\action_log.txt`
- 注入时游戏大概停在哪个画面，例如标题、菜单、第一句对话。

如果诊断日志里能看到 `.?AVTextGui@agtk@@` 或 `TextGui@agtk@@`，说明可以继续定位 AGTK 文本函数。否则要调整 native 扫描策略。

## 5. 挂起启动注入（推荐用于捕获初始化文本）

游戏可能在启动时一次性创建所有文本纹理，注入晚了就抓不到。用 `launcher.exe` 以挂起方式创建游戏进程，注入 DLL 后再恢复：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

这样 DLL 会在游戏加载任何资源之前就位，能捕获到启动时的所有文本调用。

新版诊断 DLL 还会尝试 hook 这些导出函数：

- `TextGui::updateText`
- `TextGui::updateTextRender`
- `TextData::getText`
- `FontManager::createOrSetWithFontData`
- `TextLineNode::create`
- `TextLineNode::init`
- `cocos2d::Texture2D::initWithString`
- `cocos2d::Label::setString`
- `cocos2d::LabelBMFont::setString`
- `cocos2d::LabelTTF::setString`
- `cocos2d::LabelAtlas::setString`
- `cocos2d::ui::Text::setString/setText`
- `cocos2d::ui::TextBMFont::setString/setText`

新版还新增了文件 I/O hook：

- `CreateFileW` — 记录游戏通过 Windows API 打开的所有文件路径
- `CreateFileA` — 同上（ANSI 版本）
- `fopen` / `fopen_s` / `fread` — 通过修改 `player.exe` 和 `libcocos2d.dll` 的导入表记录 CRT stdio 读文件路径和读取量

同时新增 SpiderMonkey 字符串创建 hook：

- `JS_NewStringCopyN`
- `JS_NewStringCopyZ`
- `JS_NewUCStringCopyN`
- `JS_NewUCStringCopyZ`
- `JS_NewUCString`
- `JS_InternString`
- `JS_InternStringN`
- `JS_InternUCString`
- `JS_InternUCStringN`
- `JS_ParseJSON` raw wchar_t 重载

新增 AGTK 消息 UI / 数据 setter 诊断 hook：

- `ActionCommandMessageTextUi::update`
- `ActionCommandScrollMessageTextUi::update`
- `ActionCommandMessageTextUi::setTextGui`
- `ActionCommandScrollMessageTextUi::setTextGui`
- `ObjectAction::execActionScrollMessageShow`
- `GuiManager::addActionCommandMessageGui` 两个重载
- `GuiManager::addActionCommandScrollMessageGui` 两个重载
- `ActionCommandMessageTextUi::create`
- `ActionCommandScrollMessageTextUi::create`
- `ActionCommandMessageTextUi::init`
- `ActionCommandScrollMessageTextUi::init`
- `ActionCommandMessageTextUi::setData`
- `ActionCommandScrollMessageTextUi::setData`
- `ActionCommandMessageTextUi::getData`
- `ActionCommandScrollMessageTextUi::getData`
- `MessageWindowNode::create` 普通 message / scroll message 两个重载
- `MessageWindowNode::init` 普通 message / scroll message 两个重载
- `ObjectCommandMessageShowData::getTextFlag`
- `ObjectCommandMessageShowData::getTextId`
- `ObjectCommandMessageShowData::getVariableId`
- `ObjectCommandMessageShowData::getVariableObjectId`
- `ObjectCommandMessageShowData::getVariableQualifierId`
- `ObjectCommandScrollMessageShowData::getTextId`
- `ObjectCommandMessageShowData::setTextId`
- `ObjectCommandMessageShowData::setTextFlag`
- `ObjectCommandMessageShowData::setVariableId`
- `ObjectCommandMessageShowData::setVariableObjectId`
- `ObjectCommandMessageShowData::setVariableQualifierId`
- `ObjectCommandScrollMessageShowData::setTextId`

`ObjectAction::execActionMessageShow` 现在不再把 `ObjectCommandData*` 当作 C 字符串读取，而是输出 `[ObjectCommandProbe:N]` 结构体探针日志：先 dump 前 0x80 字节，再尝试识别内联 `std::string`、直接指针字符串和一层嵌套指针字符串。

日志中以 `[FileHook:N]` 开头的行为文件路径记录。用于确认 AGTK 引擎是否通过 Cocos2d `fileUtils` 之外的路径读取对话数据文件。

日志中以 `[CRTFile:N]` / `[CRTRead:N]` 开头的行为 CRT 文件 I/O 记录；以 `[JSString:N/M]` 开头的行为 SpiderMonkey 字符串创建记录；以 `[ObjectCommandProbe:N]` 开头的行为 `execActionMessageShow` / `execActionScrollMessageShow` 参数结构体记录；以 `[MessageUiLink:N]` 开头的行为 AGTK 消息 UI 与 `TextGui` 的绑定记录；以 `[MessageUiUpdate:N/M]` 开头的行为 AGTK 消息 UI update 抽样记录；以 `[MessageFlow:N/M]` 开头的行为已确认的 `ObjectCommandMessageShowData` / `ObjectCommandScrollMessageShowData` 记录；以 `[MessageFlowOther:N/M]` 开头的行为未匹配 message data vtable 的噪声样本；以 `[ValueHook:N]` 开头的行为 messageShow 数据 setter 记录；以 `[ValueGet:N]` 开头的行为 messageShow 数据 getter 使用记录。

启动日志会输出 `Resolved message data vtables: message=... scroll=...`。setter 第一次触发时还会输出 `[ValueHook] learned ... vtable from setter`，因为 PE 导出的 vtable 地址和对象首 DWORD 可能不完全一致。`MessageFlow` 会用导出 vtable 和 setter 学到的 vtable 一起判断对象类型，再输出 `textId` / `variableId` 等字段；heartbeat 里的 `MessageFlow=seen/logged Data=confirmed Other=otherSeen` 用来判断是否真的抓到了 message data。

如果日志里出现 `[TextHook:...]`、`[TextData:...]`、`[CStringHook:...]` 或 `[StringHook:...]` 行，说明已经截获到 AGTK/Cocos 传给文本显示/查表函数的字符串。下一步才会设计真正的翻译替换逻辑。
