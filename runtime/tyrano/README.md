# TyranoScript Runtime

This folder contains the plain JavaScript runtime hook for TyranoScript games.

## Files

- `opengametranslator-runtime.js`: loads a translation package and hooks TyranoScript message text.

## Hook Coverage

The runtime currently hooks:

- `tyrano.plugin.kag.tag.text.showMessage`
- `ptext.text`
- `mtext.text`
- `glink.text`
- `button.hint`
- `chara_new.jname`

## Package Path

By default, the runtime looks for:

```text
./data/others/opengametranslator.package.json
```

The path is relative to the game's `index.html`. The managed installer overrides it to the package stored in the game-level `OpenGameTranslator/` workdir:

```html
<script>
window.OpenGameTranslatorConfig = {
    packagePath: "../../OpenGameTranslator/opengametranslator.package.json"
};
</script>
```

## Loading Order

Load `opengametranslator-runtime.js` after Tyrano's `kag.tag.js`.

The runtime waits until `tyrano.plugin.kag.tag.text.showMessage` exists, then wraps it. It also wraps supported tag parameters when those tags exist. If the package is missing, invalid, or a message has no translation, the original text is shown.

## Manual Test Scope

Windows in-game smoke testing has passed for the current target game. Broader testing is still useful for:

- Confirming backlog behavior.
- Confirming font rendering.
- Confirming menus, save/load, replay, and late-game routes.

See `设计和文档/Windows托管安装说明.md` for the current managed installation steps.
