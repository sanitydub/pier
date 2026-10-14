// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {WallpaperCopy, trackOverviewProgress} from './wallpaper.js';

const BLUR_RADIUS = 40;
const BLUR_BRIGHTNESS = 0.9;

// Fades out everything outside a rounded rectangle of size box_w x box_h
// whose top-left corner is `inset` in from the actor's, with a one-pixel
// anti-aliased rim. The top corners can have their own radius. d is the
// signed distance to the rounded rectangle's edge.
const CORNER_DECLARATIONS = `
uniform float width;
uniform float height;
uniform float inset;
uniform float box_w;
uniform float box_h;
uniform float radius;
uniform float top_radius;
`;
const CORNER_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * vec2(width, height);
vec2 half_box = vec2(box_w, box_h) * 0.5;
vec2 rel = p - (vec2(inset) + half_box);
float r = rel.y < 0.0 ? top_radius : radius;
vec2 q = abs(rel) - half_box + vec2(r);
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

/**
 * The shape is `inset` in from the actor's edges on every side, unless a
 * smaller box size is given, which is anchored `inset` from the top-left.
 */
function setShape(width, height, inset, radius, topRadius = radius,
    boxWidth = width - 2 * inset, boxHeight = height - 2 * inset) {
    const uniforms = {width, height, inset, radius, top_radius: topRadius, box_w: boxWidth, box_h: boxHeight};
    for (const [name, value] of Object.entries(uniforms))
        this._setUniform(name, value);
    this.queue_repaint();
}

// GNOME 51 replaced Shell.GLSLEffect with Clutter.ShaderEffect, which takes
// its snippet from vfunc_get_static_snippet() and sets uniforms by name. A
// class can't declare a virtual function its parent lacks, so define the
// effect against whichever base this Shell has.
const RoundedCornerEffectClass = Shell.GLSLEffect
    ? class RoundedCornerEffect extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, CORNER_DECLARATIONS, CORNER_CODE, false);
        }

        _setUniform(name, value) {
            this._locations ??= {};
            this._locations[name] ??= this.get_uniform_location(name);
            this.set_uniform_float(this._locations[name], 1, [value]);
        }
    }
    : class RoundedCornerEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, CORNER_DECLARATIONS, CORNER_CODE);
        }

        _setUniform(name, value) {
            this.set_uniform_float(name, 1, [value]);
        }
    };
RoundedCornerEffectClass.prototype.setShape = setShape;

export const RoundedCornerEffect = GObject.registerClass(RoundedCornerEffectClass);

/**
 * A blurred copy of the wallpaper, cut to a rounded rectangle.
 *
 * GNOME's background blur (Shell.BlurMode.BACKGROUND) can only blur a
 * rectangle, and its result can't be masked afterwards. Instead this blurs
 * its own copy of the wallpaper in ACTOR mode and then masks it with a
 * rounded-corner shader. It's sized `inset` larger than the visible shape on
 * every side so the blur doesn't fade towards transparent at the visible edges.
 */
export const RoundedBlur = GObject.registerClass(
class RoundedBlur extends WallpaperCopy {
    constructor(monitorIndex) {
        super(monitorIndex);

        // Effects added later are applied first: blur, then cut the corners.
        this._corners = new RoundedCornerEffect();
        this.add_effect(this._corners);
        this.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: BLUR_BRIGHTNESS,
        }));

        this.connect('notify::allocation', () => this._syncShape());

        // In the overview GNOME shrinks the desktop (and its wallpaper) into a
        // card over a dark backdrop, so our wallpaper no longer matches what's
        // behind the dock. Fade out as the overview opens, and skip the blur
        // entirely once fully faded.
        trackOverviewProgress(this, progress => {
            this.opacity = Math.round(255 * (1 - progress));
            this.visible = this.opacity > 0;
        });
    }

    get inset() {
        return BLUR_RADIUS;
    }

    /** @param {number} radius - corner radius of the visible shape, in pixels */
    setCornerRadius(radius) {
        this._radius = radius;
        this._syncShape();
    }

    _syncShape() {
        const box = this.allocation;
        this._corners.setShape(box.get_width(), box.get_height(), this.inset, this._radius ?? 0);
    }
});
