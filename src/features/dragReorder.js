// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppDockItem} from '../dockItem.js';
import * as Geo from '../util/geometry.js';

const REMOVE_DELAY = 500;
const LABEL_FADE_DURATION = 150;
const LABEL_GAP = 8;
const LAND_DURATION = 180;
const POOF_DURATION = 250;
// How long a dropped-in app's gap waits for the favourites to update.
const PIN_TIMEOUT = 1000;

/**
 * Drag and drop on the dock's pinned apps.
 *
 * - Drag a pinned app along the dock to reorder it. Its empty slot slides
 *   through the other pinned apps as the pointer passes their centres, and
 *   the order is saved to GNOME's favourites on drop.
 * - Drag a pinned app clear of the dock to remove it. After a short delay a
 *   "Remove" label appears by the icon, and releasing unpins the app.
 *   Releasing earlier, coming back over the dock or pressing Escape snaps it back.
 * - Drag an app from the overview (e.g. the app grid) onto the dock to pin it
 *   where it's dropped; a gap opens to show where. An app that's already
 *   pinned is moved instead.
 */
export class DragReorder {
    constructor(dock) {
        this._dock = dock;
        this._drag = null; // one of our pinned items being dragged
        this._ext = null; // an app being dragged in from the overview
        this._pending = null; // a dropped-in app waiting for the favourites to update
        this._monitor = {dragMotion: event => this._onDragMotion(event)};
        this._animations = new Set();
        this._landing = new Set(); // items whose icon is still flying into place
    }

    enable() {
        this._dock.dropHandler = this;
        this._dock.connectObject(
            'item-drag-begin', (dock, item) => this._onDragBegin(item),
            'item-drag-cancelled', (dock, item) => this._onDragCancelled(item),
            'item-drag-end', (dock, item) => this._onDragEnd(item),
            this);
        Main.overview.connectObject(
            'item-drag-begin', (overview, source) => this._onExternalBegin(source),
            'item-drag-cancelled', (overview, source) => this._onExternalCancelled(source),
            'item-drag-end', (overview, source) => this._onExternalEnd(source),
            this);
        // Connected after the dock's own handler, so the new item already exists.
        this._dock.model.connectObject('changed', () => this._resolvePending(), this);
    }

    disable() {
        this._dock.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._dock.model.disconnectObject(this);
        if (this._dock.dropHandler === this)
            this._dock.dropHandler = null;
        this._endDrag();
        this._endExternal();
        if (this._pending?.timeoutId)
            GLib.source_remove(this._pending.timeoutId);
        this._pending = null;
        for (const actor of [...this._animations])
            actor.destroy();
    }

    // ---- Dragging our own pinned items ----

    _onDragBegin(item) {
        this._endDrag();
        this._endExternal();
        this._drag = {item, dragActor: null, outside: false, removed: false, timeoutId: 0, label: null};
        DND.addDragMonitor(this._monitor);
        item.setSlotEmpty(true);
        this._dock.setDragging(true);
    }

    _onDragCancelled(item) {
        const drag = this._drag;
        if (drag?.item !== item)
            return;

        // DND cancels both on Escape and on a release over nothing that accepts
        // the drop. Only the latter removes, and only once the label is showing.
        const event = Clutter.get_current_event();
        const released = event &&
            [Clutter.EventType.BUTTON_RELEASE, Clutter.EventType.TOUCH_END].includes(event.type());

        if (drag.label && released && drag.dragActor) {
            drag.removed = true;
            this._poof(item, drag.dragActor);
            // With the drag actor gone DND skips its snap-back and ends the drag.
            drag.dragActor.destroy();
            this._dock.model.unpin(item.app);
        } else {
            this._dock.restoreOrder();
        }
    }

    _onDragEnd(item) {
        if (this._drag?.item !== item)
            return;
        const {removed} = this._drag;
        this._endDrag();
        // A removed item is destroyed when the model updates; a landing one is
        // revealed when its animation finishes.
        if (!removed && !this._landing.has(item))
            item.setSlotEmpty(false);
    }

    _endDrag() {
        if (!this._drag)
            return;
        DND.removeDragMonitor(this._monitor);
        this._cancelRemoveTimer();
        this._drag = null;
        this._dock.setDragging(false);
    }

    // ---- Dragging an app in from the overview ----

    _isExternalSource(source) {
        return source?.app instanceof Shell.App && !(source instanceof AppDockItem);
    }

