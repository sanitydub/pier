import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Geo from './util/geometry.js';

// Icons scale from the point touching the screen edge, so magnified icons grow away from it.
const ICON_PIVOTS = {
    [Geo.Position.BOTTOM]: [0.5, 1],
    [Geo.Position.LEFT]: [0, 0.5],
    [Geo.Position.RIGHT]: [1, 0.5],
};

const MENU_SIDES = {
    [Geo.Position.BOTTOM]: St.Side.BOTTOM,
    [Geo.Position.LEFT]: St.Side.LEFT,
    [Geo.Position.RIGHT]: St.Side.RIGHT,
};

/** Anchor an item to the screen-edge side of the dock's item box. */
function alignToEdge(actor, position) {
    if (position === Geo.Position.LEFT)
        actor.x_align = Clutter.ActorAlign.START;
    else if (position === Geo.Position.RIGHT)
        actor.x_align = Clutter.ActorAlign.END;
    else
        actor.y_align = Clutter.ActorAlign.END;
}

/**
 * Base class for every icon in the dock. The icon texture is created at the
 * maximum magnified size and scaled down, so it stays crisp while magnified.
 * The item's own size tracks the current scale so neighbours are pushed apart.
 *
 * Interface the Dock and features rely on:
 *   icon, magnifiable, baseAlong, tooltipText, setIconScale(), syncDot()
 */
const DockIcon = GObject.registerClass(
class DockIcon extends St.Button {
    constructor(dock, createIcon) {
        super({
            style_class: 'macdock-item',
            track_hover: true,
            can_focus: false,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
        });

        this._dock = dock;
        this._metrics = dock.metrics;
        this._position = dock.edge;
        this._iconPx = 0;

        this._content = new St.Widget();
        this.set_child(this._content);

        this.icon = createIcon(this._metrics.maxLogical);
        this.icon.set_size(this._metrics.max, this._metrics.max);
        this.icon.set_pivot_point(...ICON_PIVOTS[this._position]);
        this._content.add_child(this.icon);

        this._dot = new St.Widget({style_class: 'macdock-dot', visible: false});
        this._dot.set_size(this._metrics.dot, this._metrics.dot);
        this._content.add_child(this._dot);

        alignToEdge(this, this._position);

        this.connect('notify::pressed', () => {
            this.icon.opacity = this.pressed ? 170 : 255;
        });

        this.setIconScale(1);
    }

    get magnifiable() {
        return true;
    }

    /** Size along the dock axis at scale 1. */
    get baseAlong() {
        return this._metrics.base + 2 * this._metrics.itemPad;
    }

    get tooltipText() {
        return '';
    }

    syncDot() {
    }

    setDotVisible(visible) {
        this._dot.visible = visible;
    }

    setIconScale(scale) {
        const m = this._metrics;
        const iconPx = Math.round(m.base * scale);
        if (iconPx === this._iconPx)
            return;
        this._iconPx = iconPx;

        const along = iconPx + 2 * m.itemPad;
        const cross = iconPx + m.topPad + m.edgePad;
        const vertical = Geo.isVertical(this._position);
        const width = vertical ? cross : along;
        const height = vertical ? along : cross;
        this.set_size(width, height);

        // Place the unscaled (max-size) icon so that after scaling around its
        // pivot it occupies exactly the icon slot of this item.
        const T = m.max;
        const alongOffset = m.itemPad + iconPx / 2 - T / 2;
        let ix, iy, dx, dy;
        switch (this._position) {
        case Geo.Position.LEFT:
            [ix, iy] = [m.edgePad, alongOffset];
            [dx, dy] = [(m.edgePad - m.dot) / 2, (height - m.dot) / 2];
            break;
        case Geo.Position.RIGHT:
            [ix, iy] = [width - m.edgePad - T, alongOffset];
            [dx, dy] = [width - (m.edgePad + m.dot) / 2, (height - m.dot) / 2];
            break;
        default:
            [ix, iy] = [alongOffset, height - m.edgePad - T];
            [dx, dy] = [(width - m.dot) / 2, height - (m.edgePad + m.dot) / 2];
        }

        const k = iconPx / T;
        this.icon.set_position(Math.round(ix), Math.round(iy));
        this.icon.set_scale(k, k);
        this._dot.set_position(Math.round(dx), Math.round(dy));
    }
});

