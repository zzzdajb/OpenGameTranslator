# Cocos2d-JS / AGTK 翻译探索记录

本文档记录 `games/maya`（AGTK + Cocos2d-JS v3.15 JSB）翻译方案探索的结论和关键事实。详细过程见 git log。

## 1. 引擎概况

| 项目 | 事实 |
|------|------|
| 引擎 | AGTK + Cocos2d-JS v3.15 JSB（SpiderMonkey mozjs-33） |
| 加密 | Cocos2d-x `enc` 格式（XXTEA），密钥通过 C++ `FileUtils::setEncryptKeyString` 设置 |
| 数据文件 | `Resources/data/project.json`（加密，97-102MB） |
| 字体 | 8 个字体定义，主力 Font 1（font8x8）`imageFontFlag=true`，292 字符 letterLayout |
| 对比样本 | Neruko_wa_Sodatsu（同开发者 2024 年作品），对话在 `actionList[].name` 中 |

## 2. 已验证可行的部分

- **窗口标题/UI 标签翻译**：`project.json` 中静态字符串 → `getStringFromFile` 读取 → 翻译 → 写回明文 JSON
- **工程文本提取**：探针扫描 project.json 字符串值，4742 条日文文本（对象名、动作名、变量名）
- **图片解密导出**：`getDataFromFile()` + `writeDataToFile()` 成功导出 122 张明文 PNG

## 3. 已排除的假设

| 假设 | 验证方法 | 结论 |
|------|---------|------|
| 对话在 project.json 字符串中 | 穷举扫描 25.5 万条字符串 | 全是编辑器元数据 |
| 对话在 project.json 数值数组中 | 分析 14 万数组，尝试所有编码+字形索引解码 | 全是坐标/颜色/action ID |
| 对话在 project.json 脚本字段中 | 分析 1,414 个 assignScript/javaScript | 全是变量赋值公式 |
| 对话在 JSON 后二进制段中 | 文件大小分析，CRT fopen/fread hook | 大小差异可完全由 JSON 空白解释 |
| 对话在独立数据文件中 | 探针文件追踪 + CreateFileW/A hook | 仅图片文件 |
| 对话在 DLL/EXE 嵌入资源中 | 搜索所有二进制文件字节序列 | 未命中 |
| 对话在 SQLite 数据库中 | sqlite3 系列 hook | 仅存档 KV 存储 |
| 对话在 MTool/DeepseekR1 提取中 | 交叉验证 | 全是编辑器元数据 |
| 对话经过 Cocos2d 文本渲染管线 | Label::setString 等 11 个 hook | 仅捕获 "0"/"1" |
| 对话经过 AGTK TextGui 管线 | updateText/updateTextRender/getString/getText | 仅捕获 "0"/"1" |
| 对话经过 SpiderMonkey JS 字符串 | JS_NewStringCopyN 等 8 个 hook | 无对白 |
| 对话经过 AGTK 消息 UI 层 | MessageTextUi/MessageWindow 等 16 个 hook | setData 频繁调用但无文本内容 |
| textList 包含对话 | 8 条全为数字占位（"999999"等） | 无对话 |
| messageShow 包含对话 | 141 个，全部 textFlag=false, textId=-1 | 仅显示数值变量 |

## 4. C++ Hook DLL 诊断总结

在 `tools/hook_dll/opengametranslator_hook.c` 中实现了 35+ inline hook，覆盖：

- **AGTK 文本层**：TextGui::updateText/updateTextRender, TextData::getText, ProjectData::getExpandedText, ObjectAction::execActionMessageShow, TextGui::getString
- **AGTK 消息 UI 层**：ActionCommandMessageTextUi/ScrollMessageTextUi 的 update/create/init/setData/getData/setTextGui, GuiManager::addActionCommandMessageGui, MessageWindowNode::create/init
- **AGTK 数据层**：ObjectCommandMessageShowData 的 setTextId/setTextFlag/setVariableId 等 getter/setter
- **Cocos2d 文本渲染**：Texture2D::initWithString, Label/LabelBMFont/LabelTTF/LabelAtlas::setString, ui::Text/ui::TextBMFont::setString/setText, FontManager::createOrSetWithFontData, TextLineNode::create/init
- **SpiderMonkey JS**：JS_NewStringCopyN/Z, JS_NewUCStringCopyN/Z, JS_NewUCString, JS_InternString/N/UCString/UCStringN, JS_ParseJSON
- **文件 I/O**：CreateFileW/A, CRT fopen/fopen_s/fread (IAT hook)
- **SQLite**：sqlite3_open/prepare_v2/step/exec/column_text/column_text16

**最终结论**：21 个 core hook 安装成功，对话期间仅 `updateText` 和 `Label::setString` 被触发（捕获 "0"/"1"），无任何文本管线被真实对话文本经过。对话不通过标准 AGTK/Cocos2d 文本渲染路径。

工具链：`launcher.exe`（CREATE_SUSPENDED + 注入 + ResumeThread）、`injector.exe`、内存扫描器（scan_dialogue.py, quick_scan.py）、JS 结构探针。

## 5. Neruko 对比分析

同开发者早期作品 Neruko_wa_Sodatsu（2024）作为正样本：

