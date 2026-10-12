// SPDX-License-Identifier: GPL-2.0-or-later

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUR_RADIUS = 40;
const BLUR_BRIGHTNESS = 0.9;

// Fades out everything outside a rounded rectangle inset from the actor's
// edges, with a one-pixel anti-aliased rim.
const CORNER_DECLARATIONS = `
uniform float width;
uniform float height;
uniform float inset;
uniform float radius;
`;
const CORNER_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * vec2(width, height);
vec2 lo = vec2(inset + radius);
vec2 hi = vec2(width, height) - vec2(inset + radius);
float d = length(p - clamp(p, lo, hi)) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const RoundedCornerEffect = GObject.registerClass(
class RoundedCornerEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._locations = {};
        for (const name of ['width', 'height', 'inset', 'radius'])
            this._locations[name] = this.get_uniform_location(name);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, CORNER_DECLARATIONS, CORNER_CODE, false);
    }

    setShape(width, height, inset, radius) {
        for (const [name, value] of Object.entries({width, height, inset, radius}))
            this.set_uniform_float(this._locations[name], 1, [value]);
        this.queue_repaint();
    }
});

/**
 * A blurred copy of the wallpaper, cut to a rounded rectangle.
 *
 * GNOME's background blur (Shell.BlurMode.BACKGROUND) can only blur a
 * rectangle, and its result can't be masked afterwards. Instead this actor
 * holds its own wallpaper actor, kept aligned with the real wallpaper on
 * screen, blurs it in ACTOR mode and then masks it with a rounded-corner
 * shader. It's sized `inset` larger than the visible shape on every side so
 * the blur doesn't fade towards transparent at the visible edges.
 */
export const RoundedBlur = GObject.registerClass(
class RoundedBlur extends St.Widget {
    constructor(monitorIndex) {
        super({clip_to_allocation: true});

        this._monitorIndex = monitorIndex;
        this._bgManager = new Background.BackgroundManager({
            container: this,
            monitorIndex,
            controlPosition: false,
        });
        this._bgManager.connect('changed', () => this._syncWallpaper());

        // Effects added later are applied first: blur, then cut the corners.
        this._corners = new RoundedCornerEffect();
        this.add_effect(this._corners);
        const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: BLUR_BRIGHTNESS});
        // GNOME 46 renamed 'sigma' to 'radius'.
        if ('radius' in blur)
            blur.radius = BLUR_RADIUS;
        else
            blur.sigma = BLUR_RADIUS / 2;
        this.add_effect(blur);

        this.connect('notify::allocation', () => this._syncWallpaper());
        this.connect('destroy', () => this._bgManager.destroy());
    }

    get inset() {
        return BLUR_RADIUS;
    }

    /** @param {number} radius - corner radius of the visible shape, in pixels */
    setCornerRadius(radius) {
        this._radius = radius;
        this._syncShape();
    }

    /** Call when this actor moves on screen without being reallocated (e.g. its parent is translated). */
    syncPosition() {
        this._syncWallpaper();
    }

    _syncShape() {
        const box = this.allocation;
        this._corners.setShape(box.get_width(), box.get_height(), this.inset, this._radius ?? 0);
    }

    // Shift our wallpaper copy so it lines up with the real one behind us.
    // Translation rather than position, so it never queues a relayout.
    _syncWallpaper() {
        this._syncShape();
        const wallpaper = this._bgManager.backgroundActor;
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!wallpaper || !monitor)
            return;
        const [x, y] = this.get_transformed_position();
        wallpaper.set_translation(monitor.x - x, monitor.y - y, 0);
    }
});
