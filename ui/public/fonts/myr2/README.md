# Fonts for the Myrmidon UI-2.0 shell (`--myr-*` theme)

Self-hosted subsets (Fontsource CDN pin, no external requests at runtime):

- `Saira` (display: headings, numbers, rail) — `saira-latin(-ext)-{400,500,600,700}.woff2`.
  Saira upstream (Omnibus-Type) has no Cyrillic subset; for Cyrillic display text the
  theme falls back to `Exo 2` — the same substitution the design canvas boards use.
  Files: `exo2-{cyrillic,cyrillic-ext}-{500,700}.woff2`.
- `Inter` (UI text) — `inter-{latin,latin-ext,cyrillic,cyrillic-ext}-{400..700}.woff2`.
  Complements the vendor `InterVariable` (kept untouched) for locale subsets.
- `JetBrains Mono` (logs, IDs, costs) — `jbmono-{latin,latin-ext,cyrillic,cyrillic-ext}-{400,500,700}.woff2`.

All under SIL OFL 1.1 (Saira, Exo 2 by Omnibus-Type; Inter by Rasmus Andersson; JetBrains Mono
by JetBrains). Sources:
- Saira: github.com/Omnibus-Type/Saira (via fontsource `saira@5.2.8`)
- Exo 2: google fonts ofl/exo2 (via fontsource `exo-2@5.2.5`)
- Inter: rsms/inter (via fontsource `inter@5.2.5`)
- JetBrains Mono: JetBrains/JetBrainsMono (via fontsource `jetbrains-mono@5.0.20`)

Pinned fetch date: 2026-10-02.
