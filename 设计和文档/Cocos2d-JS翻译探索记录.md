# Cocos2d-JS 翻译探索记录（maya 游戏）

本文档记录针对 `games/maya`（AGTK + Cocos2d-JS v3.15 JSB）游戏的翻译方案探索过程，避免后续重复踩坑。

## 1. 已验证可行的部分

### 1.1 窗口标题翻译
- 窗口标题存储在 `data/project.json` → `gameInformation.title`
- Runtime 在 SpiderMonkey 引擎内通过 `getStringFromFile` 读取解密后的 JSON
- 替换字符串后写入可写路径，再由 CLI 部署到 `Resources/data/project.json`
- **引擎接受明文（未加密的）JSON 文件**

### 1.2 数据提取（探针）
- 探针通过 `getStringFromFile("data/project.json")` 可读到解密后的 JSON
- 扫描所有字符串值得到 4742 条唯一文本
- 这些文本主要是 UI 标签、对象名、动作名、变量名等

## 2. 尚未解决的问题

### 2.1 实际对话文本未找到
- 游戏内的角色对话文字不在 `data/project.json` 中
- `messageShow` 命令（141 个）使用 `textFlag: false`，引用数值变量而非文本
- `textList` 仅 4 条（全是 UI 标签，如 "999999"、"01"）
- 用户认出的日文词汇在全部文件中搜索均未命中

### 2.2 文本未汉化
- 替换了 56,169 处字符串实例，但仅限 project.json 中的静态字符串
- 实际的运行时对话文本源仍未定位

## 3. 确认不可行的方案

### 3.1 Node.js 侧解密 project.json
- 文件使用 XXTEA 加密（含自定义修改，非标准）
- `data/info.json` 中的 key `"cYmVn7rbhX9w3QyRURU/fQ=="` 经过多种方式均解密失败
- **结论：无法从 Node.js 侧解密**

### 3.2 JavaScript 层 hook（`setString`, `getStringFromFile`, `JSON.parse`）
- 游戏引擎（AGTK）通过 C++ 原生代码读取和解密数据
- 不经过 `jsb.fileUtils.getStringFromFile`（除探针主动调用外）
- 文本渲染不使用 Cocos 的 `cc.Label.setString()` 等 JS 组件
- **结论：JS 层 hook 对 AGTK 游戏的文本无效**

### 3.3 Runtime 内 `writeStringToFile` 直接写入资源目录
- 相对路径写入会被重定向到 `AppData/Local/player/`（可写路径）
- 只有绝对路径可能写入资源目录，但大文件（~100MB）写入返回 false
- **结论：Runtime 内无法可靠修改资源文件**

## 4. 关键技术事实

| 项目 | 事实 |
|------|------|
| 引擎 | AGTK + Cocos2d-JS v3.15 JSB（SpiderMonkey） |
| 加密方案 | 自定义 XXTEA（标准 XXTEA 无法解密） |
| 数据文件 | `Resources/data/project.json`（加密，97MB） |
| textList 条目 | 仅 4 条（UI 标签） |
| messageShow 命令 | 141 个，全部 `textFlag: false` |
| variableList | 122 个变量，名称含日文，值是数值 |
| 当前翻译方案 | CLI 部署 + Runtime 内读取解密 JSON → 翻译 → 写明文文件 → CLI 替换加密原文件 |
| 能解密的唯一途径 | 游戏引擎内的 `jsb.fileUtils.getStringFromFile` |

## 5. 当前状态

- `install-cocos` 会在 `Resources/data/project.json` 旁放置加密备份
- 首次运行游戏时，runtime 读取解密数据、翻译、写出明文 JSON
- CLI 将明文 JSON 部署到 `Resources/data/project.json` 替换加密原文件
- 窗口标题已汉化，但对话文本未汉化（文本源不在 project.json 中）
- 加密备份在 `Resources/OpenGameTranslator/backups/Resources__data__project.json.encrypted.bak`

## 6. 对话文本源分析

### 6.1 已排除的位置
- `data/project.json` 的全部 string 值 — 1958 条含日文的文本均为对象/动作/变量名称，无对话
- `textList` — 仅 4 条 UI 标签
- `localeSettings.ja_JP` — 仅 font layout 字符串
- 所有 DLL（含 `libcocos2d.dll`, `mozjs-33.dll`, `player.exe` 等 18 个）— 搜索无结果
- 所有 `.js` / `.json` / `.txt` 文件 — 搜索无结果