export const AppDockItem = GObject.registerClass(
class AppDockItem extends DockIcon {
    constructor(dock, app) {
        super(dock, size => app.create_icon_texture(size));

        this.app = app;
        this._menu = null;

        this.app.connectObject('notify::state', () => this.syncDot(), this);
        this.connect('clicked', (actor, button) => this._onClicked(button));
        this.connect('destroy', () => {
            this._menu?.destroy();
            this._menu = null;
        });

        this.syncDot();
    }

    get tooltipText() {
        return this.app.get_name();
    }

    syncDot() {
        this.setDotVisible(this._dock.showDots && this.app.state !== Shell.AppState.STOPPED);
    }

    _windows() {
        return this.app.get_windows().filter(w => !w.skip_taskbar);
    }

    _onClicked(button) {
        this._dock.hideTooltip();

        switch (button) {
        case Clutter.BUTTON_PRIMARY:
            this._activate();
            break;
        case Clutter.BUTTON_MIDDLE:
            this._openNewWindow();
            break;
        case Clutter.BUTTON_SECONDARY:
            this._openMenu();
            break;
        }
    }

    _activate() {
        const windows = this._windows();

        if (windows.length === 0) {
            this.app.activate();
            this._dock.emit('item-launching', this);
            return;
        }

        const focused = Shell.WindowTracker.get_default().focus_app === this.app;
        if (focused && !Main.overview.visible) {
            // Windows are in MRU order: activating the last one cycles through them all.
            if (windows.length > 1)
                Main.activateWindow(windows[windows.length - 1]);
            else
                windows[0].minimize();
        } else {
            Main.activateWindow(windows[0]);
        }
    }

    _openNewWindow() {
        if (!this.app.can_open_new_window())
            return;
        this.app.open_new_window(-1);
        this._dock.emit('item-launching', this);
    }

    _openMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.5, MENU_SIDES[this._position]);
            this._menu.actor.add_style_class_name('macdock-menu');
            this._menu.connect('open-state-changed', (menu, open) => {
                this._dock.setMenuOpen(open);
                if (!open)
                    this.sync_hover();
            });
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._dock.menuManager.addMenu(this._menu);
        }

        const menu = this._menu;
        menu.removeAll();

        const windows = this._windows();
        for (const win of windows) {
            menu.addAction(win.get_title() || this.app.get_name(),
                () => Main.activateWindow(win));
        }
        if (windows.length > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this.app.can_open_new_window())
            menu.addAction(_('New Window'), () => this._openNewWindow());

        const model = this._dock.model;
        if (model.isPinned(this.app))
            menu.addAction(_('Remove from Dock'), () => model.unpin(this.app));
        else
            menu.addAction(_('Keep in Dock'), () => model.pin(this.app));

        if (this.app.state !== Shell.AppState.STOPPED) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(_('Quit'), () => this.app.request_quit());
        }

        menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

export const ShowAppsItem = GObject.registerClass(
class ShowAppsItem extends DockIcon {
    constructor(dock) {
        super(dock, size => new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            icon_size: size,
            style_class: 'macdock-show-apps-icon',
        }));

        this.connect('clicked', (actor, button) => {
            if (button !== Clutter.BUTTON_PRIMARY)
                return;
            this._dock.hideTooltip();
            if (Main.overview.visible && Main.overview.dash.showAppsButton.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }

    get tooltipText() {
        return _('Show Applications');
    }
});

export const DockSeparator = GObject.registerClass(
class DockSeparator extends St.Widget {
    constructor(dock) {
        super({style_class: 'macdock-separator'});

        const m = dock.metrics;
        const cross = m.topPad + m.base + m.edgePad;
        const length = Math.round(m.base * 0.75);
        const thickness = Math.max(1, Math.round(m.sf));

        const line = new St.Widget({style_class: 'macdock-separator-line'});
        this.add_child(line);

        if (Geo.isVertical(dock.edge)) {
            this.set_size(cross, m.sepAlong);
            line.set_size(length, thickness);
            line.set_position(Math.round((cross - length) / 2), Math.round((m.sepAlong - thickness) / 2));
        } else {
            this.set_size(m.sepAlong, cross);
            line.set_size(thickness, length);
            line.set_position(Math.round((m.sepAlong - thickness) / 2), Math.round((cross - length) / 2));
        }

        this._baseAlong = m.sepAlong;
        alignToEdge(this, dock.edge);
    }

    get magnifiable() {
        return false;
    }

    get baseAlong() {
        return this._baseAlong;
    }

    get tooltipText() {
        return '';
    }

    setIconScale() {
    }

    syncDot() {
    }
});
