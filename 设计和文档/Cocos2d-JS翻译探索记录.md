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

- [x] 增强探针：追踪**所有文件读取**（包括场景加载时），不只启动时
- [x] 定位场景数据加载路径——对话可能在场景切换时读入
- [x] 分析 objectList 中是否有二进制编码的文本数据

### 10.6 SQLite 调查（2026-05-17 深夜）

- 游戏目录存在 `sqlite3.dll`，MTool 的 AgtkHook 代理此 DLL
- Hook `sqlite3_open` 发现数据库路径为 `%LOCALAPPDATA%/player/jsb.sqlite`
- 表结构：`CREATE TABLE IF NOT EXISTS data(key TEXT PRIMARY KEY, value TEXT)` —— 简单 KV 存储
- 仅有 SAVE/LOAD 查询（`SELECT/REPLACE/DELETE`），**不包含任何游戏文本数据**
- Hook 了 `sqlite3_column_text`、`sqlite3_column_text16`、`sqlite3_exec`、`sqlite3_prepare_v2`、`sqlite3_step`
- **结论：SQLite 仅用于游戏存档，不存储对话文本**

### 10.7 最终诊断结论（2026-05-17）

**最终版本的 hook DLL（21 个 hook，涵盖 Cocos2d + AGTK + SQLite 全链路）：**

| Hook | 目标 DLL | 对话期间被调用 | 捕获内容 |
|------|---------|-------------|---------|
| updateText-7/8 | player.exe | 是 | 空字符串 / "0" |
| updateTextRender-7/8 | player.exe | 否 | - |
| TextData::getText | player.exe | 否 | - |
| FontManager::createOrSetWithFontData | player.exe | 否 | - |
| TextLineNode::create/init | player.exe | 否 | - |
| ProjectData::getExpandedText | player.exe | 否 | - |
| ObjectAction::execActionMessageShow | player.exe | 是 | ObjectCommandData 指针 |
| TextGui::getString | player.exe | 是 | 未初始化返回指针（CALL 式不可用） |
| Texture2D::initWithString (×2) | libcocos2d.dll | 否 | - |
| Label::setString 系列 (×5) | libcocos2d.dll | 否 | - |
| ui::Text::setString/setText (×2) | libcocos2d.dll | 否 | - |
| ui::TextBMFont::setString/setText (×2) | libcocos2d.dll | 否 | - |
| sqlite3_column_text/16 | sqlite3.dll | 否 | - |
| sqlite3_exec | sqlite3.dll | 是 | schema 查询 |
| sqlite3_prepare_v2/step/open | sqlite3.dll | 是 | save data KV 操作 |

**调用约定发现：**
- MSVC x86 中，`std::string` 按值传参是直接压栈（24 字节），不是隐藏指针
- 正确栈偏移：`lea eax, [esp+40]`（栈上对象地址），不是 `mov eax, [esp+40]`（错误解引用）
- `const&` 参数：`mov eax, [esp+40]` 正确（引用即指针）
- CALL 式 detour 破坏 thiscall 的 ebp 相对寻址，不可用于 thiscall 函数

**工具链成果：**
- `launcher.exe`：CREATE_SUSPENDED + 注入 + ResumeThread
- `scan_dialogue.py`：双编码（UTF-8/Shift-JIS）内存扫描器
- `quick_scan.py`：自动编码检测的快速提取器
- JS 结构探针 + 全文件读取追踪

**硬结论：**
1. 对话文本通过 AGTK 图像字体系统（`imageFontFlag: true`）以字形索引方式渲染
2. 文本从不以 std::string 形式存在于可访问内存中
3. C++ 函数 hook 方案对 AGTK 图像字体游戏不可行
4. 翻译此游戏需要：字体纹理替换、GPU 层 OCR、或反编译字形索引序列

## 11. 2026-05-18 project.json 深度二进制分析

### 11.1 分析范围

对翻译后的 project.json（85MB，550 万节点）进行了穷举式扫描：
- 25.5 万字符串（含 5.6 万 CJK 字符串）
- 351 万整数、140,721 个数值数组
- 1,414 个 `assignScript`/`javaScript` 脚本
- 141 个 `messageShow` 对象
- 8 个字体定义（含 `letterLayout` 字形布局）

### 11.2 所有字符串分析

长字符串（>30 字符）250 条，含句末标点（。！？…）2,020 条，**全部是编辑器元数据**：
- `animationList`：1,745 条（动作名/备注）
- `objectList`：485 条（动作名/碰撞检测备注）
- `fontList`：6 条（`letterLayout` 字体布局）
- `variableList`：4 条（变量备注）
- `switchList`：6 条（开关备注）

零条角色对话文本。

### 11.3 数值数组分析

140,721 个数值数组：
- 99.6% 是坐标对（size=2, 83,553 个）或颜色三元组（size=3, 57,062 个）
- 最大的数组仅 12 个元素（`actionIdList`，动作 ID 列表）
- 所有数组尝试 UTF-8/Shift-JIS/UTF-16/Unicode 码点/字形索引解码，无对话文本

### 11.4 脚本字段分析

1,414 个 `assignScript`/`javaScript` 字段，长度 8-24 字符，全为变量赋值/碰撞检测公式，无对话。

### 11.5 字形索引解码尝试

假设对话以字体字形索引（glyph index）存储在数值数组中，使用 font 1 的 291 字符 `letterLayout` 做映射表：
- 38 个数组"解码"出日文
- 全部是 `layerMoveSpeed` 数值=100 恰好映射到假名"わ"
- 零条对话

### 11.6 MTool / DeepseekR1 数据交叉验证

- `ManualTransFile.json`：8,399 条（MTool 提取），长文本全是编辑器备注
- `DeepseekR1翻译文件.json`：8,449 条（Deepseek 翻译），同样无对话
- 用户确认看到的对话文本（"それからどれくらい経ったか..."）在 MTool 提取中**也未出现**

### 11.7 游戏文件全面搜索

- 搜索整个 `games/maya` 目录（DLL/EXE/JS/JSON/BIN/DAT/HTML/TXT）中对话文本的 UTF-8 和 Shift-JIS 字节序列 → **完全未命中**
- 探针仅记录 8 个文件读取（全排除）：project.json、info.json、init.js、prepare.js、jsb.js、jsb_boot.js

### 11.8 文件大小分析

- 加密 project.json：102MB
- 翻译后 compact JSON：85MB
- 翻译后 indent=1 JSON：151MB
- 加密原文件解密后约 102MB，差异 17MB 可完全由 JSON 格式化空白解释（~20% 空白比）
- **排除"JSON 后有二进制数据段"的假设**

