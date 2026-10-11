import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AppDockItem, DockPlaceholder, DockSeparator, ShowAppsItem} from './dockItem.js';
import * as Geo from './util/geometry.js';

const REVEAL_DURATION = 220;
const SLIDE_DURATION = 180;
const TOOLTIP_GAP = 6;

// GNOME 50 dropped X11 and with it the 'affectsInputRegion' chrome parameter,
// which it now rejects. Only pass it to older shells, where X11 sessions need it.
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split('.')[0]);
const NO_INPUT_REGION = SHELL_MAJOR < 50 ? {affectsInputRegion: false} : {};

/** All dock geometry in physical pixels (logical * scale factor). */
function computeMetrics(settings) {
    const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const baseLogical = settings.get_int('icon-size');
    const maxLogical = settings.get_boolean('magnification-enabled')
        ? Math.max(baseLogical, settings.get_int('magnification-size'))
        : baseLogical;
    const base = baseLogical * sf;
    const itemPad = Math.round(4 * sf);

    return {
        sf,
        baseLogical,
        maxLogical,
        base,
        max: maxLogical * sf,
        itemPad, // along-axis padding on each side of an icon
        topPad: Math.round(6 * sf), // cross padding between icon and the dock's far side
        edgePad: Math.round(10 * sf), // cross padding towards the screen edge, holds the dot
        bgPad: Math.round(6 * sf), // background overhang past the first/last item
        gap: Math.round(6 * sf), // floating gap between background and screen edge
        dot: Math.round(5 * sf),
        sepAlong: Math.round(13 * sf),
        rangePx: settings.get_int('magnification-range') * (base + 2 * itemPad),
    };
}

function setBoxVertical(box, vertical) {
    // St.BoxLayout gained 'orientation' (and deprecated 'vertical') in GNOME 48.
    if ('orientation' in box)
        box.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    else
        box.vertical = vertical;
}

/**
 * The dock actor: a translucent background plus a box of items, anchored to
 * one edge of a monitor. Behaviour beyond layout (magnification, autohide,
 * bounce, ...) lives in features/ and drives the dock through its public API.
 */
