# Herdr Trello

A side panel beside Files and Changes that lists the Trello cards on your client boards (what's in the current list now, yours, or everything), grouped per board; a card opens in a large view with a Start Claude button that opens a Claude tab in that client's repository with the card as its brief.

## What you see

- **The Trello button** at the right end of the tab bar: a 26px pill with a board icon and "Trello", `selected` while its panel shows, `chrome` otherwise.
- **The panel**, in the side panel column, as a card: 10px radius, 1px `border`, `background`.
  - A 42px header: a blue (`ansi4`) board icon, "Trello" semibold, `@username · client boards` (11px, `dim`) and a bordered Refresh button, or a spinner and "Syncing".
  - A filter field ("Filter cards") and a segmented control "<current list> N | Mine N | All N".
  - The list: per board a heading (board name 11px semibold `muted`, the resolved folder right-aligned `dim`, or "no folder" in `ansi3`), then rows: `#number` (34px, `dim`), the title (wrapping), below it the list name, due date and labels (11px, `dim`, `ansi1` when overdue), and at the right the agent status of the card's tab and a ↗ icon.
  - "In this terminal" (11px `dim` heading) with the cards linked on the focused terminal, then the boards; the board of the focused folder first, with a 6px `accent` dot.
  - A footer: "Click: open the card · right-click: copy".
- **The card view**, a dialog 86% by 90%: a top bar (board · list, Refresh, Copy, Open in Trello, close), the title at 28px with a `muted` `#number`, label chips in Trello's colors; left the Description (markdown, images between the text), Checklists (progress bar, 16px checkboxes), Attachments (images as 200px previews, other files as rows), Activity (comments as cards with a 30px avatar, moves and attachments as one line) and a Write/Preview comment box; a 280px sidebar with Start Claude (40px, `solid`; "Go to Claude tab" with the agent status when the card has a tab), the folder with Change, List with Move, Members, Labels, Due.

## How it behaves

- A board counts when one of its lists matches `current` (spaces optional, case-insensitive). The first tab: cards in that list that are yours or have no members. Mine: cards with you as member. All: every open card. Lists matching `done` draw their titles `muted`. The 100 most recently active matches are drawn, grouped per board (most recent board first, cards in list then card order), with a line counting the rest.
- Sync, every 60 s while the panel shows, when it's shown and on Refresh: `members/me/boards?filter=open&fields=name,shortUrl,dateLastActivity&lists=open`; then `boards/<id>/cards?filter=open` only for boards whose `dateLastActivity` or list names changed, and for all of them every 6 hours. One board at a time, each saved to `data/trello/boards/<id>.json`; those files are read on start so the list shows at once.
- Settings in `data/trello/settings.json` (`envFile`, `folders`, `attachments`, `repos`, `current`, `done`), over defaults in `main.js`.
- Folder per board: `repos[board]`, else a folder under `folders` sharing whole words with the board name (at least half of them), or named as the board run together; the shortest wins a tie. The header shows it (last two path parts) or "no folder" in `ansi3`; clicking it opens `pickFolder` and saves the choice in `repos`.
- Click: the card view. Its writes (comment, checklist item, move) go to Trello and set shared `trello.changed`, so the panel fetches that board again. Every 3 s while the panel shows, `hc read <focused terminal> --lines 300` is searched for `trello.com/c/<shortLink>`.
- Start Claude: the card's tab (card id → tab id, kept in shared `trello.links`) if it still exists: `space.select` and `tab.select`. Otherwise (picking a folder first if the board has none) `brief.js` reads `cards/<id>` with checklists, attachments and comments, downloads up to 10 uploads of at most 25 MB into `~/Downloads/trello/<board> #<number>/` (`mkdir -p`, then `curl -H @data/trello/.auth`, numbered names; mod `fs` may only write under Herdr's home), and builds the brief: the working rules, the report rule (`REPORT`: a comment with the result; no moving), then the card between `----- CARD -----` markers. A card without even a title gives a toast. Then `tab.new {space, name: "#<number> <title>" cut to 30, folder, argv: ["claude"], task: brief}` in the local space whose folder (or a pane's cwd) is inside that folder, else `space.new {folder, tab, argv, task}`; the new tab is found in that space by its name, among tabs no other card has, and its id is remembered (none rather than a wrong one).
- A card with a tab shows its status: spinner while `working`, a dot in the status color otherwise.

## Built from

- **Layout** `layouts/main-trello.json`: Herdr's `main` 0.1.10; the `tabs` block sits in a 42px row `tab-bar` with an 82px block `trello-button` (`{ mod: "trello", props: { button: true } }`, `window_drag`); `panel-body` gets a child `trello`.
- **Mod** `mods/trello/`: `main.js` (panel, button, copy menu, and the card dialog as overlay props `{ card, repo }`), `viewer.js` (the card view), `api.js` (settings, credentials, Trello REST), `start.js` (Start Claude, card ↔ tab links), `brief.js` (card → brief, uploads), `pictures.js` (images: download, measure), `icons.js` (Lucide-style SVGs written to `data/trello/icons/`).
- **herdr**: `spaces`, `panes`, `layout`, `theme`, `exec`, `run` (`tab.new`, `space.new`, `space.select`, `tab.select`, `layout.select`, `layout.show`, `layout.hide`), `notify`, `readTextFile`, `pickFolder`, `hc` (`read`), `focused`, `openOverlay`/`closeOverlay`, `shared`/`setShared` (`workspace.panels`, `trello.links`, `trello.changed`), `fs/promises`, `fetch`; gpui-base `TextView.markdown`, `TextareaState`/`Textarea`, `InputState`/`Input`.
- **Programs**: `curl` (uploads), `open` (Trello links).

## Watch out

- Herdr doesn't draw SVGs from a symlinked mod folder: icons live in the data folder and are drawn only once written.
- Herdr doesn't dock a symlinked mod from `mod.json`: `place` is `none` and the layout places it.
- `run()` returns null: the new tab's id is read back from `spaces()` right after (`tab.new` and `space.new` show it at once) and kept per card, so renaming the card or the tab keeps the link.
- `fetch` responses have only `text()` and `json()`: binary uploads go through `curl`. Trello serves them only with an OAuth header; it goes in a file (`-H @file`) deleted after, never on the command line.
- A copy hidden behind Files or Changes still renders: draw an empty `div()` then.
- Herdr cuts off a render after 50 ms of script and async work after its own budget ("This view could not be re-rendered … interrupted"). Processing 1500 cards and writing one big cache file in one go hit it: work one board at a time, derive counts once per change, memoize the filtered list, and look up spaces once per folder per render.
- Herdr watches its home without following symlinks, so edits in the linked checkout don't reload the mod, and switching layouts doesn't reliably either: `touch -h ~/.config/herdr-app/mods/trello` does (the link's own change is inside the watched tree). It writes `gpui-kit.d.ts` and `jsconfig.json` into the mod folder (ignored in git).
- `task` is appended to `argv` as one argument (`claude "<brief>"`), so a multi-KB brief needs no quoting.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/trello` passes.
- The tab bar shows Trello; it opens and closes the panel.
- The panel lists your client-board cards; the current list, Mine, All and the filter change the list, and All finds an old finished card by its title.
- A card opens in the card view with its images, checklists, attachments and comments; a comment posted there shows on trello.com.
- Clicking a board's folder opens the folder picker; the choice shows in the header and lands in `settings.json`.
- Start Claude opens a Claude tab in that client's folder with the card as its first message; the next Start Claude on that card goes to that tab.
