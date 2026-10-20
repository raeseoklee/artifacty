# Language packs

English | [한국어](ko/language-packs.md)

## Choose available languages

Sign in as an administrator and open **Administration → Languages** (`/admin/languages`). Enable the installed languages you want users to select. Choose one of those languages as the default. Save the settings. At least one language must remain enabled. The selector displays each language's native name.

English and Korean are built in. Before any settings are saved, `ARTIFACTY_LOCALE=en` or `ko` sets the initial default; otherwise it is English. Saved administrator settings replace this initial default.

The browser checks language choices in this order: explicit `?lang=<locale>`, the saved browser cookie, then the administrator default. It uses the first enabled language it finds. Disabled or uninstalled choices are ignored. An explicit enabled English choice overrides a Korean cookie or default. `Accept-Language` does not select the language. The cookie lasts one year and belongs to that browser. Clearing it restores the administrator default, or the initial environment/English default if settings have never been saved.

## Import a custom pack

1. Download the JSON template from `/admin/languages/template`.
2. Set `locale` and `nativeName` for the new language.
3. Translate entries in `messages`.
4. Paste the JSON into the import field at `/admin/languages`.
5. Import the pack.
6. Enable the imported language in the language settings.

A partial Japanese pack can contain:

```json
{
  "locale": "ja",
  "nativeName": "日本語",
  "messages": {
    "nav.artifacts": "アーティファクト"
  }
}
```

Missing messages use English. Imports accept only current known message keys. Each translation must preserve the placeholder names from its English message, such as `{count}`. Artifacty rejects the import if a key or placeholder is invalid. After an application update, Artifacty ignores stored translations whose keys are obsolete or whose placeholders have changed. It displays the current English message instead.

Custom packs cannot replace built-in `en` or `ko`. Importing an existing custom locale replaces that pack. Limits are 16 custom packs, 512 KiB per pack, and 4 MiB for the combined settings. These limits count UTF-8 JSON bytes. Language settings and pack metadata are included in full backups.

Language packs translate UI text. They do not translate commands, API/MCP identifiers, or stored artifact content. See the [interface language reference](../README.md#interface-language).
