import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Geo from '../util/geometry.js';

const REMOVE_DELAY = 1000;
const LABEL_FADE_DURATION = 150;
const LABEL_GAP = 8;
const LAND_DURATION = 180;
const POOF_DURATION = 250;

/**
 * Drag pinned apps to reorder them, or drag one off the dock to remove it.
 *
 * Reordering moves the dragged item's (empty) slot through the other pinned
 * items as the pointer passes their centres, and commits the order to GNOME's
 * favourites on drop. Dragging clear of the dock starts a timer; once it runs
 * out a "Remove" label appears by the icon and releasing unpins the app.
 * Releasing earlier, or coming back over the dock, snaps the icon back.
 */
export class DragReorder {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._drag = null;
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
    }

    disable() {
        this._dock.disconnectObject(this);
        if (this._dock.dropHandler === this)
            this._dock.dropHandler = null;
        this._endDrag();
        for (const actor of [...this._animations])
            actor.destroy();
    }

    // ---- Drag lifecycle (signals from the dragged item) ----

    _onDragBegin(item) {
        this._endDrag();
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
            this._poof(drag.dragActor);
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
        const drag = this._drag;
        if (!drag)
            return;
        DND.removeDragMonitor(this._monitor);
        this._cancelRemoveTimer();
        this._drag = null;
        this._dock.setDragging(false);
    }

    // ---- Pointer tracking ----

    _onDragMotion(dragEvent) {
        const drag = this._drag;
        if (!drag)
            return DND.DragMotionResult.CONTINUE;
        drag.dragActor = dragEvent.dragActor;

        const outside = this._isOutsideDock(dragEvent.x, dragEvent.y);
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

    // ---- Drop target (called by Dock.handleDragOver/acceptDrop) ----

    handleDragOver(source) {
        const drag = this._drag;
        if (drag?.item !== source || drag.outside)
            return DND.DragMotionResult.CONTINUE;

        const vertical = Geo.isVertical(this._dock.edge);
        const [px, py] = global.get_pointer();
        const pointer = vertical ? py : px;

        // Index among the other pinned items: how many centres the pointer has passed.
        const passed = this._dock.getBaseCenters()
            .filter(({item, center}) => item.pinned && item !== source && center < pointer)
            .length;

        const items = this._dock.items;
        const first = items.findIndex(item => item.pinned);
        if (items.indexOf(source) !== first + passed)
            this._dock.moveItem(source, first + passed);

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, dragActor) {
        const drag = this._drag;
        if (drag?.item !== source || drag.outside)
            return false;

        const pos = this._dock.items.filter(item => item.pinned).indexOf(source);
        const current = this._dock.model.getApps().pinned.indexOf(source.app);
        this._land(source, dragActor);
        if (pos !== current)
            this._dock.model.moveTo(source.app, pos);
        return true;
    }

    // ---- Remove label ----

    _showRemoveLabel() {
        const drag = this._drag;
        if (!drag || drag.label)
            return;
        drag.label = new St.Label({style_class: 'macdock-tooltip', text: _('Remove'), opacity: 0});
        Main.uiGroup.add_child(drag.label);
        Shell.util_set_hidden_from_pick(drag.label, true);
        this._positionRemoveLabel();
        drag.label.ease({opacity: 255, duration: LABEL_FADE_DURATION});
    }

    _positionRemoveLabel() {
        const drag = this._drag;
        if (!drag?.label || !drag.dragActor)
            return;

        const [ax, ay] = drag.dragActor.get_transformed_position();
        const [aw, ah] = drag.dragActor.get_transformed_size();
        const [, lw] = drag.label.get_preferred_width(-1);
        const [, lh] = drag.label.get_preferred_height(lw);
        const gap = LABEL_GAP * this._dock.metrics.sf;

        // Beside the icon, on the side facing away from the dock's screen edge.
        let x, y;
        switch (this._dock.edge) {
        case Geo.Position.LEFT:
            [x, y] = [ax + aw + gap, ay + (ah - lh) / 2];
            break;
        case Geo.Position.RIGHT:
            [x, y] = [ax - lw - gap, ay + (ah - lh) / 2];
            break;
        default:
            [x, y] = [ax + (aw - lw) / 2, ay - lh - gap];
        }

        const mon = this._dock.monitor;
        x = Math.max(mon.x, Math.min(x, mon.x + mon.width - lw));
        y = Math.max(mon.y, Math.min(y, mon.y + mon.height - lh));
        drag.label.set_position(Math.round(x), Math.round(y));
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
        const [x, y] = item.icon.get_transformed_position();
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
    _poof(dragActor) {
        const actor = this._cloneDragActor(this._drag.item, dragActor);
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