### 6.2 游戏目录中的外部工具文件（已确认无效，可忽略）
- `MTool_Game.lib`、`TrsData.bin`、`ManualTransFile.json` — MTool 产物，不 Work
- `DeepseekR1翻译文件.json` — 机器翻译文件，未生效
- 这些文件不能作为翻译方案参考

### 6.3 无过滤探针验证（2026-05-17）
- 临时移除 `shouldCollectText` 的长度和日文字符过滤
- 提取量从 4742 → 7084（+2342），但新增均为英文/系统标签
- 长文本（>30字符）741 条中，含日文的仅 18 条——全部是开发者 memo 备注
- 用 LLM 推测的对话片段（含"珍しく""部下""春日部""昼食""かすかべ"等词）在加密原文件和明文文件中均搜索不到
- **确认：对话文本不在 `data/project.json` 或任何 JS 文件中**

### 6.4 推测
- 对话文本最可能由 AGTK C++ 引擎运行时从内存/资源段中加载
- 或由引擎通过 ID 查找、拼接生成
- MTool 能提取到 8399 条文本，很可能是通过运行时 hook 截获已显示的文本
- **如果要翻译对话，可能需要类似 MTool 的运行时 hook 方案**，或者找 AGTK 引擎的内存文本调用路径

## 7. 下一步

- [ ] 在游戏运行时观察 `setString()` hook 是否能捕获到显示文本（当前 `displayedTexts: 0`）
- [ ] 研究 AGTK 引擎的文本显示流水线（是否通过 `Agtk.plugins` 或其他 JS API 暴露文本）
- [ ] 考虑 C++ 层面的 DLL 注入方案（复杂度高）
- [ ] 评估：对 AGTK 类游戏，当前”替换静态文件中的字符串”方案能达到的覆盖率是否足够（窗口标题、UI 标签等）

## 8. C++ Hook 探索（2026-05-17）

### 8.1 MTool AgtkHook.dll 逆向发现
- `AgtkHook.dll`（MTool 的 AGTK 专用 hook）使用 MinHook 库
- 目标函数：`agtk::TextGui::updateText(std::string,...)` — 按值传参
- 其他 hook 点：`agtk::data::TextData::getText(char const*)`, `cocos2d::Texture2D::initWithString`

### 8.2 函数签名（从 mangled name 解码）
- `updateText`：`void TextGui::updateText(string, int, int, float, float, int, int)`
- `updateTextRender`：类似签名
- 函数在 player.exe 中（32-bit PE），不导出，需通过 RTTI 定位

### 8.3 RTTI 信息
- TypeDescriptor `.?AVTextGui@agtk@@` 在文件偏移 0x7C826C
- VTable 符号 `??_7TextGui@agtk@@6B@` 在文件偏移 0x690863
- ImageBase: 0x4D2000（PE32 x86）

### 8.4 构建环境
- MSVC BuildTools 2022 + Windows SDK 10.0.26100.0 可用
- `tools/hook_dll/build.bat` 已改为强制 x86 构建，因为 `player.exe` 是 32-bit PE
- 诊断 DLL 只扫描 RTTI 并写日志，不替换文本
- Python 注入器遇到 WoW64 兼容性问题（`CreateToolhelp32Snapshot` 挂起）
- 当前优先使用 `tools/hook_dll/injector.exe`，避免依赖 Python 注入器

### 8.5 待解决
- [x] 在 Windows 上重新运行 `tools\hook_dll\build.bat`，确认生成 x86 `opengametranslator_hook.dll` 和 `injector.exe`
- [x] 启动游戏并注入诊断 DLL
- [x] 运行时 RTTI 扫描确认能定位 `TextGui` 相关信息
- [x] 新版诊断 DLL 可成功解析并安装 `TextGui::updateText/updateTextRender` hook
- [x] 重新运行新版诊断 DLL，确认 `TextGui` hook 是否会被真实剧情文本触发
- [x] 补充 `TextData::getText(char const*)` 只读 hook
- [x] 重新运行新版诊断 DLL，确认 `Texture2D::initWithString` 是否能在 Cocos 文本贴图层抓到真实对话文本
- [ ] 重新运行新版诊断 DLL，确认 `TextLineNode` / `FontManager` / `Label::setString` 系列是否能抓到真实对话文本
- [ ] 根据命中的真实文本路径，实现只读替换实验

