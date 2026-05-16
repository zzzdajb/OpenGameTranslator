# OpenGameTranslator

OpenGameTranslator 是一个开源游戏翻译辅助工具。它从本地游戏中提取文本，生成适合外部翻译工具或 LLM 使用的 CSV，再把译文打包成游戏运行时可读取的本地翻译包。

当前 MVP 已跑通 TyranoScript 游戏《背信少女》：提取、翻译 CSV 修复、打包、托管安装、备份还原和一键启动。

## 设计原则

- 不内置翻译 API，不自动调用在线翻译服务。
- 不提交、不分发商业游戏资源。
- 普通用户不手动编辑游戏文件。
- 首选非侵入式运行；如果实现成本明显更高，允许工具自动做可溯源、可恢复的托管修改。
- 托管修改必须有备份、manifest 和还原入口。

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

检测游戏：

```bash
npm run dev -- detect "games/背信少女25.1.28补"
```

提取 CSV：

```bash
npm run dev -- extract "games/背信少女25.1.28补" output/perfedygirl.csv
```

如果翻译工具把译文覆盖到了第一列，恢复成标准双列 CSV：

```bash
npm run dev -- repair output/perfedygirl.csv output/perfedygirl_translated.csv output/perfedygirl.repaired.csv
```

校验并构建翻译包：

```bash
npm run dev -- validate output/perfedygirl.repaired.csv
npm run dev -- build output/perfedygirl.repaired.csv output/perfedygirl.package.json
```

为《背信少女》生成托管安装：

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

## 目录结构

```text
src/
    cli/        CLI 入口
    core/       引擎无关的 CSV、校验、打包逻辑
    engines/    具体游戏引擎适配器
runtime/
    tyrano/     TyranoScript 运行时 hook
games/          本地游戏文件，已忽略
output/         本地提取和构建输出，已忽略
设计和文档/     设计记录和 Windows 使用说明
```

## 更多文档

- [开工记录](./设计和文档/开工记录.md)
- [Windows 托管安装说明](./设计和文档/Windows托管安装说明.md)
- [TyranoScript Runtime 说明](./runtime/tyrano/README.md)

## 后续计划

- 扩大《背信少女》实机测试范围：菜单、存读档、回想、后期路线等。
- 补充更严格的控制码和占位符校验。
- 根据漏翻样本继续补 TyranoScript 提取和 runtime hook 规则。
- 为 RPG Maker MV/MZ 复用托管安装框架。
- 后续再评估非侵入式 launcher。
