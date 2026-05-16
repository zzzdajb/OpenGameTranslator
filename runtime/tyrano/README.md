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

## Expected Package Path

By default, the runtime looks for:

```text
./data/others/opengametranslator.package.json
```

The path is relative to the game's `index.html`. It can be overridden before loading the runtime script:

```html
<script>
window.OpenGameTranslatorConfig = {
    packagePath: "./data/others/opengametranslator.package.json"
};
</script>
```

## Loading Order

Load `opengametranslator-runtime.js` after Tyrano's `kag.tag.js`.

The runtime waits until `tyrano.plugin.kag.tag.text.showMessage` exists, then wraps it. It also wraps supported tag parameters when those tags exist. If the package is missing, invalid, or a message has no translation, the original text is shown.

## Manual Test Scope

Windows in-game testing is still required later for:

- Confirming script loading from the actual game folder.
- Confirming translated text appears in the message window.
- Confirming backlog behavior.
- Confirming font rendering.
