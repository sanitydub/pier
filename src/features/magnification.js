import Clutter from 'gi://Clutter';

import * as Geo from '../util/geometry.js';

const RAMP_IN_DURATION = 120;
const RAMP_OUT_DURATION = 220;

/**
 * macOS-style hover magnification. Each icon's scale follows a cosine falloff
 * of its distance to the pointer, measured against the *unmagnified* layout so
 * the result doesn't feed back into itself. A global "strength" ramps in on
 * enter and out on leave so icons grow and shrink smoothly.
 */
export class Magnification {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._strength = 0;
        this._strengthTarget = 0;
        this._pointer = null;
        this._timeline = null;
    }

    enable() {
        const m = this._dock.metrics;
        if (m.max <= m.base)
            return; // disabled, or magnified size isn't larger (dock is rebuilt when this changes)

        this._dock.connectObject(
            'motion-event', (actor, event) => {
                this._onMotion(event);
                return Clutter.EVENT_PROPAGATE;
            },
            'hover-changed', () => {
                if (!this._dock.hover)
                    this._animateStrength(0);
            },
            'menu-state-changed', () => {
                if (this._dock.menuOpen)
                    this._animateStrength(0);
            },
            this);
    }

    disable() {
        this._dock.disconnectObject(this);
        this._stopTimeline();
        this._strength = 0;
        this._apply();
    }

    _onMotion(event) {
        if (this._dock.menuOpen)
            return;

        const [x, y] = event.get_coords();
        this._pointer = Geo.isVertical(this._dock.edge) ? y : x;

        if (this._strengthTarget !== 1)
            this._animateStrength(1);
        else
            this._apply();
    }

    _apply() {
        const m = this._dock.metrics;
        const maxScale = m.max / m.base;

        for (const {item, center} of this._dock.getBaseCenters()) {
            if (!item.magnifiable)
                continue;

            let target = 1;
            if (this._pointer !== null) {
                const d = Math.abs(this._pointer - center);
                if (d < m.rangePx)
                    target += (maxScale - 1) * Math.cos((Math.PI / 2) * (d / m.rangePx));
            }
            item.setIconScale(1 + (target - 1) * this._strength);
        }
    }

    _animateStrength(to) {
        if (this._strengthTarget === to && this._timeline)
            return;
        this._stopTimeline();
        this._strengthTarget = to;

        const from = this._strength;
        const timeline = new Clutter.Timeline({
            actor: this._dock,
            duration: to > from ? RAMP_IN_DURATION : RAMP_OUT_DURATION,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        timeline.connect('new-frame', () => {
            this._strength = from + (to - from) * timeline.get_progress();
            this._apply();
        });
        timeline.connect('completed', () => {
            this._strength = to;
            this._apply();
            if (this._timeline === timeline)
                this._timeline = null;
        });
        this._timeline = timeline;
        timeline.start();
    }

    _stopTimeline() {
        if (!this._timeline)
            return;
        // stop() doesn't emit 'completed', so the stale handlers never fire.
        const timeline = this._timeline;
        this._timeline = null;
        timeline.stop();
    }
}
