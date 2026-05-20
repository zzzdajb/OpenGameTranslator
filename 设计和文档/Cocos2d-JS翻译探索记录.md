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
| `tools/render_agtk_image_translation.py` | AGTK 图片对白 CSV 模板生成与译文 PNG 回写 |
| `tools/ocr_paddle_image_dialogue.py` | PaddleOCR 在线 OCR，填充图片对白 CSV 的 `source` 列 |
| `runtime/cocos2d-js/opengametranslator-probe.js` | JS 探针（文本提取+结构分析+图片导出） |
| `runtime/cocos2d-js/opengametranslator-image-injector.js` | JS 层图片注入（**对本游戏无效**，AGTK 不走 JS 纹理路径） |
| `runtime/cocos2d-js/opengametranslator-runtime.js` | JS 翻译运行时 |

## 11. 2026-05-20 复核记录

Codex 已在 WSL 侧做最小复核：

- `Resources/img/1394.png` 的文件头为 `enc`，确认磁盘源文件仍是加密数据。
- `Resources/OpenGameTranslator/output/decrypted-img/1394.png` 的文件头为 PNG，`file` 识别为 `1800 x 2400`、调色板图片。
- `opengametranslator-structural.json` 中 `decryptedImageExports` 数量为 122，全部 `ok = true`。
- 肉眼查看 `decrypted-img/1389.png`、`decrypted-img/1394.png`，确认图片内包含白色日文对白分片。
- 肉眼查看 `translated-img/1389.png`，确认红色测试边框和 `INJECTED` 标记存在；注入侧与文档描述一致。

因此，“Maya 正文对白是预渲染图片，并可通过运行时解密导出与 `CreateFileW` 图片替换注入处理”的判断可以作为后续开发主线。

## 12. 运行时 OCR 约束

用户已明确：**运行时 OCR 不允许作为方案**。

允许的 OCR 范围仅限离线生产流程：

- 对导出的对白图片做离线 OCR；
- 生成人工可校对的 CSV；
- 基于 CSV 和布局数据生成译文图片或外置字幕数据。

运行时不得把游戏窗口截图交给 OCR 再翻译，因为这会退化成普通外挂 OCR 翻译器。若未来做外置透明字幕窗口，运行时只能依赖以下信号：

- 已知图片切片的图像指纹或模板匹配；
- 引擎/Win32 hook 得到的资源 ID、图片名、动画帧或纹理区域；
- 预先生成的 `image_id + frame_index -> 译文` 映射。

## 13. 图片回写小闭环

已新增 `tools/render_agtk_image_translation.py`，用于验证“把中文画回原对白图片”的方案。

当前脚本能力：

- `make-template`：扫描一张解密 PNG，按 `2 x 15` 分片生成 CSV 模板；
- `prepare-batch`：批量扫描图片范围，生成统一 CSV、分片预览和 summary JSON；
- `render`：读取 CSV 的 `translation` 列，把中文写回对应分片；
- 使用 Noto CJK 字体，自动按像素宽度换行；
- 若译文在最小字号仍放不下，会用红框标记 overflow，并可输出 overflow CSV 报告；
- 默认整格清空后重绘，适合 Maya 这种黑底白字对白图。

已完成的验证命令：

```bash
uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py make-template \
  --image games/maya/Resources/OpenGameTranslator/output/decrypted-img/1389.png \
  --output-csv games/maya/Resources/OpenGameTranslator/work/image-translation-demo-1389.csv \
  --demo-text '测试译文 {image_id}-{frame_index}：这里是中文回写测试。'

uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py render \
  --csv games/maya/Resources/OpenGameTranslator/work/image-translation-demo-1389.csv \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-dir games/maya/Resources/OpenGameTranslator/translated-img \
  --image-id 1389 \
  --backup-existing
```

当前状态：

- 已生成 `Resources/OpenGameTranslator/work/image-translation-demo-1389.csv`；
- 已生成 `Resources/OpenGameTranslator/translated-img/1389.png`；
- 原红框注入测试图已备份为 `Resources/OpenGameTranslator/translated-img/1389.bak.png`；
- 用户已在 Windows 侧用 `run-with-hook.bat` 验证：游戏中成功显示 `测试译文 1389-*`，且正好对应第一部分对白。

结论：中文 PNG 回写 + `CreateFileW` 注入链路已被真实游戏画面验证。后续重点不再是证明注入可行，而是把流程扩展成可批量生产的工具链。

下一阶段主线：

1. 批量处理 `img/1389.png` ~ `img/1491.png` 的对白图片，生成统一 CSV 和分片预览图。
2. 对分片做离线 OCR，填充 CSV 的 `source` 列；运行时仍禁止 OCR。
3. 将 CSV 交给翻译流程，回填 `translation` 列。
4. 批量生成 `translated-img/*.png`，同时输出 overflow 报告和预览图。
5. 先用 Opening 和 1day 小范围验证，再扩大到全量。

