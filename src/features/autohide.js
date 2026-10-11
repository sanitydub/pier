import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Geo from '../util/geometry.js';

const HIDE_DELAY = 400;
const PRESSURE_THRESHOLD = 100;
const PRESSURE_TIMEOUT = 1000;
const PRESSURE_REVEAL_GRACE = 1500;
const WINDOW_CHECK_DELAY = 100;

const OVERLAP_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
    Meta.WindowType.TOOLBAR,
];

/**
 * Autohide modes (setting 'autohide-mode'):
 *   off          - always visible, reserves screen space
 *   always       - hidden until the pointer pushes against the screen edge
 *   intellihide  - hidden only while a window on this monitor overlaps the dock
 * In every mode the dock stays visible while hovered, while a menu is open,
 * and in the overview.
 */
export class Autohide {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._mode = 'off';
        this._pressure = null;
        this._barrier = null;
        this._trackedWindows = new Set();
        this._hideTimeoutId = 0;
        this._pressureTimeoutId = 0;
        this._windowCheckId = 0;
        this._pressureReveal = false;
        this._overlapped = false;
    }

    enable() {
        this._settings.connectObject('changed::autohide-mode', () => this._sync(), this);
        this._dock.connectObject(
            'hover-changed', () => {
                if (!this._dock.hover)
                    this._pressureReveal = false;
                this._evaluate();
            },
            'menu-state-changed', () => this._evaluate(),
            this);
        Main.overview.connectObject(
            'showing', () => this._evaluate(),
            'hidden', () => this._evaluate(),
            this);

        this._sync();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._dock.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._teardownMode();
    }

    _sync() {
        this._teardownMode();
        this._mode = this._settings.get_string('autohide-mode');

        if (this._mode === 'off') {
            this._dock.setStrutsEnabled(true);
            this._dock.setRevealed(true);
            return;
        }

        this._dock.setStrutsEnabled(false);
        this._createBarrier();
        if (this._mode === 'intellihide') {
            this._trackWindows();
            this._overlapped = this._isOverlapped();
        }
        this._evaluate();
    }

    _teardownMode() {
        for (const id of [this._hideTimeoutId, this._pressureTimeoutId, this._windowCheckId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._hideTimeoutId = this._pressureTimeoutId = this._windowCheckId = 0;
        this._pressureReveal = false;
        this._overlapped = false;

        this._destroyBarrier();
        this._untrackWindows();
    }

    // ---- Show / hide decision ----

    _shouldShow() {
        return this._mode === 'off' ||
            Main.overview.visible ||
            this._dock.hover ||
            this._dock.menuOpen ||
            this._pressureReveal ||
            (this._mode === 'intellihide' && !this._overlapped);
    }

    _evaluate() {
        if (this._shouldShow()) {
            if (this._hideTimeoutId) {
                GLib.source_remove(this._hideTimeoutId);
                this._hideTimeoutId = 0;
            }
            this._dock.setRevealed(true);
            return;
        }

        if (!this._dock.revealed || this._hideTimeoutId)
            return;
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideTimeoutId = 0;
            if (!this._shouldShow())
                this._dock.setRevealed(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Edge pressure reveal ----

    _createBarrier() {
        const mon = this._dock.monitor;
        let params;
        switch (this._dock.edge) {
        case Geo.Position.LEFT:
            params = {
                x1: mon.x, x2: mon.x, y1: mon.y, y2: mon.y + mon.height,
                directions: Meta.BarrierDirection.POSITIVE_X,
            };
            break;
        case Geo.Position.RIGHT: {
            const x = mon.x + mon.width;
            params = {
                x1: x, x2: x, y1: mon.y, y2: mon.y + mon.height,
                directions: Meta.BarrierDirection.NEGATIVE_X,
            };
            break;
        }
        default: {
            const y = mon.y + mon.height;
            params = {
                x1: mon.x, x2: mon.x + mon.width, y1: y, y2: y,
                directions: Meta.BarrierDirection.NEGATIVE_Y,
            };
        }
        }

        this._pressure = new Layout.PressureBarrier(PRESSURE_THRESHOLD, PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._pressure.connectObject('trigger', () => this._onPressure(), this);

        try {
            this._barrier = new Meta.Barrier({backend: global.backend, ...params});
        } catch {
            // Mutter < 46 took a display instead of a backend.
            this._barrier = new Meta.Barrier({display: global.display, ...params});
        }
        this._pressure.addBarrier(this._barrier);
    }

    _destroyBarrier() {
        if (this._barrier) {
            this._pressure.removeBarrier(this._barrier);
            this._barrier.destroy();
            this._barrier = null;
        }
        if (this._pressure) {
            this._pressure.disconnectObject(this);
            this._pressure.destroy();
            this._pressure = null;
        }
    }

    _onPressure() {
        this._pressureReveal = true;
        this._evaluate();

        // If the pointer never moves onto the dock, hide again after a grace period.
        if (this._pressureTimeoutId)
            GLib.source_remove(this._pressureTimeoutId);
        this._pressureTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRESSURE_REVEAL_GRACE, () => {
            this._pressureTimeoutId = 0;
            this._pressureReveal = false;
            this._evaluate();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Intellihide window tracking ----

    _trackWindows() {
        const queue = () => this._queueWindowCheck();
        global.display.connectObject(
            'window-created', (display, win) => this._trackWindow(win),
            'restacked', queue,
            this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);

        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
    }

    _trackWindow(win) {
        if (!win || this._trackedWindows.has(win))
            return;
        this._trackedWindows.add(win);

        const queue = () => this._queueWindowCheck();
        win.connectObject(
            'position-changed', queue,
            'size-changed', queue,
            'workspace-changed', queue,
            'notify::minimized', queue,
            'unmanaged', () => {
                win.disconnectObject(this);
                this._trackedWindows.delete(win);
                queue();
            },
            this);
        queue();
    }

    _untrackWindows() {
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const win of this._trackedWindows)
            win.disconnectObject(this);
        this._trackedWindows.clear();
    }

    _queueWindowCheck() {
        if (this._windowCheckId)
            return;
        this._windowCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_CHECK_DELAY, () => {
            this._windowCheckId = 0;
            const overlapped = this._isOverlapped();
            if (overlapped !== this._overlapped) {
                this._overlapped = overlapped;
                this._evaluate();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _isOverlapped() {
        const dockRect = this._dock.getRevealedRect();
        const workspace = global.workspace_manager.get_active_workspace();

        return global.get_window_actors().some(actor => {
            const win = actor.meta_window;
            return win &&
                !win.minimized &&
                win.get_monitor() === this._dock.monitorIndex &&
                win.located_on_workspace(workspace) &&
                OVERLAP_WINDOW_TYPES.includes(win.get_window_type()) &&
                Geo.rectsOverlap(dockRect, win.get_frame_rect());
        });
    }
}
