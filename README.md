# OpenGameTranslator

OpenGameTranslator 是一个开源游戏翻译辅助工具。它负责从本地游戏中提取可翻译文本，生成适合外部翻译工具或 LLM 使用的 CSV，再把译文打包成运行时可以读取的本地翻译包。

当前项目处于早期 MVP 阶段，第一条已跑通的链路是 TyranoScript 游戏。

## 项目边界

本项目做：

- 检测本地游戏引擎。
- 提取可翻译文本。
- 导出两列 CSV：`原文`、`译文`。
- 校验 CSV 基础结构。
- 兼容部分翻译工具“把译文覆盖到第一列”的输出方式。
- 构建运行时翻译包。
- 提供 TyranoScript runtime hook，让游戏运行时显示译文。

本项目不做：

- 不内置翻译 API。
- 不自动调用在线翻译服务。
- 不提交、不分发商业游戏资源。
- 不默认破坏性修改游戏源文件。

## 当前状态

已实现命令：

- `detect`：检测游戏引擎。
- `extract`：提取文本并生成 CSV。
- `validate`：校验标准双列 CSV。
- `repair`：把“第一列被译文覆盖”的工具输出恢复成标准双列 CSV。
- `build`：构建 runtime 翻译包。

当前 TyranoScript runtime 已覆盖：

- 正文消息：`tyrano.plugin.kag.tag.text.showMessage`
- 常见文本参数：`ptext.text`、`mtext.text`、`glink.text`、`button.hint`、`chara_new.jname`

当前已经完成一次 Windows 游戏内短测：runtime 注入后，翻译显示正常，未发现明显问题。

## 环境要求

- Node.js 20 或更高版本。
- npm。

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

类型检查：

```bash
npm run typecheck
```

## 基本工作流

把本地游戏放进 `games/` 目录。实际游戏文件会被 `.gitignore` 忽略，不会提交到仓库。

检测游戏引擎：

```bash
npm run dev -- detect "games/背信少女25.1.28补"
```

提取翻译 CSV：

```bash
npm run dev -- extract "games/背信少女25.1.28补" output/perfedygirl.csv
```

如果你的翻译工具正常填写第二列，直接校验并构建：

```bash
npm run dev -- validate output/perfedygirl.csv
npm run dev -- build output/perfedygirl.csv output/perfedygirl.package.json
```

如果你的翻译工具把译文覆盖到了第一列，先恢复标准双列 CSV：

```bash
npm run dev -- repair output/perfedygirl.csv output/perfedygirl_translated.csv output/perfedygirl.repaired.csv
npm run dev -- validate output/perfedygirl.repaired.csv
npm run dev -- build output/perfedygirl.repaired.csv output/perfedygirl.package.json
```

## Windows 游戏内安装

TyranoScript runtime 的手动安装流程见：

- [Windows 手动安装说明](./设计和文档/Windows手动安装说明.md)
- [TyranoScript Runtime 说明](./runtime/tyrano/README.md)

简要来说，需要把下面两个文件放进游戏目录：

```text
resources/app.asar/data/others/opengametranslator-runtime.js
resources/app.asar/data/others/opengametranslator.package.json
```

然后在 `resources/app.asar/index.html` 中的 `kag.tag.js` 后面加载 runtime。

## 目录结构

```text
src/
    cli/        CLI 入口
    core/       引擎无关的 CSV、校验、打包等逻辑
    engines/    具体游戏引擎适配器
runtime/
    tyrano/     TyranoScript 运行时 hook
games/          本地游戏文件，已忽略
output/         本地提取和构建输出，已忽略
设计和文档/     设计记录、开工记录和手动安装说明
```

## 开发说明

项目代码偏新手友好，优先使用清晰的 `class`、`interface`、显式返回类型和严格 TypeScript 配置。注释只解释关键思路，不逐行解释。

更多开发上下文见：

- [开工记录](./设计和文档/开工记录.md)
- [初始化设计](./设计和文档/初始化.txt)

## 后续计划

- 扩大 Windows 实机测试范围：菜单、存读档、回想、后期路线等。
- 补充更严格的控制码和占位符校验。
- 根据漏翻样本继续补 TyranoScript 提取和 runtime hook 规则。
- 增加单元测试和样例 fixtures。
- 后续再评估是否提供自动安装或补丁生成流程。