### 11.9 核心矛盾

对话文本不在 project.json（任何形式）、不在任何 JS/DLL/EXE 文件、不在 MTool 提取中，但游戏确实在屏幕上显示对话。最可能的原因：

1. **C++ hook 参数读取有 bug**：`execActionMessageShow` 和 `updateText-7` 在对话期间触发了，但捕获到垃圾数据——可能函数签名理解有误
2. **AGTK 引擎通过原生文件 I/O 读取了未探测到的文件**
3. **对话文本在 SpiderMonkey JS 引擎内部生成/拼接**，未经过 Cocos2d 文本渲染管线

### 11.10 下一步方向

- [x] Hook Windows 原生文件 I/O（`CreateFileW`/`CreateFileA`）：**已完成，结论见第 12 节**
- [x] 分析 MTool / DeepseekR1 提取数据交叉验证：**已完成，结论见第 12 节**
- [x] `execActionMessageShow` 改为 `ObjectCommandData*` 结构体探针：**代码准备完成，待下一次运行验证**
- [x] Hook SpiderMonkey `JS_NewStringCopyN` 等 JS 字符串创建函数：**代码准备完成，待下一次运行验证**
- [ ] 研究 AGTK 引擎如何从 project.json 数值数据拼接生成对话文本

## 12. 2026-05-18 文件 I/O Hook 验证

### 12.1 实现

在 hook DLL 中新增 `kernel32.dll` 的 `CreateFileW` 和 `CreateFileA` hook：

- **技术挑战 1**：kernel32 导出函数开头是 `FF 25`（间接跳转 stub），不是标准 MSVC 前言。通过在 `InstallInlineHook` 中解析 `FF 25 [disp32]` 跟随到真实实现地址解决。
- **技术挑战 2**：真实实现有 `8B FF`（`mov edi, edi`，Windows hotpatch NOP 前缀）。在 `GetProloguePatchSize` 中添加跳过逻辑。
- **防重入保护**：`FlushLog()` 内部调用 `CreateFileW` 写日志，因此 file hook 日志函数内部不调用 `FlushLog()`，并设置 `g_inFileHook` 标志位。

### 12.2 结果

- CreateFileW/CreateFileA 均安装成功（patchSize=8/6）
- 捕获 500 条文件打开记录，**全部是 `Resources/img/*.png` 图片资源**
- 非图片文件仅：`action_log.txt`（游戏日志）、`tzres.dll`（系统时区）
- `project.json` 未通过 `CreateFileW` 打开——说明 Cocos2d `getStringFromFile` 使用内部路径（可能是 CRT `fopen` 或内存映射，不经过 Win32 `CreateFileW`）

### 12.3 结论

**游戏不通过 Windows 原生文件 I/O 读取任何对话文本文件。** "存在未探测到的对话数据文件"假设被排除。

## 13. 总状态梳理（2026-05-18）

### 13.1 已排除的假设

| 假设 | 验证方法 | 结论 |
|------|---------|------|
| 对话在 project.json 字符串中 | 穷举扫描 25.5 万字符串 | ❌ 全是编辑器元数据 |
| 对话在 project.json 数值数组中 | 分析 14 万数组，尝试所有编码+字形索引解码 | ❌ 全是坐标/颜色/action ID |
| 对话在 project.json 脚本中 | 分析 1,414 个 assignScript/javaScript | ❌ 全是变量赋值公式 |
| 对话在 project.json 二进制 blob 中 | 搜索 base64/非打印字符/长字符串 | ❌ 未发现 |
| 对话在 JSON 后追加的二进制段 | 文件大小分析 | ❌ 17MB 差异可完全由 JSON 空白解释 |
| 对话在独立数据文件中 | 探针 8 个文件 + CreateFileW hook 只看到图片 | ❌ 未发现 |
| 对话在 DLL/EXE 嵌入字符串中 | 搜索所有 DLL+EXE 文件字节序列 | ❌ 未命中 |
| 对话在 MTool 提取的 8,399 条文本中 | 交叉验证 ManualTransFile.json | ❌ 全是编辑器元数据 |
| 对话在 DeepseekR1 翻译的 8,449 条文本中 | 交叉验证 | ❌ 同上 |
| 对话经过 Cocos2d 文本渲染管线 | 21 个 hook 覆盖全链路 | ❌ 仅 Label::setString("0"/"1")触发 |
| 对话经过 AGTK TextGui 文本管线 | updateText/updateTextRender hook | ❌ 仅捕获 "0"/"1" |

### 13.2 已确认的事实

1. 游戏仅读取 8 个文件（全排除）并通过 Win32 文件 I/O 仅读图片
2. 对话期间触发的 hook：`execActionMessageShow`（捕获乱码）、`TextGui::getString`（捕获 "."）、`updateText-7`（捕获 "0"/"1"）、`Label::setString`（捕获 "0"/"1"）
3. 字体系统使用图像字体（`imageFontFlag: true`），font 1 的 letterLayout 含 291 个日文字符
4. messageShow 141 个命令全为 `textFlag: false`，仅显示数值变量
5. 游戏不崩溃，说明我们的 hook 安装本身是安全的

### 13.3 仍然可能的假设

1. **AGTK 引擎从 project.json 数据动态拼接对话**：对话文本分散在 project.json 的多个数值/字符串字段中，由 C++ 引擎在运行时组装——我们的 hook 在文本组装完成后才介入，但参数读取有 bug。
2. **对话文本在 SpiderMonkey JS 引擎中**：游戏脚本（`assignScript`/`javaScript`）虽短，但可能触发更复杂的 JS 逻辑生成文本。
3. **对话走的是 AGTK 文本查表路径**：`TextData::getText` 接收的不是字符串 key 而是某种 ID，我们 hook 时参数解读方式不对。
4. **对话以图像字体字形索引序列存储**：在 project.json 的某个嵌套结构中，但使用了我们未掌握的查找表（不是 letterLayout 直接映射）。

### 13.4 下一步方向（按优先级）

A. **修复 `execActionMessageShow` 参数读取**（最直接——它确实在对话期间触发了，但捕获到乱码 `�S�`。需要逆向 `ObjectCommandData` 结构体，找到真正的文本字段）

B. **Hook SpiderMonkey JS 字符串创建**（覆盖面最广——`mozjs-33.dll` 的 `JS_NewStringCopyN`/`JS_NewStringCopyZ` 会拦截所有 JS 层字符串，可能捕获到 JS 侧生成的对话文本）