### 8.6 诊断日志确认（2026-05-17）

用户提供的 `opengametranslator_hook_diag.txt` 已确认：

- DLL 成功注入 `player.exe`
- DLL 架构是 x86
- `TextGui` RTTI 可在运行时内存中找到
- `player.exe` 导出表包含 `TextGui::updateText` 和 `TextGui::updateTextRender`

本地 PE 导出表进一步确认：

- `?updateText@TextGui@agtk@@...HHMMHH@Z` → RVA `0x0D7B20`
- `?updateText@TextGui@agtk@@...HHMMHHM@Z` → RVA `0x0D8470`
- `?updateTextRender@TextGui@agtk@@...HHMMHH@Z` → RVA `0x0D8D80`
- `?updateTextRender@TextGui@agtk@@...HHMMHHM@Z` → RVA `0x0D96D0`

新版诊断 DLL 已改为通过 `GetProcAddress` 解析这些导出函数并安装只读 inline hook，用于记录进入 `TextGui` 的 `std::string` 参数。

2026-05-17 第二次诊断日志确认：

- `TextGui::updateText/updateTextRender` 的 4 个 hook 均安装成功
- 日志未出现 `[TextHook:...]`，说明注入后当前流程尚未触发这些函数，或对话不走该显示入口
- 已补充 `TextData::getText(char const*)` 只读 hook，用于捕获文本查表层的 key/result

2026-05-17 第三次诊断日志确认：

- `TextData::getText(char const*)` hook 已安装成功
- 推进第一部分文本后，仅捕获到 `TextGui::updateText` 的两个短字符串：`0`、`1`
- 日志没有出现 `[TextData:...]`，说明这段真实剧情文本不走当前 `TextData::getText` 查表路径
- 这基本排除了“只 hook `TextGui::updateText` 就能抓到正文”的简单路线，下一步下沉到 Cocos 渲染层

当前诊断 DLL 已新增 `libcocos2d.dll` 的两个只读 hook：

- `cocos2d::Texture2D::initWithString(char const*, FontDefinition const&)`，日志前缀为 `[CStringHook:...]`
- `cocos2d::Texture2D::initWithString(std::string const&, ...)`，日志前缀为 `[StringHook:...]`

本地已确认这两个符号存在于 `libcocos2d.dll` 导出表中，理论上可通过 `GetProcAddress` 解析。

这里仍然只记录文本，不替换、不写游戏资源。因为 native inline hook 不能随意截断 x86 指令，安装器现在会记录目标函数前 8 字节，并只在看起来是常见 MSVC x86 函数开头时安装 hook；否则会跳过并写入 `Skipped hook ...`，优先避免把游戏进程打崩。

2026-05-17 第四次诊断日志确认：

- `Texture2D::initWithString` 两个重载均已解析并安装成功
- 日志仍然只出现 `TextGui::updateText` 的 `0`、`1`
- 没有 `[CStringHook:...]` 或 `[StringHook:...]`，说明真实剧情文本没有走当前 `Texture2D::initWithString` 路径，或文字纹理在注入前已经缓存

下一版诊断 DLL 已继续补充这些只读 hook：

- `FontManager::createOrSetWithFontData`
- `TextLineNode::create`
- `TextLineNode::init`
- `cocos2d::Label::setString`
- `cocos2d::LabelBMFont::setString`
- `cocos2d::LabelTTF::setString`
- `cocos2d::LabelAtlas::setString`
- `cocos2d::ui::Text::setString/setText`
- `cocos2d::ui::TextBMFont::setString/setText`

这些位置比 `Texture2D::initWithString` 更靠近“文字节点接收字符串”的入口。如果仍然没有正文，再考虑 hook JSB 绑定层或 `ProjectData::getExpandedText` 这类剧情展开函数。

## 9. 下一次需要用户配合的材料

Windows 侧先只做诊断，不做文本替换。操作步骤见 `tools/hook_dll/README.md`。

需要提供给开发侧：

