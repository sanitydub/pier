# MacDock

A macOS-style application dock for GNOME Shell 46–49.

- Floating, rounded, translucent dock (optional background blur)
- Hover magnification with a cosine falloff; neighbours are pushed apart
- Icons bounce while an app launches
- A dot under each running app
- Pinned apps (shared with GNOME's favourites), a separator, then other running apps
- Click to focus, click again to cycle or minimize, middle-click for a new window, right-click for a menu (windows, New Window, Keep in Dock, Quit)
- Autohide modes: *never*, *always*, or *intellihide* (hide only when a window overlaps). Push against the screen edge to reveal a hidden dock
- Bottom, left or right edge
- libadwaita preferences window; changes apply live

GNOME's built-in dash is hidden while the extension is enabled and restored when it is disabled.

## Development

You need a Linux machine or VM running GNOME 46 or newer.

```bash
make install        # compile schemas + symlink this folder into ~/.local/share/gnome-shell/extensions/
make nested         # start a nested GNOME Shell in a window (no logout needed)
```

Inside the nested shell's terminal (or from another terminal with the same session):

```bash
gnome-extensions enable macdock@sanitydub.github.io
gnome-extensions prefs macdock@sanitydub.github.io
```

- Logs: `make logs` (or `journalctl -f -o cat /usr/bin/gnome-shell`)
- Inspect actors: `Alt+F2` → `lg` (Looking Glass)
- On Wayland the running shell can't reload extension code. Restart the nested shell after you edit. On X11 you can also use `Alt+F2` → `r`.
- `make pack` builds an installable zip in `dist/`.

To change the UUID, edit both `metadata.json` and the `UUID` line in the `Makefile`.

## Layout

```
extension.js            entry point: enable() / disable()
prefs.js                preferences window
stylesheet.css          dock look
schemas/                GSettings schema
src/dockManager.js      dock lifetime, rebuilds on monitor/setting changes, hides stock dash
src/dock.js             dock actor: background, item box, geometry, reveal/hide, tooltip
src/dockItem.js         AppDockItem, ShowAppsItem, DockSeparator
src/appModel.js         pinned + running apps
src/features/           pluggable behaviours (magnification, launch bounce, autohide)
src/util/geometry.js    orientation helpers (bottom/left/right)
```

## Adding a feature

1. Create `src/features/myFeature.js`:

   ```js
   export class MyFeature {
       constructor(dock, settings) {
           this._dock = dock;
           this._settings = settings;
       }

       enable() {
           this._dock.connectObject('hover-changed', () => { /* ... */ }, this);
       }

       disable() {
           this._dock.disconnectObject(this);
       }
   }
   ```

2. Add it to `FEATURES` in `src/features/index.js`.
3. If it needs settings, add keys to the schema and rows to `prefs.js`.

Useful dock API: `dock.items`, `dock.getItemForApp(app)`, `dock.getBaseCenters()`, `dock.getRevealedRect()`, `dock.setRevealed()`, `dock.edge`, `dock.metrics`, `dock.hover`, `dock.menuOpen`. The dock emits `hover-changed`, `menu-state-changed` and `item-launching`.

`disable()` must undo everything `enable()` did: signals, timeouts and actors. extensions.gnome.org review requires it.

## Known limitations

- Primary monitor only.
- Background blur is rectangular and does not follow the rounded corners.
- No drag-and-drop reordering yet.