C. **逆向 AGTK `ObjectCommandData` 结构体**（理解 `execActionMessageShow` 的参数布局，确定文本在结构体中的偏移位置）

D. **Hook CRT 文件 I/O**（`fopen`/`fread`）以捕获 `project.json` 的原始解密数据流，验证 JSON 后是否有二进制段

以上 A/B/D 三条的代码准备见第 14 节，仍需一次 Windows 运行日志来确认实际命中情况。

## 14. 2026-05-18 夜间静态收敛准备

本节记录不需要再次人工运行游戏即可完成的代码准备。目标不是直接翻译，而是把下一轮运行游戏时需要的诊断入口一次性补齐。

### 14.1 已复核的旧日志结论

最新 `games/maya/opengametranslator_hook_diag.txt` 显示：

- 旧版 native hook 安装稳定，`execActionMessageShow`、`TextGui::getString`、Cocos Label/TextLine 等 hook 均未导致崩溃。
- `ObjectAction::execActionMessageShow` 在对话出现时触发 2 次，但旧代码把 `ObjectCommandData*` 当 C 字符串读取，所以得到乱码 `�S�`。
- Cocos/AGTK 文本渲染链只捕获到 `"0"` / `"1"`，没有捕获实际日文对白。
- `CreateFileW/A` 捕获到的 500 条文件打开基本都是 `Resources/img/*.png`，未出现独立对话数据文件；心跳里的 FileIO 总数超过 1700。

### 14.2 本轮已完成的代码准备

`tools/hook_dll/opengametranslator_hook.c` 已新增三条诊断路径：

1. `execActionMessageShow` 结构体探针
   - 新增 `[ObjectCommandProbe:N]` 日志。
   - 不再把 `ObjectCommandData*` 当字符串读。
   - 会 dump `ObjectCommandData` 前 `0x80` 字节，并尝试识别内联 `std::string`、直接指针字符串、一层嵌套指针字符串。

2. SpiderMonkey 字符串创建 hook
   - Hook `mozjs-33.dll` 导出的 `JS_NewStringCopyN`、`JS_NewStringCopyZ`、`JS_NewUCStringCopyN`、`JS_NewUCStringCopyZ`、`JS_InternString`、`JS_InternStringN`。
   - 新增 `[JSString:logged/seen]` 日志。
   - 为避免日志被纯 ASCII 系统字符串刷爆，只完整保留前 50 次调用，之后优先记录含高位字节或明显可读文本的字符串。

3. CRT 文件 I/O hook
   - 通过 IAT hook 修改 `player.exe` / `libcocos2d.dll` 导入表中的 `fopen`、`fopen_s`、`fread`。
   - 新增 `[CRTFile:N]` 和 `[CRTRead:N]` 日志。
   - 选择 IAT hook 的原因：当前游戏通过 UCRT API Set 导入 stdio 函数，IAT hook 比全局 inline patch 更容易限定影响范围。

同时把诊断日志缓冲区从 64KB 扩到 1MB，并在 heartbeat 中追加 `JSString`、`ObjectProbe`、`CRTFile`、`CRTRead` 计数，方便只看日志末尾判断新 hook 是否触发。

### 14.3 本地可完成验证

- `objdump -p games/maya/mozjs-33.dll` 已确认 6 个 SpiderMonkey 导出函数存在。
- `objdump -p games/maya/player.exe` 已确认导入 `fopen` / `fread`。
- `objdump -p games/maya/libcocos2d.dll` 已确认导入 `fopen` / `fopen_s` / `fread`。
- 当前 WSL 环境没有 `cmd.exe`、`cl` 或 `i686-w64-mingw32-gcc`，所以无法在本环境完成 MSVC 编译；需要明天在 Windows 宿主机运行 `build.bat` 做最终编译验证。

### 14.4 下一轮用户只需要做什么

在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

游戏启动后至少推进到出现第一段对白，然后把以下日志同步回来：

- `C:\Users\York\AppData\Local\player\opengametranslator_hook_diag.txt`

优先关注日志中是否出现：

- `Installed hook JS_NewStringCopyN` 等 6 个 SpiderMonkey hook。
- `CRT IAT hook summary`，以及 `[CRTFile:N]` / `[CRTRead:N]`。
- `[ObjectCommandProbe:N]`，尤其是结构体 dump 后是否出现日文或可读字符串候选。
- `[JSString:N/M]` 中是否出现实际对白或疑似对白片段。

## 15. 2026-05-18 13:58 新日志复盘

用户运行了新的 native hook DLL，`games/maya/opengametranslator_hook_diag.txt` 已同步回来。复盘结论：

### 15.1 成功项

- Windows 宿主机编译成功，`tools/hook_dll/opengametranslator_hook.dll`、`injector.exe`、`launcher.exe` 都已生成。
- CRT IAT hook 成功：
  - `player.exe!fopen`
  - `player.exe!fread`
  - `libcocos2d.dll!fopen`
  - `libcocos2d.dll!fopen_s`
  - `libcocos2d.dll!fread`
- 日志出现 `CRT IAT hook summary: installed=5`。
- CRT hook 捕获到：
  - `action_log.txt`
  - OpenGameTranslator 自身输出 JSON
  - `Resources/fonts/SourceHanSansCN-Regular.ttf`
  - `imgui.ini`
  - 未看到新的对话数据文件。

### 15.2 未命中项

- 6 个 SpiderMonkey hook 都解析到了导出地址，但被安装器跳过。原因是 `mozjs-33.dll` 的导出函数没有标准 MSVC `push ebp; mov ebp, esp` 函数前言。
- 心跳中 `JSString=0/0`，说明 JS hook 未安装，所以不能说明 JS 层没有对白，只能说明这次没有抓到。
- 心跳中 `ObjectProbe=0`，说明这次运行没有触发 `ObjectAction::execActionMessageShow`。从 `action_log.txt` 看，本次游戏运行到 13:58 正常退出，但可能没有推进到上次触发对白的位置。

### 15.3 已补代码

`tools/hook_dll/opengametranslator_hook.c` 已增加受限的 non-prologue hook 支持：

- `InlineHook` 新增 `allowNonPrologue` 标志。
- 仅 SpiderMonkey 6 个 hook 设置 `allowNonPrologue=1`。
- 新增 `GetSequentialPatchSize()`，在指定允许时顺序解码前几条 x86 指令，覆盖至少 5 字节后安装 hook。
- 若待复制指令里包含相对跳转/调用，则拒绝安装，避免复制会改变控制流的指令。