## 14. 批量生产工具状态

`tools/render_agtk_image_translation.py` 已从单图 demo 扩展为 Maya 图片对白批量生产工具。

正式生产入口：

```bash
uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py prepare-batch \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue.csv \
  --preview-dir games/maya/Resources/OpenGameTranslator/work/maya-frame-preview \
  --start-image-id 1389 \
  --end-image-id 1491 \
  --summary-json games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue.summary.json
```

输出：

- `maya-image-dialogue.csv`：统一 CSV，字段为 `image_id,frame_index,source,translation,notes`；
- `maya-frame-preview/`：每个有效文本分片一张 `900 x 160` 预览图；
- `maya-image-dialogue.summary.json`：每张图片的有效分片数量和预览目录。

已验证数据：

- 范围：`1389..1491`；
- 图片数：103；
- 有效文本分片：1691；
- 预览图数量：1691。

全范围 demo 渲染验证：

```bash
uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py prepare-batch \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-demo.csv \
  --preview-dir games/maya/Resources/OpenGameTranslator/work/maya-frame-preview-demo \
  --start-image-id 1389 \
  --end-image-id 1491 \
  --demo-text '批量验证 {image_id}-{frame_index}' \
  --summary-json games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-demo.summary.json

uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py render \
  --csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-demo.csv \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-dir games/maya/Resources/OpenGameTranslator/output/maya-rendered-img-demo \
  --overflow-report games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-demo.overflow.csv
```

验证结果：

- demo CSV 行数：1692（含表头）；
- demo 预览图：1691；
- demo 渲染输出：103 张 `1800 x 2400` RGB PNG；
- 正常参数下 overflow：0；
- 另用非生产参数 `--rows 240` 强制触发过 overflow，报告通道可用。
- `--help` / `prepare-batch --help` / `render --help` 通过；
- `py_compile` 通过；
- `git diff --check` 通过，仅有既有 CRLF 提示。

下一步进入 OCR/翻译生产阶段：离线 OCR 填 `source`，翻译工具或 LLM 填 `translation`，再用 `render` 输出 `translated-img/*.png`。

## 15. PaddleOCR 在线 OCR 接入

新增 `tools/ocr_paddle_image_dialogue.py`，用于把在线 OCR 结果回填到 `maya-image-dialogue.csv`。

设计约束：

- token 只从 `PADDLEOCR_TOKEN` 环境变量读取；
- token 不进入代码、文档或输出产物；
- 运行时游戏仍然不做 OCR；
- OCR 只用于离线生产 CSV。

处理方式：

1. 上传整张 `1800 x 2400` 解密对白图；
2. 读取 OCR 返回的文字 polygon；
3. 按坐标映射回 `2 x 15` 分片；
4. 将每个分片内的多行文字按从上到下、从左到右合并；
5. 写入 CSV 的 `source` 列；
6. 原始 JSONL 缓存到 `work/paddle-ocr-cache/`。

单图样本验证：

```bash
PADDLEOCR_TOKEN=... uv --cache-dir /tmp/uv-cache run tools/ocr_paddle_image_dialogue.py \
  --input-csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue.csv \
  --output-csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-ocr-smoke.csv \
  --sheet-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --cache-dir games/maya/Resources/OpenGameTranslator/work/paddle-ocr-cache \
  --image-id 1389 \
  --summary-json games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-ocr-smoke.summary.json \
  --poll-seconds 2
```

验证结果：

- `1389.png` OCR 文本线：69；
- 成功映射分片：30；
- 成功填充 `source`：30；
- 输出：`maya-image-dialogue-ocr-smoke.csv`；
- 缓存：`paddle-ocr-cache/1389.jsonl`。

全量 OCR 命令会上传 `1389..1491` 共 103 张对白图到第三方服务。当前环境策略要求在用户明确理解并确认该上传风险后，才能继续由 Codex 发起全量 OCR。

用户确认后，已完成全量 OCR：

- 输入：`Resources/OpenGameTranslator/work/maya-image-dialogue.csv`；
- 输出：`Resources/OpenGameTranslator/work/maya-image-dialogue-ocr.csv`；
- summary：`Resources/OpenGameTranslator/work/maya-image-dialogue-ocr.summary.json`；
- 原始缓存：`Resources/OpenGameTranslator/work/paddle-ocr-cache/*.jsonl`；
- 图片数：103；
- OCR 缓存文件：103；
- 自动填充 `source`：1685；
- OCR 漏识别短句：6；
- 人工补录后最终 `source` 填充：1691 / 1691；
- 空 `source`：0。

人工补录的 6 条：