- 注入器命令行输出
- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`
- 注入时游戏所处画面（标题、菜单、第一句对话等）

如果诊断日志能找到 `.?AVTextGui@agtk@@` 或 `TextGui@agtk@@`，下一步才进入实际 hook 设计；如果找不到，先调整 native 扫描策略。

当前已找到 `TextGui`，但实际剧情没有走到可用正文；`Texture2D::initWithString` 也没有触发。下一次需要重点看日志中是否出现来自 `FontManager`、`TextLineNode` 或 `Label::setString` 系列的 `[TextHook:...]` / `[StringHook:...]` 行。

## 10. 2026-05-17 晚间深度逆向会话

### 10.1 C++ Hook 全面诊断结果

经过多轮迭代改进的 hook DLL（v6+）：

**改进内容：**
- x86 指令级解码器（`GetProloguePatchSize`）：覆盖 `0x80-0x8F` 范围，修复 `LabelAtlas::setString` 的 `sub esp, imm8` 解码
- 新增 5 个之前被跳过的 hook：`LabelBMFont::setString`、`LabelTTF::setString`、`ui::Text::setString`、`ui::TextBMFont::setString`、`LabelAtlas::setString`
- 新增 AGTK 层 hook：`ProjectData::getExpandedText`、`ObjectAction::execActionMessageShow`
- 修复 `lea`→`mov` bug：`updateText` 系列按值传参的 `std::string` 使用了错误的栈偏移
- 添加心跳日志（10 秒间隔）
- 创建 `launcher.exe`：挂起启动（`CREATE_SUSPENDED`）→ 注入 DLL → 恢复，确保 hook 在游戏初始化前就位

**最终结果：17 个 hook 安装成功，60 秒内心跳正常，但零捕获。**

这覆盖了 Cocos2d 文本渲染全链路（`Label::setString` → `Texture2D::initWithString` → `FontManager` → `TextLineNode`）和 AGTK 对话层（`TextGui::updateText` → `updateTextRender` → `TextData::getText` → `getExpandedText` → `execActionMessageShow`）。没有一个被对话触发。

**结论：游戏的对话文本不走标准 Cocos2d 文本管线，也不走 AGTK 的标准 TextGui 流程。**

### 10.2 内存扫描结果

开发了多轮迭代的内存扫描工具（`scan_dialogue.py`、`quick_scan.py`）：
- 扫描 2088 个可读内存区域
- 发现所有日文文本均为 UTF-8 编码（非 Shift-JIS）
- 最终提取 1104 条唯一可读日文字符串
- **全部是引擎 UI 标签、开发者备注、场景/动作名称——无角色对话**

### 10.3 project.json 结构深度分析

增强了 JS 探针进行结构分析（`opengametranslator-structural-probe.js`）：

**project.json 顶层键（66 个）：**
- `sceneList`、`objectList`、`variableList`、`switchList`、`textList`、`databaseList` 等
- 无 `dialogue`、`script`、`message` 等对话文本键

**messageShow 命令（141 个）：**
- 全部 `textFlag: false`，`textId: -1`
- 通过 `variableId` 引用数值变量（如 "プレイヤーのレベル"=1、"経験値"=0）
- messageShow 用于显示游戏数值，**不是对话**

**textList（4 条）：**
- ID 1-4，内容为 "999999"、"1234567890"、"01"、"0"
- 全部是 UI 标签，无对话文本

**textFlag=true 的命令（4 个）：**
- 位于 `objCommandList`，引用 textList ID 1 或 3
- 显示的仍是 UI 标签（"999999"、"01"）

**所有 JSON 字符串值（4742 条唯一）：**
- 98 条含日语句末标点（。？！…）
- 全部是编辑器标签、开发者备注、动作名称
- **无角色说话内容**

### 10.4 关键结论

1. **对话文本不在 project.json 中以明文字符串存在**
2. **Cocos2d 和 AGTK 的 17 个文本函数均不参与对话渲染**
3. **游戏只加载了一个数据文件（project.json，101MB）**——启动时未读取其他文件
4. 对话可能：
   - 在场景切换时从 project.json 的编码/二进制字段中加载
   - 由 AGTK 引擎通过字体纹理/字形索引渲染（非字符串方式）
   - 存储在 `objectList` 深层嵌套的二进制数据中
   - 由 `assignScript`/`javaScript` 在运行时动态生成

### 10.5 下一步（当前会话）

- [ ] 增强探针：追踪**所有文件读取**（包括场景加载时），不只启动时
- [ ] 定位场景数据加载路径——对话可能在场景切换时读入
- [ ] 如果确认无额外文件读取，分析 objectList 中是否有二进制编码的文本数据
