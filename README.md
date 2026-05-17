# OpenGameTranslator

OpenGameTranslator 是一个开源游戏翻译辅助工具。它从本地游戏中提取文本，生成适合外部翻译工具或 LLM 使用的 CSV，再把译文打包成游戏运行时可读取的本地翻译包。

当前 MVP 优先验证 TyranoScript；《背信少女》只是当前代表验证游戏，不是项目的专用目标。

## 设计原则

- 不内置翻译 API，不自动调用在线翻译服务。
- 不提交、不分发商业游戏资源。
- 普通用户不手动编辑游戏文件。
- 首选非侵入式运行；如果实现成本明显更高，允许工具自动做可溯源、可恢复的托管修改。
- 托管修改必须有备份、manifest 和还原入口。

## 引擎支持

| 引擎 | 当前状态 | 代表验证游戏 | 已有能力 | 备注 |
| --- | --- | --- | --- | --- |
| TyranoScript | MVP 已支持 | 《背信少女》 | 检测、文本提取、CSV 修复、翻译包构建、runtime hook、托管安装/还原 | 当前主线 |
| RPG Maker MV | 计划支持 | 待定 | 尚未实现 | 优先复用 CSV、打包和托管安装框架 |
| RPG Maker MZ | 计划支持 | 待定 | 尚未实现 | 与 MV 类似，但需要单独验证数据结构和 runtime |
| Cocos2d-JS v3.15 JSB 原生版 | 运行时导出已验证 | `games/maya` 本地样本 | 检测、运行时导出、导出 JSON 转 CSV、翻译包 runtime 替换、托管安装/还原 | 离线静态 extract 暂不做，主线是启动游戏后资源级导出 |

## 当前能力

CLI 命令：

- `detect`：检测游戏引擎。
- `extract`：提取文本到双列 CSV。
- `validate`：校验标准双列 CSV。
- `repair`：把“第一列被译文覆盖”的翻译工具输出恢复成标准双列 CSV。
- `build`：构建 runtime 翻译包。
- `install`：为 TyranoScript 游戏生成托管 patch、工作目录和 bat 脚本。
- `verify-install`：校验托管安装状态。
- `uninstall`：用备份还原原文件。
- `cocos-export-csv`：把 Cocos2d-JS 运行时导出的 JSON 转成双列 CSV。
- `install-cocos`：为 Cocos2d-JS 游戏安装 runtime 翻译包。
- `verify-cocos`：校验 Cocos2d-JS 翻译安装状态。
- `uninstall-cocos`：还原 Cocos2d-JS 翻译安装修改。
- `install-probe`：为 Cocos2d-JS 游戏安装 runtime 探针。
- `verify-probe`：校验 Cocos2d-JS 探针安装状态。
- `uninstall-probe`：还原 Cocos2d-JS 探针修改。

TyranoScript runtime 当前覆盖：

- `tyrano.plugin.kag.tag.text.showMessage`
- `ptext.text`
- `mtext.text`
- `glink.text`
- `button.hint`
- `chara_new.jname`

## 环境要求

- Node.js 20 或更高版本。
- npm。

```bash
npm install
npm run typecheck
npm run build
```

## 基本流程

把本地游戏放进 `games/`。实际游戏文件已被 `.gitignore` 忽略。

通用流程：

```bash
npm run dev -- detect "<game-path>"
npm run dev -- extract "<game-path>" output/game.csv
npm run dev -- validate output/game.csv
npm run dev -- build output/game.csv output/game.package.json
```

如果翻译工具把译文覆盖到了第一列，先恢复成标准双列 CSV：

```bash
npm run dev -- repair output/game.csv output/game_translated.csv output/game.repaired.csv
npm run dev -- validate output/game.repaired.csv
npm run dev -- build output/game.repaired.csv output/game.package.json
```

TyranoScript 代表游戏示例：

```bash
npm run dev -- detect "games/背信少女25.1.28补"
npm run dev -- extract "games/背信少女25.1.28补" output/perfedygirl.csv
npm run dev -- repair output/perfedygirl.csv output/perfedygirl_translated.csv output/perfedygirl.repaired.csv
npm run dev -- validate output/perfedygirl.repaired.csv
npm run dev -- build output/perfedygirl.repaired.csv output/perfedygirl.package.json
```

TyranoScript 托管安装示例：

```bash
npm run dev -- install "games/背信少女25.1.28补" output/perfedygirl.package.json perfedygirl01.exe
npm run dev -- verify-install "games/背信少女25.1.28补"
```

安装后，游戏目录里会生成：

```text
run-me.bat
restore-original.bat
OpenGameTranslator/
    manifest.json
    opengametranslator.package.json
    runtime/
    backups/
```

Windows 用户双击 `run-me.bat` 启动汉化版；需要还原时双击 `restore-original.bat`，或运行：

```bash
npm run dev -- uninstall "games/背信少女25.1.28补"
```

Cocos2d-JS 运行时导出示例：

```bash
npm run dev -- detect "games/maya"
npm run dev -- install-probe "games/maya" player.exe
npm run dev -- verify-probe "games/maya"
```

安装后，Cocos2d-JS 游戏目录会生成：

```text
run-me.bat
restore-original.bat
Resources/
    OpenGameTranslator/
        manifest.json
        runtime/
        backups/
        output/
```

在 Windows 中双击 `run-me.bat` 启动游戏后，运行时导出会尝试写出：

```text
Resources/OpenGameTranslator/output/opengametranslator-loader.json
Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json
```

导出后转成标准双列 CSV：

```bash
npm run dev -- cocos-export-csv "games/maya/Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json" output/maya.csv
```

翻译 CSV 后，构建并安装 Cocos2d-JS runtime 翻译包：

```bash
npm run dev -- validate output/maya.translated.csv
npm run dev -- build output/maya.translated.csv output/maya.package.json
npm run dev -- install-cocos "games/maya" output/maya.package.json player.exe
npm run dev -- verify-cocos "games/maya"
```

`install-cocos` 不会改 `Resources/data/project.json` 源文件，而是在游戏读取 `data/project.json` 时用本地翻译包替换内存中的字符串值。需要还原时运行：

```bash
npm run dev -- uninstall-cocos "games/maya"
```

## 目录结构

```text
src/
    cli/        CLI 入口
    core/       引擎无关的 CSV、校验、打包逻辑
    engines/    具体游戏引擎适配器
runtime/
    tyrano/     TyranoScript 运行时 hook
    cocos2d-js/ Cocos2d-JS 运行时导出和翻译 hook
games/          本地游戏文件，已忽略
output/         本地提取和构建输出，已忽略
设计和文档/     设计记录和 Windows 使用说明
```

## 更多文档

- [开工记录](./设计和文档/开工记录.md)
- [Windows 托管安装说明](./设计和文档/Windows托管安装说明.md)
- [TyranoScript Runtime 说明](./runtime/tyrano/README.md)
- [Cocos2d-JS Runtime 说明](./runtime/cocos2d-js/README.md)

## 后续计划

- 扩大 TyranoScript 实机测试范围：菜单、存读档、回想、后期路线等。
- 补充更严格的控制码和占位符校验。
- 根据漏翻样本继续补 TyranoScript 提取和 runtime hook 规则。
- 在 Windows 上运行新版 Cocos2d-JS 导出，确认 `opengametranslator-extracted-texts.json` 是否不再触发扫描上限。
- 为 RPG Maker MV/MZ 复用托管安装框架。
- 后续再评估非侵入式 launcher。
