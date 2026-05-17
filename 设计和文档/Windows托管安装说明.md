# Windows TyranoScript 托管安装说明

这份说明记录 TyranoScript 游戏的 Windows 托管安装方式。《背信少女》是当前代表验证游戏，用于展示命令格式。

普通用户不需要手动编辑 `index.html`；由工具自动备份、修改、生成 manifest，并提供还原入口。

## 1. 准备翻译包

如果外部翻译工具把译文覆盖到了第一列，先恢复标准双列 CSV：

```bash
npm run dev -- repair output/perfedygirl.csv output/perfedygirl_translated.csv output/perfedygirl.repaired.csv
```

校验并构建 runtime 翻译包：

```bash
npm run dev -- validate output/perfedygirl.repaired.csv
npm run dev -- build output/perfedygirl.repaired.csv output/perfedygirl.package.json
```

## 2. 生成托管安装

通用命令：

```bash
npm run dev -- install "<game-path>" <translation-package> <game-exe-name>
npm run dev -- verify-install "<game-path>"
```

《背信少女》示例：

```bash
npm run dev -- install "games/背信少女25.1.28补" output/perfedygirl.package.json perfedygirl01.exe
npm run dev -- verify-install "games/背信少女25.1.28补"
```

工具会在游戏目录生成：

```text
run-me.bat
restore-original.bat
OpenGameTranslator/
    manifest.json
    opengametranslator.package.json
    runtime/tyrano/opengametranslator-runtime.js
    backups/resources__app.asar__index.html.bak
```

## 3. 启动和还原

启动汉化版：

```text
run-me.bat
```

还原原文件：

```text
restore-original.bat
```

也可以用 CLI 还原：

```bash
npm run dev -- uninstall "games/背信少女25.1.28补"
```

## 4. 当前边界

- 当前实现属于托管式可恢复修改，不是严格非侵入式。
- 用户不需要手动修改游戏文件。
- 工具会备份 `resources/app.asar/index.html`。
- manifest 记录原文件 hash、patch 后 hash、备份路径和启动 exe。
- 后续如果非侵入式 launcher 成本可控，再把它作为更优先的运行策略。