| image_id | frame_index | source |
|----------|-------------|--------|
| `1418` | `18` | `そう言いながら、` |
| `1420` | `26` | `――だけだった。` |
| `1447` | `18` | `そう言いながら、` |
| `1449` | `26` | `――だけだった。` |
| `1476` | `18` | `そう言いながら、` |
| `1478` | `26` | `――だけだった。` |

人工补录预览图：

- `Resources/OpenGameTranslator/work/maya-ocr-missing-preview.png`

下一步翻译/回写命令模板：

```bash
uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py render \
  --csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-ocr.csv \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-dir games/maya/Resources/OpenGameTranslator/translated-img \
  --overflow-report games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-translation.overflow.csv
```

注意：执行上述命令前，必须先填充 `translation` 列；否则 `render` 会跳过空译文。

## 16. 全量翻译完成（2026-05-20 定稿）

### 16.1 生产流程（最终）

```
解密导出 PNG (122张)
  → prepare-batch 分片 → 1691 文本帧
    → PaddleOCR 离线提取日文原文 → source 列
      → 翻译引擎填 translation 列
        → render 回写中文到分片
          → CreateFileW hook 注入替换
```

### 16.2 产物清单

| 产物 | 路径 | 数量 |
|------|------|------|
| 解密原图 | `output/decrypted-img/` | 122 张 |
| OCR CSV | `work/maya-image-dialogue-ocr.csv` | 1691 行 |
| 翻译 CSV | `work/maya-image-dialogue-ocr_translated.csv` | 1691 行 |
| 译文 PNG | `translated-img/` | 103 张 (1389-1491) |
| Overflow 报告 | `work/maya-image-dialogue-translation.overflow.csv` | 0 条 |

### 16.3 渲染命令

```bash
uv --cache-dir /tmp/uv-cache run tools/render_agtk_image_translation.py render \
  --csv games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-ocr_translated.csv \
  --decrypted-dir games/maya/Resources/OpenGameTranslator/output/decrypted-img \
  --output-dir games/maya/Resources/OpenGameTranslator/translated-img \
  --font "C:/Windows/Fonts/SourceHanSerifSC-Regular.otf" \
  --overflow-report games/maya/Resources/OpenGameTranslator/work/maya-image-dialogue-translation.overflow.csv
```

### 16.4 难度评估

Maya 在 ADV/视觉小说类型中属于极高难度，但非究极：

**已克服的难点：**
- 对话文本不在任何数据文件中（构建时烘焙为像素）
- XXTEA 加密（密钥仅在 C++ 二进制中）
- AGTK 引擎完全绕过 Cocos2d-JS 文本管线（JS hook 全无效）
- 不通过 CRT stdio（必须沉到 kernel32 `CreateFileW`）
- 需要离线 OCR + 图片渲染回写双流水线

**未触及的更难形态：**
- 网络串流文本（服务端下发，本地无完整数据）
- 资源完整性校验（替换后自检失败/崩溃）
- 代码虚拟化混淆（hook 目标函数不可识别）
- 硬件绑定加密（密钥依赖设备指纹）

**核心教训**：AGTK 引擎每层抽象都比预期低一级——JS→C++ binding→CRT→Win32 API。今后同类游戏直接沉到 `CreateFileW`，跳过中间层探测。

## 17. 触摸场景闪退修复（2026-05-21）

### 17.1 故障现象

对话场景正常，进入触摸（互动）场景后游戏闪退。Event Viewer 报 `c0000005`（访问违例）在 `player.exe+9ec73`。

### 17.2 排错过程

前 7 轮在错误方向上穷举：
- inline hook → IAT hook → 简化 detour → 删 `execActionMessageShow` → 全删 AGTK hook（存活）→ 逐组加回

极简版（仅 `CreateFileW` IAT hook）存活后，二分排除定位到 `TextGui::getString`。

### 17.3 根因

`TextGui::getString` 使用 CALL-based inline hook（因为返回 `std::string` 需要隐藏指针）。CALL 补丁在栈上多压了一个返回地址，导致 `hidden_ptr` 偏移从 `[esp+12]` 变为 `[esp+16]`。detour 未考虑这一偏移，读到的是游戏代码地址，当作 `std::string*` 使用，污染了 `esi`/`ebx`（调用者保存寄存器）。触摸场景加载资源时使用了被污染的寄存器 → 访问违例。

### 17.4 修复

移除 `TextGui::getString` hook（诊断用途，非翻译功能所需）。保留其余 6 个 AGTK hook + CRT hook + heartbeat + `CreateFileW` IAT hook。

### 17.5 教训

**严禁穷举式排错。** 本次根因是静态代码 bug——读一遍 detour 代码即可发现栈偏移错误。Event Viewer 的 `c0000005` + 崩溃日志的 `img/262.png` 已经足够推理。该教训已写入 `AGENTS.md`/`CLAUDE.md`/`代码要求.md`：debug 硬上限 3 轮，静态分析优先，每次改动必须有可证伪假设。
