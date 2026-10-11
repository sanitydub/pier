import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppModel} from './appModel.js';
import {Dock} from './dock.js';
import {FEATURES} from './features/index.js';

// Settings that change the dock's structure: the dock and its features are rebuilt.
// Every other key is either applied live by Dock.syncStyle() or watched by a feature.
const REBUILD_KEYS = new Set([
    'icon-size',
    'position',
    'magnification-enabled',
    'magnification-size',
    'magnification-range',
    'show-apps-button',
]);

/**
 * Owns the dock's lifetime: builds it on the primary monitor with its
 * features, rebuilds on monitor/scale/structural setting changes, and hides
 * GNOME's own dash while enabled.
 */
export class DockManager {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._model = new AppModel();
        this._dock = null;
        this._features = [];
        this._rebuildId = 0;

        this._hideStockDash();

        this._settings.connectObject('changed', (settings, key) => this._onSettingChanged(key), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueRebuild(), this);
        St.ThemeContext.get_for_stage(global.stage)
            .connectObject('notify::scale-factor', () => this._queueRebuild(), this);

        this._build();
    }

    destroy() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);

        this._teardown();
        this._model.destroy();
        this._restoreStockDash();
        this._settings = null;
        this._extension = null;
    }

    _build() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._dock = new Dock(this._settings, this._model, monitor, Main.layoutManager.primaryIndex,
            () => this._extension.openPreferences());
        this._features = FEATURES.map(Feature => new Feature(this._dock, this._settings));
        for (const feature of this._features)
            feature.enable();
    }

    _teardown() {
        for (const feature of this._features.reverse())
            feature.disable();
        this._features = [];
        this._dock?.destroy();
        this._dock = null;
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        // Debounced so dragging a slider in prefs doesn't rebuild on every step.
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._rebuildId = 0;
            this._teardown();
            this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSettingChanged(key) {
        if (REBUILD_KEYS.has(key))
            this._queueRebuild();
        else
            this._dock?.syncStyle();
    }

    _hideStockDash() {
        const dash = Main.overview.dash;
        dash.hide();
        // Zero height so the overview doesn't reserve space for it.
        dash.set_height(0);
        Main.overview.connectObject('showing', () => dash.hide(), this);
    }

    _restoreStockDash() {
        Main.overview.disconnectObject(this);
        const dash = Main.overview.dash;
        dash.set_height(-1);
        dash.show();
    }
}
