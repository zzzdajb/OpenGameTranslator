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
- x86 诊断 DLL 编译成功（`tools/hook_dll/opengametranslator_hook.dll`）
- Python 注入器遇到 WoW64 兼容性问题（`CreateToolhelp32Snapshot` 挂起）

### 8.5 待解决
- [ ] 可靠的 32-bit DLL 注入方式（Process Hacker / Cheat Engine / 修复注入器）
- [ ] 运行时 RTTI 扫描确认能定位函数
- [ ] 实现 `updateText` hook 和文本替换