根据本次日志中的函数前几个字节，6 个 SpiderMonkey 函数都应能用该路径安装：

| 函数 | 预计 patchSize |
|------|----------------|
| `JS_NewStringCopyN` | 6 |
| `JS_NewStringCopyZ` | 6 |
| `JS_NewUCStringCopyN` | 6 |
| `JS_NewUCStringCopyZ` | 5 |
| `JS_InternString` | 6 |
| `JS_InternStringN` | 6 |

### 15.4 下一次运行要求

需要重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

这次请尽量推进到上次能出现对白的位置。日志里重点看：

- `Using non-prologue sequential patch for JS_NewStringCopyN`
- `Installed hook JS_NewStringCopyN` 等 6 个 JS hook
- `[JSString:N/M]`
- `[ObjectCommandProbe:N]`

## 16. 2026-05-18 14:03 新日志复盘与下一版准备

用户重新构建并运行后，`games/maya/opengametranslator_hook_diag.txt` 已确认上一节的 non-prologue 方案有效。

### 16.1 已确认

- 6 个 SpiderMonkey 字符串 hook 全部安装成功：
  - `JS_NewStringCopyN`
  - `JS_NewStringCopyZ`
  - `JS_NewUCStringCopyN`
  - `JS_NewUCStringCopyZ`
  - `JS_InternString`
  - `JS_InternStringN`
- 日志出现 `Using non-prologue sequential patch ...` 和 `Installed hook ...`，说明受限顺序补丁可以覆盖 `mozjs-33.dll` 这类非标准函数前言。
- `JSString=430/434`，已经能抓到 SpiderMonkey 内部创建的字符串。
- CRT I/O 仍然只看到工具输出 JSON、`action_log.txt`、字体文件和 `imgui.ini`，没有发现新的对话数据文件。
- 本次唯一含日文的 JS 字符串仍是游戏 metadata / `info.json` 类内容，没有出现剧情对白。

### 16.2 仍未命中

- 心跳里 `ObjectProbe=0`，说明本次运行没有触发 `ObjectAction::execActionMessageShow`。
- `action_log.txt` 只显示启动、`StartCanvas` 和正常退出，不能证明已经推进到旧日志里触发对白的位置。
- JS 日志被大量 Cocos/JSB 类名占满，虽然证明 hook 生效，但影响下一轮定位。

### 16.3 本轮已继续补强

`tools/hook_dll/opengametranslator_hook.c` 已追加下一轮诊断点：

1. 降低 JS 字符串日志噪音
   - 保留前 20 条作为 hook 生效证据。
   - 后续优先记录含高位字节、超大 buffer、`project.json` / `messageShow` / `textId` / `variableId` 等关键词字符串。
   - 目标是避免几百条 Cocos 类名刷爆日志。

2. 扩展 SpiderMonkey hook
   - 新增 `JS_NewUCString`
   - 新增 `JS_InternUCString`
   - 新增 `JS_InternUCStringN`
   - 新增 raw `JS_ParseJSON(JSContext*, wchar_t const*, unsigned int, ...)`

3. 扩展 AGTK 消息 UI hook
   - `ActionCommandMessageTextUi::update`
   - `ActionCommandScrollMessageTextUi::update`
   - `ActionCommandMessageTextUi::setTextGui`
   - `ActionCommandScrollMessageTextUi::setTextGui`
   - 日志前缀为 `[MessageUiProbe:N]`

4. 扩展 messageShow 数据 setter hook
   - `ObjectCommandMessageShowData::setTextId`
   - `ObjectCommandMessageShowData::setTextFlag`
   - `ObjectCommandMessageShowData::setVariableId`
   - `ObjectCommandMessageShowData::setVariableObjectId`
   - `ObjectCommandMessageShowData::setVariableQualifierId`
   - `ObjectCommandScrollMessageShowData::setTextId`
   - 日志前缀为 `[ValueHook:N]`

### 16.4 下一轮用户只需要做什么

重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

这次重点是进入能看到真实对白的位置，哪怕只出现第一句也可以。然后同步：

- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`

下一次判断优先看：

- 新增的 4 个 SpiderMonkey hook 是否安装成功。
- `[MessageUiProbe:N]` 是否出现。
- `[ValueHook:N]` 是否出现，尤其是 `setTextId` / `setVariableId` 的对象和值。
- `[ObjectCommandProbe:N]` 是否重新出现。
- `[JSString:N/M]` 是否出现真实对白或包含高位字节的短句。

## 17. 2026-05-18 14:23 肥日志复盘与下一版降噪

用户同步回来的 `opengametranslator_hook_diag.txt` 大约 333KB，说明上一版新增 hook 已经大量触发，但目前还没有直接抓到剧情对白。

### 17.1 这次确认的进展

- AGTK 消息 UI hook 安装成功：
  - `ActionCommandMessageTextUi::update`
  - `ActionCommandScrollMessageTextUi::update`
  - `ActionCommandMessageTextUi::setTextGui`
  - `ActionCommandScrollMessageTextUi::setTextGui`
- messageShow 数据 setter hook 安装成功：
  - `setTextId`
  - `setTextFlag`
  - `setVariableId`
  - `setVariableObjectId`
  - `setVariableQualifierId`
  - scroll message `setTextId`
- SpiderMonkey 新增 hook 中，`JS_NewUCStringCopyN`、`JS_NewUCStringCopyZ`、`JS_InternUCStringN`、`JS_ParseJSON-raw` 已安装；`JS_NewUCString` 和 `JS_InternUCString` 因函数开头含相对跳转/调用被安全跳过。
- JS 字符串降噪生效：心跳显示 `JSString=31/434`，只记录少量有价值样本，未再被 Cocos/JSB 类名刷爆。

### 17.2 这次仍未命中的点

- `action_log.txt` 只记录到启动、`StartCanvas` 和正常退出；没有证明这轮已经推进到旧日志中触发对白的位置。
- 心跳里 `ObjectProbe=0`，`ObjectAction::execActionMessageShow` 本轮仍未触发。
- `TextHook=0`、`TextData=0`，标准 AGTK/Cocos 文本显示/查表路径仍未出现剧情文本。
- JS 字符串里唯一明确日文仍是游戏 metadata / info 类 JSON，不是真实对白。

### 17.3 肥日志的原因

这次日志变大主要不是因为捕获到了对白，而是两个噪声源：

1. `ValueHook` setter 调用极多
   - 20 秒心跳已到 `ValueHook=950620`。
   - 50 秒心跳到 `ValueHook=991316`。
   - 这些更像对象数据初始化/常量 setter 风暴，不适合大量 dump 结构体。

2. `MessageUiProbe` 共享上限被 `setTextGui` 消耗
   - 前 80 条 Message UI 记录几乎全是 `setTextGui` 绑定记录。
   - 更值得看的 `ActionCommandMessageTextUi::update` / scroll update 没有被单独留出日志额度。

### 17.4 本轮代码已调整

`tools/hook_dll/opengametranslator_hook.c` 已做下一版诊断调整：

- `setTextGui` 改为 `[MessageUiLink:N]`，只记录 Message UI 与 `TextGui` 的绑定关系。
- `update` 改为 `[MessageUiUpdate:N/M]`，单独计数；其中 `N` 是已记录序号，`M` 是实际看到的 update 序号。
- `MessageUiUpdate` 采用“前 20 帧 + 新 UI 对象 + 每 240 次 update 抽样”的策略，避免只记录启动瞬间，也避免每帧刷爆日志。
- 记录 `setTextGui` 时缓存 `MessageUi -> TextGui` 映射；后续 `update` 会一起 dump 已知的 `TextGui` 对象。
- `ValueHook` 降噪：最多记录 300 条，只有前 5 条 dump 对象结构，避免 setter 初始化风暴吞掉日志空间。
- heartbeat 追加 `LinkLog` 和 `UpdateLog=已记录/已看到`，便于只看日志末尾判断 update 是否真的被覆盖。
- WSL 侧已通过 `git diff --check`、`bash -n tools/hook_dll/build.sh`、`npm run typecheck`、`npm run build`；native DLL 仍需 Windows 宿主机 `build.bat` 验证。

### 17.5 下一轮用户只需要做什么

重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

这轮重点仍然是进入第一句真实对白。同步回：

- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`

