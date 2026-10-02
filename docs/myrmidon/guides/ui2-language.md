# Interface language of the 2.0 UI (UI2-I18N)

> Russian version: [ui2-language.ru.md](ui2-language.ru.md)

The 2.0 interface ships bilingual: English is the base and Russian is a full
translation. Each person picks the language once; the board remembers it for
that person on the server, so the choice follows the user across browsers and
machines. The feature needs no configuration and has no settings.

The feature lives in the 2.0 UI tree behind the instance flag
`enableMyrmidonUi2` (default off, Instance settings → Experimental →
"Myrmidon UI 2.0 Shell"). The 1.x screens are not translated by it; their
Russian translation is a separate track (UI-RU).

## Where a user picks the language

The Language screen of the 2.0 shell: Settings → Language
(`/company/settings/language`, route key `settings-language`). The screen
shows the two shipped languages — English and Russian — as a radio group
(each option is labeled with its own self-name, "English" / "Russian"),
plus a live preview of the navigation and a decision card in the selected
language, so the choice is visible before it is made.

The honest boundary shown on the same screen:

- Text written by agents (task bodies, run logs, comments) is never
  translated. The setting selects the catalog the interface chrome renders
  from, not a translation of the content.
- Identifiers (task numbers, agent names) never change.
- A Russian string missing from the catalog falls back to the English base.

## How the choice persists

The preference is a personal, instance-wide setting stored on the server —
the same pattern as the sidebar preferences: keyed by user id, outside any
company, never written by agents.

The table `user_ui_language` (migration `0289_nice_shiva`, additive only:
one new table and a unique index on `user_id`) holds one row per user with
`en` or `ru`. English is the answer for a user who never saved a choice.

In the browser, the last applied choice is also mirrored to `localStorage`
(`myrmidon:ui2:language`). This keeps the language through a reload before
the server request resolves, and through a failed request. The server copy
still wins once it loads — unless the user has switched in the current
session, in which case the user's newer choice is not overwritten. Switching
the language in one tab applies it in the other tabs of the same browser
(storage-event sync).

A failed server write does not roll the language back: the choice stays
applied in this browser and the screen flags that the server copy was not
saved. Offline or in a non-board session, the local mirror is used.

The provider also sets the `lang` attribute (`en`/`ru`) on the 2.0 UI root
element (`.myr-ui2`). That attribute is the whole font-switch contract with
the shell theme: Saira for English, Exo 2 for Russian, keyed on
`[lang="ru"]` in the theme tokens.

## What the ui2 catalogs cover

The catalogs live in `ui/src/ui2/i18n/catalogs/{en,ru}.ts` and are
registered on the i18next instance in the separate `ui2` namespace —
no vendor locale file is touched. The `ui2.*` namespace covers the 2.0 UI
tree only: the shell chrome, the screens rebuilt in the 2.0 tree, and the
Language screen itself. The other 38 vendor locales get English values
through the fallback chain until a translation pass reaches them.

Two rules are enforced by guard tests, not by convention:

- `ui/src/ui2/i18n/no-english-in-ru.myrmidon.test.ts` — a static scan of the
  2.0 tree fails on hard-coded user-visible strings (JSX text and the
  `title`/`aria-label`/`placeholder`/`label`/`alt` attributes) and on `t()`
  keys missing from both catalogs.
- `ui/src/ui2/i18n/catalog-parity.myrmidon.test.ts` — key parity between
  `en` and `ru`, non-empty Russian values that are not left in English
  (allow-listed exceptions only), and matching interpolation placeholders.

## The API endpoint (for operators)

The preference is exposed by two routes, board users only:

```
GET /api/myrmidon/ui2/language/me
200 { "language": "en" | "ru", "updatedAt": <timestamp> | null }

PUT /api/myrmidon/ui2/language/me
body: { "language": "en" | "ru" }
200 { "language": ..., "updatedAt": <timestamp> }
```

- The route carries no company id: the preference is instance-wide per user.
- A session that is not a board user (an agent key, or a board actor without
  a user id) gets `403` on read and write — agents never read or write the
  preference.
- A body with an unknown language code, or without the `language` field,
  gets `400`.
- `PUT` stores the value and writes one activity-log entry
  (`myrmidon.ui2.language_updated`) per active company membership of the
  user, with the previous and the new value, so the change shows in each
  company's audit trail the way other board settings do. A user with no
  company membership gets the write with no audit rows.

This is a UI-owned preference; the board does not localize its API or agent
payloads through it.
