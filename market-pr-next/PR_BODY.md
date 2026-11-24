Follow-up to #18604 (which drops the "no DSH access check" note). Two cosmetic corrections to the same entry, kept in a separate PR so #18604 stays a one-line change.

**1. `skin` → `shell` in the description**

The description said "Digital-human workbench **skin**", while the entry is filed under `ui`. contributing.md asks skins to go under Themes & Appearance, so the sentence and the category contradicted each other. The plugin's own behaviour says which one is right: it does not restyle the DSH UI — it embeds the native conversation view unchanged (`/?bwm=embedded`) and adds a separate `/bwm-friend/` page with its own settings, voice and task endpoints. That is a page-level shell, so `ui` stands and the wording follows it. The Chinese line already said 外壳 and needed no change.

Why not just move it to `theme` instead: `dsh-market`'s `src/themes.ts` keeps **exactly one** theme active, toggling the others off through the loader. A plugin with working routes in that tab gets disabled every time the user switches to another theme, and activating it turns off whatever theme they had. Filed as `ui`, it is simply an installed plugin.

**2. `icon:` added**

`https://raw.githubusercontent.com/Lawrencezeng818/dsh-plugin-bwm-friend/main/assets/icon-512.png` — square 512×512 PNG, transparent corners.

It is the project's existing 108 px brand mark (`static-ui/brand-mark-108.png`) scaled up with Lanczos and sharpened on RGB only. I did not redraw it: a regenerated tile would move the gem outline and the starfield, and the card is the one place where the mark is the brand. Shape, palette and corner radius are unchanged. 512 px covers the ~96 px card at 2× and 3×.

Nothing else in the entry changed, and the READMEs are left to `sync-readme` per contributing.md.