下一次优先看：

- `[MessageUiUpdate:N/M]` 是否出现，以及 linked `TextGui` 对象 dump 是否出现日文、文本 ID 或可疑指针。
- `[MessageUiLink:N]` 是否能稳定建立 `MessageUi -> TextGui` 映射。
- `[ObjectCommandProbe:N]` 是否重新出现。
- heartbeat 里的 `UpdateLog=已记录/已看到`、`ObjectProbe`、`JSString`。

## 18. 2026-05-18 14:33 MessageFlow 方向调整

用户重新构建并同步了新版日志，`opengametranslator_hook_diag.txt` 约 126KB。

### 18.1 新日志结论

- 新版 DLL 已成功运行，`[MessageUiLink:N]` 生效。
- heartbeat 显示 `LinkLog` 随 `MessageUi` 一起增长：
  - 20 秒：`MessageUi=765 LinkLog=765`
  - 50 秒：`MessageUi=10942 LinkLog=10942`
- heartbeat 始终显示 `UpdateLog=0/0`，说明这轮两个 `ActionCommandMessageTextUi::update(float)` 入口完全没有被调用。此前未抓到 update 不是单纯“共享日志上限被占满”，而是当前流程没有走这两个导出函数。
- `ObjectProbe=0`，`execActionMessageShow` 本轮仍未触发。
- `action_log.txt` 仍只到启动、`StartCanvas`、`DebugManager GetInstance` 和正常退出，不能证明已经进入真实对白动作。
- 唯一明确日文仍是 metadata/info JSON，不是真实对白。

### 18.2 设计调整

继续追 `update(float)` 的收益变低。下一版改为 hook 更靠近“消息动作创建并加入 GUI 管理器”的入口，目标是减少人工重复跑图成本：

- `ObjectAction::execActionScrollMessageShow`
- `GuiManager::addActionCommandMessageGui` 两个重载
- `GuiManager::addActionCommandScrollMessageGui` 两个重载
- `ActionCommandMessageTextUi::init`
- `ActionCommandScrollMessageTextUi::init`
- `ActionCommandMessageTextUi::setData`
- `ActionCommandScrollMessageTextUi::setData`

这些入口比 update 更接近消息创建/显示，理论上只在消息 UI 被创建或绑定数据时触发，噪声会比逐帧 update 小。

### 18.3 本轮代码已调整

`tools/hook_dll/opengametranslator_hook.c` 新增 `[MessageFlow:N]` 日志：

- 记录 `this`、owner object、lock object、message data 指针。
- 对 message data 按已逆向字段输出结构化摘要：
  - 普通 message：`textFlag` 位于 `+0x24`，`textId` 位于 `+0x28`，`variableObjectId` 位于 `+0x2C`，`variableQualifierId` 位于 `+0x30`，`variableId` 位于 `+0x34`。
  - scroll message：目前确认 `textId` 位于 `+0x24`。
- 前 40 条会 dump message data 前 `0x60` 字节，后续只保留结构化字段。
- heartbeat 追加 `MessageFlow` 计数。
- WSL 侧已通过 `git diff --check`、`bash -n tools/hook_dll/build.sh`、`npm run typecheck`、`npm run build`；native DLL 仍需 Windows 宿主机 `build.bat` 验证。

下一轮重点看：

- `[MessageFlow:N]` 是否出现。
- `[MessageFlow:N]` 中 `textId` / `variableId` 是否随真实对白变化。
- `[ObjectCommandProbe:N]` / `[ObjectAction::execActionScrollMessageShow]` 是否出现。
- heartbeat 中 `MessageFlow`、`ObjectProbe`、`UpdateLog` 的组合。

## 19. 2026-05-18 20:48 MessageFlow 日志复盘

用户同步了新版 `opengametranslator_hook_diag.txt`，约 188KB。结论：

- DLL 和新增 hook 均正常安装。
- heartbeat 显示 `MessageFlow` 从 0 增长到 947，说明消息流相关入口确实被频繁调用。
- 已写出的 `[MessageFlow:1..80]` 全部是 `ActionCommandMessageTextUi::setData` / `ActionCommandScrollMessageTextUi::setData`，没有看到 `GuiManager::addActionCommand...`、`init`、`execAction...`。
- `ObjectProbe=0`，`execActionMessageShow` / `execActionScrollMessageShow` 仍未触发。
- `UpdateLog=0/0`，此前两个 UI `update(float)` 入口仍没有调用。
- `action_log.txt` 仍只证明游戏启动和正常退出，不能证明这一轮已经进入真实对白动作。
- 唯一明确日文仍来自 metadata/info JSON，不是真实对白。

重要修正：之前 `[MessageFlow:N]` 直接按 `ObjectCommandMessageShowData` 偏移解析 `data` 指针，导致许多 `setData` 启动噪声被误读成 message data。比如部分对象的首 DWORD 是 Cocos/其他对象 vtable，不是 `ObjectCommandMessageShowData` vtable，因此字段摘要不可信。