    _onExternalBegin(source) {
        if (!this._isExternalSource(source) || this._drag)
            return;
        this._endExternal();
        // slot: the gap showing where the app will land; either a placeholder
        // or, for an app that's already pinned, that app's own (emptied) item.
        this._ext = {source, app: source.app, slot: null, isPlaceholder: false, dropped: false};
        DND.addDragMonitor(this._monitor);
        this._dock.setDragging(true);
    }

    _onExternalCancelled(source) {
        if (this._ext?.source === source)
            this._clearExternalSlot();
    }

    _onExternalEnd(source) {
        if (this._ext?.source === source)
            this._endExternal();
    }

    _endExternal() {
        if (!this._ext)
            return;
        if (!this._ext.dropped)
            this._clearExternalSlot();
        DND.removeDragMonitor(this._monitor);
        this._ext = null;
        this._dock.setDragging(false);
    }

    _clearExternalSlot() {
        const ext = this._ext;
        if (!ext?.slot)
            return;
        if (ext.isPlaceholder) {
            this._dock.removePlaceholder(ext.slot);
        } else {
            ext.slot.fadeIn();
            this._dock.restoreOrder();
        }
        ext.slot = null;
    }

    /** After pinning a dropped-in app: swap its gap for the new item. */
    _resolvePending() {
        const pending = this._pending;
        if (!pending)
            return;
        this._pending = null;
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);