export const Dock = GObject.registerClass({
    Signals: {
        'hover-changed': {},
        'menu-state-changed': {},
        'item-launching': {param_types: [GObject.TYPE_OBJECT]},
        'item-drag-begin': {param_types: [GObject.TYPE_OBJECT]},
        'item-drag-cancelled': {param_types: [GObject.TYPE_OBJECT]},
        'item-drag-end': {param_types: [GObject.TYPE_OBJECT, GObject.TYPE_BOOLEAN]},
        'drag-state-changed': {},
    },
}, class Dock extends St.Widget {
    constructor(settings, model, monitor, monitorIndex, openSettings) {
        super({name: 'macdock', reactive: true, track_hover: true});

        this._settings = settings;
        this.openSettings = openSettings;
        this.model = model;
        this.monitor = monitor;
        this.monitorIndex = monitorIndex;
        this.edge = settings.get_string('position');
        this.metrics = computeMetrics(settings);
        this.menuOpen = false;
        this.dragging = false;
        // Set by a feature to receive drag-over/drop on the dock (see handleDragOver).
        this.dropHandler = null;
        this._delegate = this;

        this._revealed = true;
        this._items = new Map();
        this._baseContentAlong = 0;
        this._totalCross = 0;
        this._blur = null;
        this._tooltipItem = null;
        this._tooltipLater = 0;
        this._plannedAlong = null; // item -> along position after a pending relayout

        this._background = new St.Widget({style_class: 'macdock-background'});
        this.add_child(this._background);

        this._box = new St.BoxLayout({style_class: 'macdock-box'});
        setBoxVertical(this._box, Geo.isVertical(this.edge));
        this.add_child(this._box);

        this.menuManager = new PopupMenu.PopupMenuManager(this);

        // Invisible full-width actor that reserves space (struts) so maximized
        // windows stop at the dock. Disabled while autohide is on.
        this._strut = new St.Widget({reactive: false});
        Main.layoutManager.addChrome(this._strut, {affectsStruts: true, ...NO_INPUT_REGION});
        Main.layoutManager.addChrome(this, {affectsStruts: false, trackFullscreen: true});

        this._tooltip = new St.Label({style_class: 'macdock-tooltip', visible: false});
        Main.layoutManager.addTopChrome(this._tooltip, {...NO_INPUT_REGION});

        // On shell shutdown the layout manager destroys these before the dock,
        // so drop our references rather than touching disposed actors later.
        this._strut.connect('destroy', () => (this._strut = null));
        this._tooltip.connect('destroy', () => (this._tooltip = null));

        this.connect('notify::hover', () => {
            if (!this.hover)
                this.hideTooltip();
            this.emit('hover-changed');
        });
        this.connect('destroy', this._onDestroy.bind(this));
        this.model.connectObject('changed', () => this._syncItems(), this);

        this._syncItems();
        this.syncStyle();
    }

    // ---- Public API used by items and features ----

    get showDots() {
        return this._settings.get_boolean('show-running-dots');
    }

    get revealed() {
        return this._revealed;
    }

    get items() {
        return this._box.get_children();
    }

    getItemForApp(app) {
        const id = app.get_id();
        return this._items.get(`pin:${id}`) ?? this._items.get(`app:${id}`) ?? null;
    }

    /** Index in items where pinned apps start (where the first one is, or would be). */
    get pinnedStartIndex() {
        const items = this.items;
        const first = items.findIndex(item => item.pinned);
        if (first >= 0)
            return first;
        return items[0] instanceof ShowAppsItem ? 1 : 0;
    }

    /** Move an item to @index in the dock without changing the app model. */
    moveItem(item, index) {
        this._slide(() => this._box.set_child_at_index(item, index));
    }

    /** Put items back in model order, undoing any moveItem(). */
    restoreOrder() {
        this._slide(() => this._syncItems());
    }

    /** Open an empty, growing gap at @index, e.g. for an app being dragged in. */
    insertPlaceholder(index) {
        const placeholder = new DockPlaceholder(this);
        this._box.insert_child_at_index(placeholder, index);
        this._updateGeometry();
        placeholder.animateAlong(placeholder.baseAlong);
        return placeholder;
    }

    /** Close @placeholder's gap (animated unless @animate is false) and remove it. */
    removePlaceholder(placeholder, animate = true) {
        const remove = () => {
            placeholder.destroy();
            this._updateGeometry();
        };
        if (animate)
            placeholder.animateAlong(0, remove);
        else
            remove();
    }

    // DND drop-target delegate; forwarded to the feature that handles drags.
    handleDragOver(source, actor, x, y) {
        return this.dropHandler?.handleDragOver(source, actor, x, y) ?? DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor) {
        return this.dropHandler?.acceptDrop(source, actor) ?? false;
    }

    /** Stage-coordinate centre of every item along the dock axis, at scale 1. */
    getBaseCenters() {
        const vertical = Geo.isVertical(this.edge);
        const [sx, sy] = this.get_transformed_position();
        const alongSize = vertical ? this.height : this.width;
        const items = this.items;

        let pos = (vertical ? sy : sx) + Math.round((alongSize - this._baseContentAlong) / 2);
        return items.map(item => {
            const center = pos + item.baseAlong / 2;
            pos += item.baseAlong;
            return {item, center};
        });
    }

    /** Stage rect covered by the unmagnified dock (including the edge gap) when shown. */
    getRevealedRect() {
        const m = this.metrics;
        const mon = this.monitor;
        const along = this._baseContentAlong + 2 * m.bgPad;
        const cross = m.gap + m.topPad + m.base + m.edgePad;

        switch (this.edge) {
        case Geo.Position.LEFT:
            return {x: mon.x, y: mon.y + (mon.height - along) / 2, width: cross, height: along};
        case Geo.Position.RIGHT:
            return {x: mon.x + mon.width - cross, y: mon.y + (mon.height - along) / 2, width: cross, height: along};
        default:
            return {x: mon.x + (mon.width - along) / 2, y: mon.y + mon.height - cross, width: along, height: cross};
        }
    }

    setRevealed(revealed, animate = true) {
        if (this._revealed === revealed)
            return;
        this._revealed = revealed;
        if (!revealed)
            this.hideTooltip();

        const prop = Geo.crossTranslationProperty(this.edge);
        const offset = revealed ? 0 : -Geo.awayFromEdgeSign(this.edge) * this._totalCross;
        this.ease({
            [prop]: offset,
            opacity: revealed ? 255 : 0,
            duration: animate ? REVEAL_DURATION : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    setStrutsEnabled(enabled) {
        if (this._strut)
            this._strut.visible = enabled;
    }

    setDragging(dragging) {
        if (this.dragging === dragging)
            return;
        this.dragging = dragging;
        if (dragging)
            this.hideTooltip();
        this.emit('drag-state-changed');
    }

    setMenuOpen(open) {
        this.menuOpen = open;
        if (open)
            this.hideTooltip();
        this.emit('menu-state-changed');
    }

    /** Apply settings that don't need the dock rebuilt. */
    syncStyle() {
        const opacity = this._settings.get_double('bg-opacity');
        const radius = Math.round(this.metrics.baseLogical * 0.36);
        this._background.set_style(
            `background-color: rgba(28, 28, 30, ${opacity.toFixed(2)}); border-radius: ${radius}px;`);

        this._syncBlur();

        for (const item of this.items)
            item.syncDot();
    }

    hideTooltip() {
        this._tooltipItem = null;
        this._tooltip?.hide();
    }

    // ---- Items ----

    _syncItems() {
        const {pinned, running} = this.model.getApps();
        const wanted = [];
        const keys = new Set();
        const add = (key, create) => {
            let item = this._items.get(key);
            if (!item) {
                item = create();
                this._items.set(key, item);
                this._connectItem(item);
            }
            keys.add(key);
            wanted.push(item);
        };

        if (this._settings.get_boolean('show-apps-button'))
            add('show-apps', () => new ShowAppsItem(this));
        // Pinned and running items use different keys so (un)pinning recreates
        // the item, giving it (or taking away) its draggable.
        for (const app of pinned)
            add(`pin:${app.get_id()}`, () => new AppDockItem(this, app, true));
        if (running.length > 0 && wanted.length > 0)
            add('separator', () => new DockSeparator(this));
        for (const app of running)
            add(`app:${app.get_id()}`, () => new AppDockItem(this, app));

        for (const [key, item] of this._items) {
            if (!keys.has(key)) {
                this._items.delete(key);
                item.destroy();
            }
        }

        // Placeholders (gaps for apps being dragged in) aren't part of the
        // model; keep them where they are among the items.
        const placeholders = this.items
            .filter(item => item instanceof DockPlaceholder)
            .map(item => [item, this.items.indexOf(item)]);

        wanted.forEach((item, i) => {
            if (item.get_parent() === this._box)
                this._box.set_child_at_index(item, i);
            else
                this._box.insert_child_at_index(item, i);
        });
        for (const [placeholder, index] of placeholders)
            this._box.set_child_at_index(placeholder, index);

        this._updateGeometry();
    }

    _connectItem(item) {
        item.connect('notify::hover', () => {
            if (item.hover && !this.menuOpen && !this.dragging && item.tooltipText)
                this._showTooltip(item);
            else if (this._tooltipItem === item)
                this.hideTooltip();
        });
        item.connect('notify::allocation', () => {
            if (this._tooltipItem === item)
                this._queueTooltipUpdate();
        });
        item.connect('destroy', () => {
            if (this._tooltipItem === item)
                this.hideTooltip();
        });
    }

    // ---- Geometry ----

    _updateGeometry() {
        const m = this.metrics;
        const mon = this.monitor;
        const vertical = Geo.isVertical(this.edge);

        this._baseContentAlong = this.items.reduce((sum, item) => sum + item.baseAlong, 0);

        // Leave room for magnified icons pushing their neighbours outward,
        // without covering the whole screen edge with an input-catching actor.
        const magExtra = m.max > m.base
            ? (m.max - m.base) * (2 * this._settings.get_int('magnification-range') + 1)
            : 0;
        const monAlong = vertical ? mon.height : mon.width;
        const along = Math.min(monAlong, this._baseContentAlong + 2 * m.bgPad + magExtra);
        const cross = m.gap + m.topPad + m.max + m.edgePad;
        const strutCross = m.gap + m.topPad + m.base + m.edgePad;
        this._totalCross = cross;

        switch (this.edge) {
        case Geo.Position.LEFT:
            this.set_position(mon.x, mon.y + Math.round((mon.height - along) / 2));
            this.set_size(cross, along);
            this._strut.set_position(mon.x, mon.y);
            this._strut.set_size(strutCross, mon.height);
            break;
        case Geo.Position.RIGHT:
            this.set_position(mon.x + mon.width - cross, mon.y + Math.round((mon.height - along) / 2));
            this.set_size(cross, along);
            this._strut.set_position(mon.x + mon.width - strutCross, mon.y);
            this._strut.set_size(strutCross, mon.height);
            break;
        default:
            this.set_position(mon.x + Math.round((mon.width - along) / 2), mon.y + mon.height - cross);
            this.set_size(along, cross);
            this._strut.set_position(mon.x, mon.y + mon.height - strutCross);
            this._strut.set_size(mon.width, strutCross);
        }
    }

    /**
     * Run @reorder, which changes the order of items, then slide every item
     * that moved from where it was drawn to its new place.
     */
    _slide(reorder) {
        const vertical = Geo.isVertical(this.edge);
        const prop = vertical ? 'translation_y' : 'translation_x';
        const allocStart = actor => vertical ? actor.allocation.y1 : actor.allocation.x1;
        const size = actor => vertical
            ? actor.get_preferred_height(-1)[1]
            : actor.get_preferred_width(-1)[1];

        // Where each item is drawn now. Allocations are stale if an earlier
        // reorder hasn't been laid out yet, so prefer what that one planned.
        const before = new Map();
        for (const item of this.items) {
            const laidOut = this._plannedAlong?.get(item) ?? allocStart(this._box) + allocStart(item);
            before.set(item, laidOut + item[prop]);
        }

        reorder();

        // Where each item will be laid out: the box is centred in the dock.
        const items = this.items;
        const total = items.reduce((sum, item) => sum + size(item), 0);
        let pos = Math.round(((vertical ? this.height : this.width) - total) / 2);
        this._plannedAlong = new Map();
        for (const item of items) {
            this._plannedAlong.set(item, pos);
            const from = before.get(item);
            if (from !== undefined && Math.abs(from - pos) >= 1) {
                item.remove_transition(prop.replace('_', '-'));
                item[prop] = from - pos;
                item.ease({
                    [prop]: 0,
                    duration: SLIDE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            pos += size(item);
        }
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        this._plannedAlong = null;

        const m = this.metrics;
        const width = box.get_width();
        const height = box.get_height();
        const vertical = Geo.isVertical(this.edge);

        let boxAlong, boxCross;
        if (vertical) {
            [, boxCross] = this._box.get_preferred_width(-1);
            [, boxAlong] = this._box.get_preferred_height(boxCross);
        } else {
            [, boxAlong] = this._box.get_preferred_width(-1);
            [, boxCross] = this._box.get_preferred_height(boxAlong);
        }

        const alongSize = vertical ? height : width;
        const a1 = Math.round((alongSize - boxAlong) / 2);
        const bgCross = m.topPad + m.base + m.edgePad;

        this._background.allocate(Geo.boxFromAxes(this.edge, width, height,
            a1 - m.bgPad, a1 + boxAlong + m.bgPad, m.gap, m.gap + bgCross));
        this._box.allocate(Geo.boxFromAxes(this.edge, width, height,
            a1, a1 + boxAlong, m.gap, m.gap + boxCross));
    }

    // ---- Look ----

    _syncBlur() {
        const wanted = this._settings.get_boolean('blur-background');
        if (wanted && !this._blur) {
            this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.9});
            // GNOME 46 renamed 'sigma' to 'radius'.
            if ('radius' in this._blur)
                this._blur.radius = 40;
            else
                this._blur.sigma = 20;
            this._background.add_effect_with_name('macdock-blur', this._blur);
        } else if (!wanted && this._blur) {
            this._background.remove_effect(this._blur);
            this._blur = null;
        }
    }

    // ---- Tooltip ----

    _showTooltip(item) {
        this._tooltipItem = item;
        this._tooltip.text = item.tooltipText;
        this._tooltip.show();
        this._positionTooltip();
    }

    _queueTooltipUpdate() {
        if (this._tooltipLater)
            return;
        this._tooltipLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._tooltipLater = 0;
            this._positionTooltip();
            return GLib.SOURCE_REMOVE;
        });
    }

    _positionTooltip() {
        const item = this._tooltipItem;
        if (!item)
            return;

        const [ix, iy] = item.get_transformed_position();
        const [iw, ih] = item.get_transformed_size();
        const [, lw] = this._tooltip.get_preferred_width(-1);
        const [, lh] = this._tooltip.get_preferred_height(lw);
        const gap = TOOLTIP_GAP * this.metrics.sf;
        const mon = this.monitor;

        let x, y;
        switch (this.edge) {
        case Geo.Position.LEFT:
            [x, y] = [ix + iw + gap, iy + (ih - lh) / 2];
            break;
        case Geo.Position.RIGHT:
            [x, y] = [ix - lw - gap, iy + (ih - lh) / 2];
            break;
        default:
            [x, y] = [ix + (iw - lw) / 2, iy - lh];
        }

        x = Math.max(mon.x, Math.min(x, mon.x + mon.width - lw));
        y = Math.max(mon.y, Math.min(y, mon.y + mon.height - lh));
        this._tooltip.set_position(Math.round(x), Math.round(y));
    }

    _onDestroy() {
        if (this._tooltipLater) {
            global.compositor.get_laters().remove(this._tooltipLater);
            this._tooltipLater = 0;
        }
        this._tooltip?.destroy();
        this._strut?.destroy();
        this._items.clear();
    }
});