### 19.1 本轮代码调整

`tools/hook_dll/opengametranslator_hook.c` 已继续降噪：

- 启动时通过 `GetProcAddress` 解析两个导出的 vtable：
  - `??_7ObjectCommandMessageShowData@data@agtk@@6B@`
  - `??_7ObjectCommandScrollMessageShowData@data@agtk@@6B@`
- `MessageFlow` 先读取 `data` 指针首 DWORD，只有 vtable 精确匹配时才按 message data 输出字段。
- 确认的 message data 记录为 `[MessageFlow:N/M]`。
- 未匹配对象只记录前 20 条 `[MessageFlowOther:N/M]`，避免日志上限被启动噪声占满。
- heartbeat 改为 `MessageFlow=seen/logged Data=confirmed Other=otherSeen` 形式，便于判断“调用很多但没有真正 message data”还是“已经抓到真实 message data”。
- 额外补充 `MessageWindowNode::create` / `MessageWindowNode::init` 的普通 message 与 scroll message 重载 hook；这些入口更靠近对话窗口创建，下一轮可辅助判断 message data 是否真正进入窗口层。

### 19.2 下一轮用户需要做什么

重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

然后尽量推进到第一句真实对白并同步：

- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`

下一轮优先看：

- 启动日志里的 `Resolved message data vtables: message=... scroll=...` 是否两个都非空。
- `[MessageFlow:N/M]` 是否出现，以及 `dataKind=messageData` / `dataKind=scrollMessageData` 的 `textId` 是否变化。
- heartbeat 的 `MessageFlow=seen/logged Data=confirmed Other=otherSeen`。
- `[ObjectCommandProbe:N]` 是否终于出现。

## 20. 2026-05-18 20:59 MessageFlow vtable 误判修正

用户同步了新版日志，`opengametranslator_hook_diag.txt` 约 137KB。结论：

- 新版 DLL 正常运行。
- `Resolved message data vtables: message=0x007D53E8 scroll=0x007D52DC` 成功输出。
- `MessageWindowNode::create-message` / `create-scroll` / `init-message` / `init-scroll` 四个 hook 均安装成功。
- heartbeat 显示 `MessageFlow=739/0 Data=0 Other=739`，即所有消息流调用都被归为 Other，没有确认 message data。
- `ObjectProbe=0`、`UpdateLog=0/0` 仍然不变。
- `action_log.txt` 仍只显示启动、`StartCanvas`、`DebugManager GetInstance` 和正常退出，不能证明已进入真实对白动作。

关键发现：

- setter hook 的真实对象首 DWORD 是 `0x007D1724`，例如：
  - `ObjectCommandMessageShowData::setTextFlag this=0x012AC7C8`
  - dump 中 `+0x00: 007D1724 ...`
- 但 `GetProcAddress("??_7ObjectCommandMessageShowData@data@agtk@@6B@")` 得到的是 `0x007D53E8`。
- 因此上一版“只匹配 PE 导出的 vtable”过严，会把真实 setter 对象也误判为非 message data。

### 20.1 本轮代码调整

`tools/hook_dll/opengametranslator_hook.c` 已继续修正：

- `ValueHook` 第一次看到 `ObjectCommandMessageShowData::...` setter 时，读取 `this+0x00` 并学习真实 observed message vtable。
- `ValueHook` 第一次看到 `ObjectCommandScrollMessageShowData::...` setter 时，读取 `this+0x00` 并学习真实 observed scroll vtable。
- `MessageFlow` 分类同时使用：
  - PE 导出的 vtable；
  - setter 运行时学到的 observed vtable。
- 对 scroll/message 的字段解释优先参考 hook label，例如 `ActionCommandScroll...` / `MessageWindowNode::...scroll` 会按 scroll data 解释。

### 20.2 下一轮用户需要做什么

重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

同步：

- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`

下一轮优先看：

- `[ValueHook] learned messageData vtable from setter` 是否出现，observed 是否接近 `0x007D1724`。
- `[ValueHook] learned scrollMessageData vtable from setter` 是否出现。
- `MessageFlow=seen/logged Data=confirmed Other=otherSeen` 中 `Data` 是否变为非 0。
- `[MessageFlow:N/M]` 是否来自 `MessageWindowNode::create/init` 或 `GuiManager::addActionCommand...`。

## 21. 2026-05-18 21:06 observed vtable 生效但仍未进入窗口层

用户同步了新版日志，`opengametranslator_hook_diag.txt` 约 142KB。结论：

- `[ValueHook] learned messageData vtable from setter` 成功出现，observed message vtable 为 `0x007D1724`。
- `[ValueHook] learned scrollMessageData vtable from setter` 成功出现，observed scroll vtable 为 `0x007D1A04`。
- 说明上一节的 observed vtable 学习逻辑生效。
- heartbeat 仍显示 `MessageFlow=1908/0 Data=0 Other=1908`。
- `MessageWindowNode::create/init` 没有调用记录。
- `GuiManager::addActionCommand...` 没有调用记录。
- `ObjectProbe=0`、`UpdateLog=0/0` 仍不变。
- `action_log.txt` 仍只显示启动、`StartCanvas`、`DebugManager GetInstance` 和正常退出，不能证明已经进入真实对白动作。

当前判断：

- `ValueHook` 大量触发仍更像 project.json 初始化/解析阶段，而不是显示阶段。
- 当前抓到的 `ActionCommandMessageTextUi::setData` 参数仍是其他对象，常见 vtable 为 `0x77B57608` / `0x007EF2B4` / `0x007F1288`，不是 observed message/scroll data。
- 需要继续确认显示阶段是否调用 message data getter，或者是否绕过了 `ActionCommandMessageTextUi` / `MessageWindowNode` 这条路径。

### 21.1 本轮代码调整

`tools/hook_dll/opengametranslator_hook.c` 已继续补充：

- 新增 `ActionCommandMessageTextUi::create` hook。
- 新增 `ActionCommandScrollMessageTextUi::create` hook。
- 新增 `ActionCommandMessageTextUi::getData` hook，调用原函数后记录返回的 data 指针。
- 新增 `ActionCommandScrollMessageTextUi::getData` hook，调用原函数后记录返回的 data 指针。
- 新增 message data getter hook：
  - `ObjectCommandMessageShowData::getTextFlag`
  - `ObjectCommandMessageShowData::getTextId`
  - `ObjectCommandMessageShowData::getVariableId`
  - `ObjectCommandMessageShowData::getVariableObjectId`
  - `ObjectCommandMessageShowData::getVariableQualifierId`
  - `ObjectCommandScrollMessageShowData::getTextId`