| 项目 | Neruko (2024) | Maya (2025) |
|------|---------------|-------------|
| project.json | 39MB | 102MB |
| 对话位置 | **actionList[].name** | **预渲染图片** |
| 对话模板 | テキスト１/消すテンプレ/出現テンプレ | 不存在 |
| 文本系统 | テキスト表示/次のテキストへ | テキストフィールド表示/アニメーション変数＋１ |
| messageShow | 395 个 | 141 个 |
| imageFontFlag | Font 1 为 true | Font 1 为 true |

Neruko 对话在 `actionList[].name` 中明码存储（如 `"パパが不倫してる"`），与模板交替构成对话序列。Maya 的 1040 条 action name 全是编辑器标签。

Neruko 汉化版分析：`libcocos2d.dll` 被修改，翻译在 C++ 运行时层完成，不在 project.json 数据层。

## 6. 对话图片定位（突破）

通过 Neruko 正样本的结构对比，Maya 的高可信文本系统组集中在：
- `objectList[14].children[0]`：Opening
- `objectList[13].children[*]`：1day ~ エンディング

这些组共用 **`animationId = 249`**，动画名为 **`セリフ`**（对白），包含：
- 96 个资源，39 个 motion
- 每个资源 2×15 分片，每帧 900×160
- 图片文件：`img/1389.png` ~ `img/1491.png`（103 张），按角色分组（e真面目、e内気、e陽気、e触ない、eエンディング、e出だし）
- 磁盘文件为 `enc` 加密格式

## 7. 图片解密导出

修复探针字段名 bug（AGTK 资源用 `image` 非 `imageId`）后，通过 `getDataFromFile()` + `writeDataToFile()` 成功导出：

- **122 张 PNG 全部解密成功**
- 1800×2400 调色板模式，2×15 分片，每帧 900×160
- 无 PNG 文本元数据块（`formatHint: "PNG"`）
- 肉眼确认：部分帧含白色日文对话文字

## 8. 注入路径验证（2026-05-20 突破）

### 8.1 JS 层 Hook 失败

| Hook 点 | 结果 |
|---------|------|
| `jsb.fileUtils.getDataFromFile` | 仅拦截 JS 调用，引擎纹理加载不走 JS |
| `cc.loader.loadImg` | 0 次调用 |
| `cc.TextureCache._addImage` (C++ binding) | 0 次调用 |
| `cc.TextureCache._addImageAsync` (C++ binding) | 0 次调用 |

**结论**：AGTK 引擎在 C++ 侧直接调用 `TextureCache::addImage`，完全绕过所有 JS 层入口。

### 8.2 CRT `fopen` Hook 失败

IAT hook 拦截了 168 次 `fopen` 调用，其中 **0 次是游戏读取 PNG**。全部是探针的写入操作（`mode=wb`）。

**结论**：Cocos2d-x Windows 版不使用 CRT `fopen` 读文件，使用 Win32 `CreateFileW` API。

### 8.3 `CreateFileW` Hook 成功

在 `kernel32.dll` 的 `CreateFileW` 上安装 inline hook，添加重定向逻辑：
- 检测到 `.png` 文件路径 → 查找 `translated-img/<basename>` 替换文件
- 若替换文件存在 → 返回替换文件的 `HANDLE`
- 用重入守卫（`g_inFileHook`）避免 `FlushLog` 递归

**验证结果**：游戏对话中出现红色标记边框（标记在 1389-1395.png 上的测试注入），证明注入流水线完整可行。

### 8.4 注入架构

```
游戏请求 img/1389.png
  → CreateFileW("C:\...\Resources\img\1389.png")
    → DetourCreateFileW hook 拦截
      → 检测 translated-img/1389.png 存在
        → CreateFileW(替换路径) → 返回替换 HANDLE
          → 游戏读取明文 PNG 数据 → 正常渲染
```

## 9. 当前结论

- **提取路径已打通**：运行时解密 → 导出 PNG（122 张）→ 逐帧 OCR 提取原文
- **注入路径已验证**：`CreateFileW` inline hook + `translated-img/` 替换图片，红色标记测试通过
- **译文图片无需加密**：引擎对非 `enc` 头文件直接放行
- **project.json 中无对话文本**——开发者在构建时将文字烘焙到图片，原始文本不在运行时产物中
- **JS 层 hooks 对本游戏无效**——图像加载全程在 C++/Win32 层完成

## 10. 工具清单

| 工具 | 用途 |
|------|------|
| `tools/hook_dll/` | C++ inline hook DLL（AGTK 文本诊断 + CreateFileW 图片注入）、注入器、启动器 |
| `tools/scan_dialogue.py` / `quick_scan.py` | 内存日文字符串扫描 |
| `tools/analyze_project_json.py` | project.json 静态结构分析 |
| `tools/analyze_agtk_focused_text_system.mjs` | AGTK 焦点文本系统分析 |
| `tools/compare_agtk_action_groups.mjs` | Neruko/Maya actionGroup 结构对比 |
| `tools/audit_cocos_static_text.mjs` | Cocos 游戏静态文本审计 |
| `runtime/cocos2d-js/opengametranslator-probe.js` | JS 探针（文本提取+结构分析+图片导出） |
| `runtime/cocos2d-js/opengametranslator-image-injector.js` | JS 层图片注入（**对本游戏无效**，AGTK 不走 JS 纹理路径） |
| `runtime/cocos2d-js/opengametranslator-runtime.js` | JS 翻译运行时 |
