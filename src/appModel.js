import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * Which apps the dock shows: pinned apps (shared with GNOME's favourites)
 * followed by running apps that aren't pinned, in launch order.
 * Emits 'changed' when that list may have changed.
 */
export class AppModel extends Signals.EventEmitter {
    constructor() {
        super();

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._runningOrder = [];
        this._idleId = 0;

        this._favorites.connectObject('changed', () => this._queueChanged(), this);
        this._appSystem.connectObject(
            'installed-changed', () => this._queueChanged(),
            'app-state-changed', () => this._queueChanged(),
            this);
    }

    getApps() {
        const pinned = this._favorites.getFavorites();
        const pinnedIds = new Set(pinned.map(app => app.get_id()));
        const running = this._appSystem.get_running()
            .filter(app => !pinnedIds.has(app.get_id()));

        // Keep a stable launch order so icons don't shuffle as focus changes.
        const runningIds = running.map(app => app.get_id());
        this._runningOrder = this._runningOrder.filter(id => runningIds.includes(id));
        for (const id of runningIds) {
            if (!this._runningOrder.includes(id))
                this._runningOrder.push(id);
        }
        running.sort((a, b) =>
            this._runningOrder.indexOf(a.get_id()) - this._runningOrder.indexOf(b.get_id()));

        return {pinned, running};
    }

    isPinned(app) {
        return this._favorites.isFavorite(app.get_id());
    }

    pin(app) {
        this._favorites.addFavorite(app.get_id());
    }

    unpin(app) {
        this._favorites.removeFavorite(app.get_id());
    }

    /** Move a pinned app to index @pos among the pinned apps. */
    moveTo(app, pos) {
        this._favorites.moveFavoriteToPos(app.get_id(), pos);
    }

    _queueChanged() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._favorites.disconnectObject(this);
        this._appSystem.disconnectObject(this);
    }
}