- 新增 `[ValueGet:N]` 日志，用于判断显示阶段是否读取 message data 字段。
- heartbeat 追加 `ValueGet` 计数。

### 21.2 下一轮用户需要做什么

重新在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\tools\hook_dll
build.bat
launcher.exe "C:\York\Works\Programming\OpenGameTranslator\games\maya\player.exe" opengametranslator_hook.dll
```

同步：

- `%LOCALAPPDATA%\player\opengametranslator_hook_diag.txt`
- `games\maya\action_log.txt`

下一轮优先看：

- `[ValueGet:N]` 是否出现，以及是否在启动后持续增长。
- `ActionCommandMessageTextUi::create` / `getData` 是否出现。
- `MessageFlow=seen/logged Data=confirmed Other=otherSeen` 中 `Data` 是否变为非 0。
- `ObjectProbe` 是否变为非 0。

## 22. 2026-05-18 21:14 暂停 native hook 主线

用户同步了新版日志，`opengametranslator_hook_diag.txt` 约 148KB。复盘结论：

- `ActionCommandMessageTextUi::create` hook 已安装。
- `ActionCommandMessageTextUi::getData` 是短 getter，当前 inline hook 安装失败：函数首字节为 `8B 81 A0 02 00 00 C3`，没有标准 prologue。
- observed vtable 学习仍正常：
  - message observed vtable：`0x007D1724`
  - scroll observed vtable：`0x007D1A04`
- heartbeat 仍显示：
  - `ValueGet=0`
  - `MessageFlow=1152/0 Data=0 Other=1152`
  - `ObjectProbe=0`
  - `UpdateLog=0/0`
- `MessageWindowNode::create/init`、`GuiManager::addActionCommand...` 仍无调用记录。
- 唯一明确日文仍是 metadata/info JSON，不是真实对白。
- `action_log.txt` 仍只证明启动和正常退出，不能证明已进入真实对白动作。

工程里存在 `ManualTransFile.json`、`DeepseekR1翻译文件.json`、`TrsData*.bin` 等外部翻译工具残留文件。用户明确说明这些文件没有用，后续不要把它们作为技术路线依据，也不要再花时间分析。

当前结论：

- 从 20:47 到 21:14 的多轮 native hook 诊断没有抓到任何一条真实对白文本。
- 已覆盖并验证失败/无命中的方向包括：Cocos 文本渲染、TextGui、TextData、SpiderMonkey 常规字符串、SQLite、文件 I/O、messageShow setter/getter、GUI/message window 创建链路。
- 继续在同一条 native hook 线上堆 hook 的收益很低，应该暂停作为主线。
- 下一步如果继续做该游戏，建议回到静态 `project.json` / `opengametranslator-structural.json` 的结构分析，先确认真实对白是否已经静态存在但被导出规则漏掉；若静态也无法定位，应考虑暂时降低该样本优先级。

## 23. 2026-05-18 变量链路追踪路线

用户明确说明：这个游戏可以不作为通用工具主线，但必须翻译。因此当前路线调整为：

- 通用主线仍优先保持非侵入式/可恢复式框架。
- `games/maya` 作为必须攻克的复杂样本单独推进。
- 暂停继续堆同类 native hook，先改为追踪 AGTK 的消息变量链路。

本轮重新核对现有输出后得到的新判断：

- `games/maya/Resources/data/project.json` 在 WSL 中不是明文 JSON，文件头为 `enc`，不能直接静态解析。
- 游戏运行时通过 `jsb.fileUtils.getStringFromFile("data/project.json")` 能拿到解密后的 JSON，所以后续静态分析应基于运行时导出的结构文件。
- 现有 `opengametranslator-extracted-texts.json` 中约 4,731 条日文候选文本，绝大多数是对象名、动作名、变量名、备注等编辑器元数据。
- 现有 `opengametranslator-structural.json` 显示：
  - `messageShow` 共 141 个；
  - `textList` 只有 8 个条目，且主要是数字/字体占位；
  - `objectsWithTextField` 为 0；
  - `messageShow` 基本走 `textFlag=false` 的变量显示路线，例如 `variableId=2124/2134/2137`。
- 旧结构文件里的消息变量计数为：`2134` 46 次、`2124` 37 次、`26` 17 次、`24` 11 次、`25` 11 次、`2137` 9 次、`2176` 5 次。
- 这些变量在现有样本中对应“玩家等级/经验值/技能点/音量”等数值或系统状态，进一步说明旧导出结果主要不是剧情对白。

因此新的重点不是“文本字段在哪里”，而是：

1. 哪些变量被 `messageShow` 显示；
2. 这些变量在哪里定义；
3. 哪些 `switchVariableChange` 或脚本命令给这些变量赋值；
4. 赋值源是否能追到真实对白。

本轮已完成代码准备：

- 新增 `tools/audit_cocos_static_text.mjs`：
  - 可审计任意可解析 JSON/运行时导出 JSON；
  - 输出 `*-static-text-audit.json` 和 `*-static-text-audit.txt`；
  - 遇到 AGTK 加密 `project.json` 时会生成 parse-failed 报告，而不是崩溃。
- 更新 `runtime/cocos2d-js/opengametranslator-probe.js`：
  - `structuralData.messageVariableIds`：记录消息窗口实际显示的变量 ID；
  - `structuralData.variableDefinitions`：导出变量定义；
  - `structuralData.switchVariableChanges`：导出变量赋值命令摘要；
  - `structuralData.messageVariableDefinitions`：筛选出消息变量对应的定义；
  - `structuralData.messageVariableAssignments`：筛选出给消息变量赋值的命令。
- 已重新执行 `install-probe games/maya player.exe`，新版 JS 探针已复制到游戏目录。
- 已执行 `verify-probe games/maya`，状态为 `Installed`。

下一次用户只需要在 Windows 宿主机运行：

```bat
cd /d C:\York\Works\Programming\OpenGameTranslator\games\maya
run-me.bat
```

进入能看到真实对白的位置后，退出游戏并同步：

- `games\maya\Resources\OpenGameTranslator\output\opengametranslator-extracted-texts.json`
- `games\maya\Resources\OpenGameTranslator\output\opengametranslator-structural.json`

下一轮优先检查新版 `opengametranslator-structural.json` 中：

- `messageVariableIds`
- `messageVariableDefinitions`
- `messageVariableAssignments`
- `switchVariableChanges`

如果 `messageVariableAssignments` 能指向赋值源，就沿变量赋值链继续做替换方案；如果仍为空，再考虑内存快照/OCR/图像字体替换等非主线路线。

## 24. 2026-05-19 对比同开发者早期作品 `Neruko_wa_Sodatsu`

### 24.1 背景

找到同开发者（しぃと）的早期作品 `Neruko_wa_Sodatsu`（2024 年初），作为对比样本。同时找到一份汉化版（`Neruko_wa_Sodatsu_汉化`），其 `libcocos2d.dll` 和 EXE 均被修改。

### 24.2 两个游戏的异同

| 项目 | Neruko（2024） | Maya（2025） |
|------|---------------|-------------|
| project.json 大小 | 39MB | 102MB |
| EXE 大小 | 8,753,152 | 8,756,736 |
| libcocos2d.dll MD5 | c3a38c0a... | 8aa1b011...（不同） |
| mozjs-33.dll MD5 | a8bfd7ab... | a8bfd7ab...（相同） |
| init.js / prepare.js MD5 | 完全相同 | 完全相同 |
| messageShow 数量 | 395 | 141 |
| textFlag=true 数量 | 1 | 0 |
| textList 条目 | 2（"100"） | 8（"999999" 等数字） |
| messageShow 用字体 | 仅 fontId 4/5（数字字体） | 仅 fontId 4（数字字体） |
| 字体数量 | 6 | 8 |
| Font 1 (font8x8) | imageFont=true, 292 字符 | imageFont=true, 292 字符 |
| Font 2 (font12x12) | imageFont=false | imageFont=true |

**相同的模式**：
- messageShow 只用于显示游戏变量（体力、等级、音量等），不用于对话
- textList 只含 UI 占位数字，不含对话文本
- 主力日文字体 Font 1（font8x8, 292 字符）相同，但没有任何 messageShow 使用它
- JS 层 setString hook 的 `displayedTexts` 均为 0
- Glyph 索引扫描均只有 `layerMoveSpeed` 假阳性（零条对话）

### 24.3 关键发现：Neruko 的对话在 `actionList[].name` 中

Neruko 的角色对话存储在 `objectList → children → actionList → name` 字段中：

```
objectList[0].children[5].children[10].actionList[1].name = "「音琉子？」"
objectList[0].children[5].children[10].actionList[7].name = "そこにねる子いる？"
objectList[0].children[5].children[10].actionList[10].name = "あらお兄ちゃん。まさかねる子"
objectList[0].children[5].children[10].actionList[16].name = "寝てるのね。じゃあいいわ"
objectList[0].children[8].children[4].actionList[1].name = "パパが不倫してる"
objectList[0].children[8].children[4].actionList[14].name = "え、知ってるの？"
```

对话与引擎模板名（"テキスト１(1)"、"消すテンプレ"、"出現テンプレ"）交替出现，构成对话序列。共 91 条对话相关文本。

**但 Maya 的 1040 个 `actionList[].name` 全部是编辑器标签**（"待機"、"オブジェクト消滅"、"メニュー総合"），没有一条角色对话。开发者在两个游戏之间改变了对话存储方式。

### 24.4 汉化版分析

汉化版的文件差异：
- `libcocos2d.dll`：8,341,823 字节不同（基本上是不同编译版本）
- EXE：不同（34,816 字节更小）
- project.json：仍然加密（`enc` 头），对话文本**仍是日文**
- img/ 图片、font/ 字体文件、JS 文件：**完全相同**
- 导出函数表：**无差异**

结论：汉化组的翻译不在 project.json 数据层面，而是在 **libcocos2d.dll 的 C++ 运行时层**做文本替换。对话渲染时 DLL 拦截日文字符串并替换为中文。

汉化版探针输出：
- `displayedTexts: 0`——对话仍不走 JS Label.setString
- candidateTexts 只多了 23 条中文文本，全部是 UI/元数据翻译
- 对话翻译发生在 JS 层之下、C++ 渲染层之中

### 24.5 对 Maya 翻译的启示

1. **同一开发者的早期作品把对话存在 project.json 中**——证明这个引擎**能够**从 JSON 字符串渲染对话
2. **汉化版证明了 DLL 级文本替换可行**——libcocos2d.dll 中存在可以拦截文本渲染的 hook 点
3. **Maya 走了不同的对话渲染路径**——后期作品可能将对话加密存储在 project.json 的二进制字段中，由 C++ 引擎直接解密为 glyph 索引
4. **下一步最可行的方向**：对比原始和汉化版 libcocos2d.dll，定位汉化组修改的函数，然后在 Maya 上 hook 同一函数

### 24.6 路线校正：Neruko 是正样本，不是必须复刻的 DLL 方案

DeepSeek 后续验证指出：Neruko 原版的对白已经在运行时解密后的 `project.json` 字符串里，所以对 Neruko 本身不需要复刻汉化组的 DLL 修改。我们现有的 JS runtime/probe 路线已经能看到这些文本。

本地复核结果：

- `output/neruko.csv` 已存在，约 2,456 条唯一文本。
- Neruko 的对白主要集中在 `actionList[].name`，并与 `テキスト１(1)`、`消すテンプレ`、`出現テンプレ` 这类动作模板交替出现。
- 典型路径：
  - `objectList.0.children.5.children.10.actionList.*.name`
  - `objectList.0.children.8.children.4.actionList.*.name`
- Maya 的 `actionList[].name` 虽然也有 1,040 条，但标点候选基本是菜单确认、编辑器备注、调试标签。
- Maya 中未发现 Neruko 的核心模板名：
  - `テキスト１`：0 条
  - `消すテンプレ`：0 条
  - `出現テンプレ`：0 条
  - 仅有 `音声テキスト` 相关 2 条，偏向 UI/对象标签。

因此现在的优先级应调整为：

1. **把 Neruko 当正样本**：用它提炼 AGTK 对话动作模板的结构特征，而不是只看文本名。
2. **在 Maya 中找结构相似的动作链**：不要只搜 `actionList[].name`，要比较父对象层级、动作序列、命令类型、对象生成/消失/文本模板相关命令。
3. **如果找到相似结构**：沿该结构里的变量、命令参数、glyph/font 相关字段继续追真实对白来源。
4. **DLL 差异对比降为备选路线**：汉化版 DLL 证明 C++ 层替换可行，但它不是 Neruko 翻译的必要路径；只有当 Maya 的结构对比仍然找不到文本来源时，再投入较重的 DLL diff/hook 定位。
