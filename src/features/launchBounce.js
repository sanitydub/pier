// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Geo from '../util/geometry.js';

const BOUNCE_DURATION = 260; // per half-bounce
const BOUNCE_HEIGHT = 0.5; // fraction of the icon size
const MAX_BOUNCE_TIME = 6000;

/**
 * Bounce an icon while its app launches. Starts when the user launches from
 * the dock or when an app enters the STARTING state, and stops once the app
 * has a window (finishing the current bounce first) or after a timeout.
 */
export class LaunchBounce {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._active = new Map(); // item -> {stop, timeoutId, app, windowsId}
    }

    enable() {
        this._dock.connectObject('item-launching', (dock, item) => this._start(item), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed', (sys, app) => {
            if (app.state !== Shell.AppState.STARTING)
                return;
            const item = this._dock.getItemForApp(app);
            if (item)
                this._start(item);
        }, this);
    }

    disable() {
        this._dock.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        for (const item of [...this._active.keys()])
            this._finish(item);
    }

    _start(item) {
        if (!this._settings.get_boolean('animate-launch') || this._active.has(item))
            return;
        // With animations off, ease() completes synchronously and the loop would spin.
        if (!St.Settings.get().enable_animations)
            return;

        const app = item.app;
        const state = {stop: false, timeoutId: 0, app, windowsId: 0};
        state.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_BOUNCE_TIME, () => {
            state.timeoutId = 0;
            state.stop = true;
            return GLib.SOURCE_REMOVE;
        });
        const initialWindows = app.get_n_windows();
        state.windowsId = app.connect('windows-changed', () => {
            if (app.get_n_windows() > initialWindows)
                state.stop = true;
        });

        this._active.set(item, state);
        item.connectObject('destroy', () => this._finish(item, true), this);
        this._step(item);
    }

    _step(item) {
        const state = this._active.get(item);
        if (!state)
            return;
        if (state.stop) {
            this._finish(item);
            return;
        }

        const position = this._dock.edge;
        const prop = Geo.crossTranslationProperty(position);
        const height = Geo.awayFromEdgeSign(position) * this._dock.metrics.base * BOUNCE_HEIGHT;
        const icon = item.icon;

        icon.ease({
            [prop]: height,
            duration: BOUNCE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._active.has(item))
                    return;
                icon.ease({
                    [prop]: 0,
                    duration: BOUNCE_DURATION,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => this._step(item),
                });
            },
        });
    }

    _finish(item, destroying = false) {
        const state = this._active.get(item);
        if (!state)
            return;
        // Remove first: removing transitions below fires onComplete, which checks the map.
        this._active.delete(item);

        if (state.timeoutId)
            GLib.source_remove(state.timeoutId);
        state.app.disconnect(state.windowsId);
        item.disconnectObject(this);
        if (destroying)
            return;

        item.icon.remove_all_transitions();
        item.icon.translation_x = 0;
        item.icon.translation_y = 0;
    }
}
