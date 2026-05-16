# Windows 手动安装说明

这份说明用于把已经构建好的 TyranoScript 翻译运行时装进本地游戏副本。建议先复制一份游戏目录做测试，不要直接修改原始游戏目录。

## 1. 准备翻译包

如果外部翻译工具把译文覆盖到了第一列，先恢复成标准双列 CSV：

```bash
npm run dev -- repair output/perfedygirl.csv output/perfedygirl_translated.csv output/perfedygirl.repaired.csv
```

校验并构建 runtime 翻译包：

```bash
npm run dev -- validate output/perfedygirl.repaired.csv
npm run dev -- build output/perfedygirl.repaired.csv output/perfedygirl.package.json
```

## 2. 复制文件

把下面两个文件复制到游戏目录：

```text
resources/app.asar/data/others/opengametranslator-runtime.js
resources/app.asar/data/others/opengametranslator.package.json
```

来源文件：

```text
runtime/tyrano/opengametranslator-runtime.js
output/perfedygirl.package.json
```

复制时需要把 `perfedygirl.package.json` 改名为 `opengametranslator.package.json`。

## 3. 修改 index.html

编辑游戏目录里的：

```text
resources/app.asar/index.html
```

找到：

```html
<script type="text/javascript" src="./tyrano/plugins/kag/kag.tag.js" ></script>
```

在它后面插入：

```html
<script>
window.OpenGameTranslatorConfig = {
    packagePath: "./data/others/opengametranslator.package.json"
};
</script>
<script type="text/javascript" src="./data/others/opengametranslator-runtime.js"></script>
```

插入后附近应该类似：

```html
<script type="text/javascript" src="./tyrano/plugins/kag/kag.tag.js" ></script>

<script>
window.OpenGameTranslatorConfig = {
    packagePath: "./data/others/opengametranslator.package.json"
};
</script>
<script type="text/javascript" src="./data/others/opengametranslator-runtime.js"></script>

<link href="./tyrano/libs/textillate/assets/animate.css" rel="stylesheet">
```

运行时必须放在 `kag.tag.js` 后面，因为 hook 需要等 TyranoScript 的文本标签定义完成。

## 4. 启动测试

启动游戏后重点检查：

- 游戏能正常进入。
- 已翻译文本能显示译文。
- 未命中译文的文本仍显示原文。
- 存档、读档、菜单、回想等常见流程没有异常。

如果游戏正常启动但没有翻译，优先检查文件名、文件路径和 `index.html` 插入位置。不要把 CSV 直接改名成 JSON，翻译包必须由 `build` 命令生成。

如果 `resources/app.asar` 在目标机器上是单个文件，不是文件夹，需要先走 asar 解包/重打包流程。
