// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

import {RoundedCornerEffect} from './roundedBlur.js';
import {WallpaperCopy, trackOverviewProgress} from './wallpaper.js';

// Room above the strip for the card's rounded corners, in logical pixels.
// GNOME's card radius is 30.
const CORNER_ROOM = 40;

/**
 * The strip a bottom dock's strut reserves, carried along with the desktop
 * as the overview opens and closes.
 *
 * The overview shrinks the desktop from the work area (which excludes the
 * strut) into its card, so on its own the wallpaper beside the dock turns
 * into the overview's backdrop the moment the overview opens. This draws that
 * strip of wallpaper hanging off the bottom of the active workspace's card,
 * at the card's scale and lined up with its wallpaper, so the desktop shrinks
 * as one piece. The strip collapses as the overview opens, leaving GNOME's
 * own card once it's fully open, and its bottom corners follow the card's.
 * It overlaps the card's rounded bottom corners, showing the same wallpaper,
 * so there's no seam.
 *
 * It must follow the card within the same frame, so it's placed just before
 * each paint (after layout), and only through properties that don't need a
 * relayout: its translation, its wallpaper's scale and translation, and the
 * corner shader's uniforms. Its allocation stays fixed.
 */
export const OverviewStrip = GObject.registerClass(
class OverviewStrip extends WallpaperCopy {
    constructor(monitorIndex) {
        super(monitorIndex, {visible: false});

        this._inset = 0;
        this._progress = 0;
        this._painting = false;
        this._wallpaperTransform = null;
        this._card = null;
        this._corners = new RoundedCornerEffect();
        this.add_effect(this._corners);

        trackOverviewProgress(this, progress => {
            this._progress = progress;
            this._syncActive();
        });
        this.connect('destroy', () => global.stage.disconnectObject(this));
    }

    /** @param {number} inset - height of the reserved strip in pixels (0 when none) */
    setInset(inset) {
        if (this._inset === inset)
            return;
        this._inset = inset;

        // Fixed allocation along the bottom of the monitor, big enough for
        // the uncollapsed strip plus the card's corners above it.
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (inset > 0 && monitor) {
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            const height = inset + Math.ceil(CORNER_ROOM * scaleFactor);
            this.set_position(monitor.x, monitor.y + monitor.height - height);
            this.set_size(monitor.width, height);
        }
        this._syncActive();
    }

    syncPosition() {
        const wallpaper = this._bgManager.backgroundActor;
        if (!wallpaper || !this._wallpaperTransform)
            return;
        const {scale, x, y} = this._wallpaperTransform;
        wallpaper.set_pivot_point(0, 0);
        wallpaper.set_scale(scale, scale);
        wallpaper.set_translation(x, y, 0);
    }

    _syncActive() {
        const active = this._inset > 0 && Main.overview.visible && this._progress < 1;
        if (active && !this._painting) {
            global.stage.connectObject('before-paint', () => this._place(), this);
            this._painting = true;
        } else if (!active && this._painting) {
            global.stage.disconnectObject(this);
            this._painting = false;
        }
        if (active)
            this._place();
        else
            this.hide();
    }

    _place() {
        const card = this._findCard();
        const workarea = card?._workarea;
        const [cardX, cardY] = card?.get_transformed_position() ?? [];
        const [cardWidth, cardHeight] = card?.get_transformed_size() ?? [];
        // Before its first layout the card has no usable geometry.
        if (!card || ![cardX, cardY, cardWidth, cardHeight].every(Number.isFinite) ||
            cardWidth < 1 || !workarea?.width) {
            this.hide();
            return;
        }

        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const scale = cardWidth / workarea.width;
        // The card's own animation state, 0 on the desktop to 1 when open.
        const progress = Math.min(Math.max(card._stateAdjustment?.value ?? this._progress, 0), 1);
        // GNOME's corner radius for the card, in its wallpaper's pixels.
        const radius = (card._bgManager?.backgroundActor?.content?.rounded_clip_radius ?? 0) * scale;

        const [boxWidth, boxHeight] = this.get_size();
        const width = Math.min(cardWidth, boxWidth);
        const height = Math.min(radius + this._inset * scale * (1 - progress), boxHeight);
        const top = cardY + cardHeight - radius;

        this.set_translation(cardX - this.x, top - this.y, 0);
        this._corners.setShape(boxWidth, boxHeight, 0, Math.min(radius, height / 2), 0, width, height);
        // Monitor point (wa.x, wa.y) sits at the card's top-left corner.
        this._wallpaperTransform = {
            scale,
            x: scale * (monitor.x - workarea.x),
            y: cardY - top + scale * (monitor.y - workarea.y),
        };
        this.syncPosition();
        this.show();
    }

    // The background of the active workspace's card on our monitor. Cached,
    // since this runs every frame, until it stops being that card.
    _findCard() {
        const active = global.workspace_manager.get_active_workspace();
        const isOurs = actor => actor._monitorIndex === this._monitorIndex && actor.is_mapped() &&
            actor.get_parent()?.metaWorkspace === active;
        if (this._card && isOurs(this._card))
            return this._card;

        this._card?.disconnectObject(this);
        this._card = null;
        const walk = actor => {
            if (this._card)
                return;
            if (actor instanceof Workspace.WorkspaceBackground) {
                if (isOurs(actor))
                    this._card = actor;
                return;
            }
            actor.get_children().forEach(walk);
        };
        walk(Main.layoutManager.overviewGroup);
        this._card?.connectObject('destroy', () => (this._card = null), this);
        return this._card;
    }
});
