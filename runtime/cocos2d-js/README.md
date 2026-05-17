# Cocos2d-JS Runtime

这个目录保存 Cocos2d-JS JSB 原生版的运行时代码，包含两类文件：

- `opengametranslator-probe.js`：启动游戏后读取运行时资源，导出可翻译文本。
- `opengametranslator-runtime.js`：读取本地翻译包，在游戏读取 `data/project.json` 时替换内存中的字符串值。

当前 Cocos2d-JS 主线已经验证了一个关键问题：

> 游戏启动后，能否借助游戏自己的 JSB 读取逻辑，批量读到可翻译文本，而不是要求用户把完整流程玩完。

结论：`games/maya` 样本运行时可以读到明文 `data/project.json`。

## 导出策略

导出 runtime 通过托管 patch 注入到 `Resources/script/jsb_boot.js` 的 `jsb.fileUtils` 初始化之后。

这样做有两个目的：

- 不依赖标准 `cc.game.run/prepare` 流程；AGTK/Cocos 原生壳可能不走这条路径。
- 尽量在 `project.json` 读取前安装 `JSON.parse` 和 `jsb.fileUtils.getStringFromFile` 探针。
- 在 Cocos 引擎初始化后安装 `setString()` hook，用显示层文本做补漏和验证。

探针会尝试收集：

- JSB 环境能力，例如 `writeStringToFile`、`getStringFromFile`、`getWritablePath` 是否存在。
- 已知资源路径能否读取，例如 `project.json`、`data/project.json`、`data/info.json`。
- JSON 解析过程中出现的候选文本。
- 文本节点实际显示过的文本。

## 安装和验证

```bash
npm run dev -- install-probe "games/maya" player.exe
npm run dev -- verify-probe "games/maya"
```

Windows 中双击游戏目录的 `run-me.bat`。探针会尽量写出：

```text
Resources/OpenGameTranslator/output/opengametranslator-loader.json
Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json
```

先看 `opengametranslator-loader.json`：

- `loaded-by-eval` 或 `loaded-by-require`：注入点执行了，探针加载成功。
- `require-failed` / `eval-failed`：注入点执行了，但加载路径或脚本执行失败。
- 文件不存在：优先怀疑 `jsb_boot.js` 注入点没有执行，或当前运行的不是这份游戏目录。

如果这个文件存在，下一步重点看：

- `environment.hasGetStringFromFile`
- `environment.hasWriteStringToFile`
- `files`
- `jsonParses`
- `candidateTexts.length`
- `displayedTexts.length`

如果 `candidateTexts` 已经覆盖大量原文，就可以转成标准双列 CSV：

```bash
npm run dev -- cocos-export-csv "games/maya/Resources/OpenGameTranslator/output/opengametranslator-extracted-texts.json" output/maya.csv
```

如果只有 `displayedTexts` 有内容，说明只能抓到显示过的文本，这不能作为正式主线。

## 翻译安装

翻译 CSV 后构建本地翻译包：

```bash
npm run dev -- validate output/maya.translated.csv
npm run dev -- build output/maya.translated.csv output/maya.package.json
```

安装 Cocos2d-JS 翻译 runtime：

```bash
npm run dev -- install-cocos "games/maya" output/maya.package.json player.exe
npm run dev -- verify-cocos "games/maya"
```

Windows 中双击 `run-me.bat` 后，runtime 会尝试写出：

```text
Resources/OpenGameTranslator/output/opengametranslator-runtime-status.json
```

这个文件用于确认翻译包是否加载成功，以及 `data/project.json` 中有多少字符串被替换。

## 还原

```bash
npm run dev -- uninstall-probe "games/maya"
npm run dev -- uninstall-cocos "games/maya"
```

也可以在 Windows 中双击游戏目录的 `restore-original.bat`。

## 注意

- 导出 runtime 只负责提取文本；翻译 runtime 才负责替换文本。
- 当前 Cocos2d-JS 支持会修改 `Resources/script/jsb_boot.js`，但会先备份原文件并写 manifest。
- 翻译 runtime 不修改 `Resources/data/project.json` 源文件，只在读取时返回内存中的替换版本。
- Cocos2d-JS 的工作目录暂时放在 `Resources/OpenGameTranslator/`，因为 JSB 的 `require()` 更容易从 `Resources` 搜索路径加载运行时代码。
