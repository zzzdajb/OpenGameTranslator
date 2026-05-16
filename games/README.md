# Local Game Files

把本地游戏文件放在这个目录下。这里的实际游戏内容不会提交到 git。

建议结构：

```text
games/
    perfedygirl/
        resources/
            app.asar/
                package.json
                index.html
                main.js
                tyrano/
                data/
```

后续开发只会读取这些文件来验证引擎检测、文本提取和 runtime hook 设计。不要把商业游戏资源提交到远程仓库。