        const item = this._dock.getItemForApp(pending.app);
        if (item?.pinned) {
            // The new item sits right next to the gap: drop the gap in the same frame.
            this._dock.removePlaceholder(pending.placeholder, false);
            item.fadeIn();
        } else {
            this._dock.removePlaceholder(pending.placeholder);
        }
    }

    // ---- Pointer tracking ----

    _onDragMotion(dragEvent) {
        const outside = this._isOutsideDock(dragEvent.x, dragEvent.y);

        if (this._ext) {
            if (outside)
                this._clearExternalSlot();
            return DND.DragMotionResult.CONTINUE;
        }

        const drag = this._drag;
        if (!drag)
            return DND.DragMotionResult.CONTINUE;
        drag.dragActor = dragEvent.dragActor;

        if (outside !== drag.outside) {
            drag.outside = outside;
            if (outside) {
                this._dock.restoreOrder();
                drag.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOVE_DELAY, () => {
                    drag.timeoutId = 0;
                    this._showRemoveLabel();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._cancelRemoveTimer();
            }
        }

        this._positionRemoveLabel();
        return DND.DragMotionResult.CONTINUE;
    }

    _isOutsideDock(x, y) {
        const r = this._dock.getRevealedRect();
        const margin = this._dock.metrics.base / 2;
        return x < r.x - margin || x > r.x + r.width + margin ||
            y < r.y - margin || y > r.y + r.height + margin;
    }

    /** Where @slot belongs among the pinned items, as an index into the dock's items. */
    _targetIndex(slot) {
        const vertical = Geo.isVertical(this._dock.edge);
        const [px, py] = global.get_pointer();
        const pointer = vertical ? py : px;

        // How many of the other pinned items' centres the pointer has passed.
        const passed = this._dock.getBaseCenters()
            .filter(({item, center}) => item.pinned && item !== slot && center < pointer)
            .length;
        return this._dock.pinnedStartIndex + passed;
    }

    _moveSlot(slot) {
        const index = this._targetIndex(slot);
        if (this._dock.items.indexOf(slot) !== index)
            this._dock.moveItem(slot, index);
    }

    // ---- Drop target (called by Dock.handleDragOver/acceptDrop) ----

    handleDragOver(source) {
        const drag = this._drag;
        if (drag?.item === source) {
            if (drag.outside)
                return DND.DragMotionResult.CONTINUE;
            this._moveSlot(source);
            return DND.DragMotionResult.MOVE_DROP;
        }

        const ext = this._ext;
        if (ext?.source === source) {
            if (!ext.slot) {
                const existing = this._dock.getItemForApp(ext.app);
                if (existing?.pinned) {
                    ext.slot = existing;
                    ext.isPlaceholder = false;
                    existing.setSlotEmpty(true);
                } else {
                    ext.slot = this._dock.insertPlaceholder(this._targetIndex(null));
                    ext.isPlaceholder = true;
                }
            }
            this._moveSlot(ext.slot);
            return ext.isPlaceholder ? DND.DragMotionResult.COPY_DROP : DND.DragMotionResult.MOVE_DROP;
        }

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, dragActor) {
        const drag = this._drag;
        if (drag?.item === source) {
            if (drag.outside)
                return false;
            const pos = this._pinnedIndex(source);
            const current = this._dock.model.pinnedIndex(source.app);
            this._land(source, dragActor);
            if (pos !== current)
                this._dock.model.moveTo(source.app, pos);
            return true;
        }

        const ext = this._ext;
        if (ext?.source === source && ext.slot) {
            const pos = this._pinnedIndex(ext.slot);
            ext.dropped = true;
            if (ext.isPlaceholder) {
                this._pending = {
                    app: ext.app,
                    placeholder: ext.slot,
                    timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, PIN_TIMEOUT, () => {
                        this._pending.timeoutId = 0;
                        this._resolvePending();
                        return GLib.SOURCE_REMOVE;
                    }),
                };
                this._dock.model.pinAt(ext.app, pos);
            } else {
                const current = this._dock.model.pinnedIndex(ext.app);
                ext.slot.fadeIn();
                if (pos !== current)
                    this._dock.model.moveTo(ext.app, pos);
            }
            ext.slot = null;
            return true;
        }

        return false;
    }

    _pinnedIndex(slot) {
        return this._dock.items.filter(item => item.pinned).indexOf(slot);
    }

    // ---- Remove label ----

    _showRemoveLabel() {
        const drag = this._drag;
        if (!drag || drag.label)
            return;
        drag.label = new St.Label({style_class: 'pier-tooltip', text: _('Remove'), opacity: 0});
        Main.uiGroup.add_child(drag.label);
        Shell.util_set_hidden_from_pick(drag.label, true);
        this._positionRemoveLabel();
        drag.label.ease({opacity: 255, duration: LABEL_FADE_DURATION});
    }

    _positionRemoveLabel() {
        const drag = this._drag;
        if (!drag?.label || !drag.dragActor)
            return;

        const [, lw] = drag.label.get_preferred_width(-1);
        const [, lh] = drag.label.get_preferred_height(lw);
        drag.label.set_position(...Geo.placeBeside(this._dock.edge,
            [...drag.dragActor.get_transformed_position(), ...drag.dragActor.get_transformed_size()],
            lw, lh, LABEL_GAP * this._dock.metrics.sf, this._dock.monitor));
    }

    _cancelRemoveTimer() {
        const drag = this._drag;
        if (!drag)
            return;
        if (drag.timeoutId) {
            GLib.source_remove(drag.timeoutId);
            drag.timeoutId = 0;
        }
        drag.label?.destroy();
        drag.label = null;
    }

    // ---- Drop animations ----

    /** Copy of @item's drag actor placed exactly over @dragActor, which DND is about to destroy. */
    _cloneDragActor(item, dragActor) {
        const actor = item.getDragActor();
        actor.set_position(dragActor.x, dragActor.y);
        actor.set_scale(dragActor.scale_x, dragActor.scale_y);
        Main.uiGroup.add_child(actor);
        this._animations.add(actor);
        actor.connect('destroy', () => this._animations.delete(actor));
        return actor;
    }

    /** Fly the dropped icon into its slot, then reveal the real icon. */
    _land(item, dragActor) {
        const actor = this._cloneDragActor(item, dragActor);
        // Aim for where the slot ends up, not where it is mid-slide.
        let [x, y] = item.icon.get_transformed_position();
        x -= item.translation_x;
        y -= item.translation_y;
        const scale = item.icon.get_transformed_size()[0] / actor.width;

        this._landing.add(item);
        const itemDestroyId = item.connect('destroy', () => this._landing.delete(item));
        actor.connect('destroy', () => {
            if (!this._landing.delete(item))
                return; // item was destroyed meanwhile
            item.disconnect(itemDestroyId);
            item.setSlotEmpty(false);
        });
        actor.ease({
            x, y,
            scale_x: scale,
            scale_y: scale,
            duration: LAND_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => actor.destroy(),
        });
    }

    /** Fade the removed icon out while it grows slightly. */
    _poof(item, dragActor) {
        const actor = this._cloneDragActor(item, dragActor);
        actor.set_pivot_point(0.5, 0.5);
        actor.ease({
            opacity: 0,
            scale_x: actor.scale_x * 1.4,
            scale_y: actor.scale_y * 1.4,
            duration: POOF_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => actor.destroy(),
        });
    }
}
