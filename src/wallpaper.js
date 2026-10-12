// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';

/**
 * A copy of the monitor's wallpaper, clipped to this actor's allocation and
 * kept lined up with the real wallpaper on screen, wherever the actor is.
 *
 * Call syncPosition() when the actor moves on screen without being
 * reallocated (e.g. its parent is translated).
 */
export const WallpaperCopy = GObject.registerClass(
class WallpaperCopy extends St.Widget {
    constructor(monitorIndex, params = {}) {
        super({clip_to_allocation: true, ...params});

        this._monitorIndex = monitorIndex;
        this._bgManager = new Background.BackgroundManager({
            container: this,
            monitorIndex,
            controlPosition: false,
        });
        this._bgManager.connect('changed', () => this.syncPosition());
        this.connect('notify::allocation', () => this.syncPosition());
        this.connect('destroy', () => this._bgManager.destroy());
    }

    // Translation rather than position, so it never queues a relayout.
    syncPosition() {
        const wallpaper = this._bgManager.backgroundActor;
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!wallpaper || !monitor)
            return;
        const [x, y] = this.get_transformed_position();
        wallpaper.set_translation(monitor.x - x, monitor.y - y, 0);
    }
});

/**
 * Call `callback(progress)` whenever the overview's progress changes, from
 * 0 on the desktop to 1 once the window picker is fully open (the app grid
 * also counts as 1), and when the overview starts showing or has hidden.
 * Handlers are disconnected when `owner` (an actor) is destroyed.
 *
 * The progress follows touchpad swipes as well as the Super-key animation.
 * It's internal to GNOME Shell, so without it a fixed-length fade on the
 * overview's showing/hiding signals stands in.
 */
export function trackOverviewProgress(owner, callback) {
    const adjustment = Main.overview._overview?._controls?._stateAdjustment;
    if (adjustment) {
        const sync = () => callback(Math.min(Math.max(adjustment.value, 0), 1));
        adjustment.connectObject('notify::value', sync, owner);
        Main.overview.connectObject('showing', sync, 'hidden', sync, owner);
        sync();
        return;
    }

    let progress = Main.overview.visible ? 1 : 0;
    let timeline = null;
    const animateTo = target => {
        timeline?.stop();
        const from = progress;
        timeline = new Clutter.Timeline({actor: owner, duration: Overview.ANIMATION_TIME});
        timeline.connect('new-frame', () => {
            progress = from + (target - from) * timeline.get_progress();
            callback(progress);
        });
        timeline.connect('completed', () => {
            progress = target;
            callback(progress);
        });
        timeline.start();
    };
    Main.overview.connectObject(
        'showing', () => animateTo(1),
        'hiding', () => animateTo(0),
        'hidden', () => callback(progress),
        owner);
    callback(progress);
}
