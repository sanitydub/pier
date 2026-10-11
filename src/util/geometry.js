import Clutter from 'gi://Clutter';

// Orientation helpers. Dock code thinks in two axes:
//   "along" - the direction icons are laid out in
//   "cross" - perpendicular to it, where 0 is the screen edge the dock is attached to

export const Position = Object.freeze({
    BOTTOM: 'bottom',
    LEFT: 'left',
    RIGHT: 'right',
});

export function isVertical(position) {
    return position === Position.LEFT || position === Position.RIGHT;
}

/**
 * Build an ActorBox inside a parent of size (width, height) from along/cross
 * coordinates, where cross 0 is the parent's side touching the screen edge.
 */
export function boxFromAxes(position, width, height, along1, along2, cross1, cross2) {
    switch (position) {
    case Position.LEFT:
        return new Clutter.ActorBox({x1: cross1, x2: cross2, y1: along1, y2: along2});
    case Position.RIGHT:
        return new Clutter.ActorBox({x1: width - cross2, x2: width - cross1, y1: along1, y2: along2});
    default:
        return new Clutter.ActorBox({x1: along1, x2: along2, y1: height - cross2, y2: height - cross1});
    }
}

/** The translation property that moves an actor along the cross axis. */
export function crossTranslationProperty(position) {
    return isVertical(position) ? 'translation_x' : 'translation_y';
}

/** +1 or -1: the sign of a cross-axis translation that moves away from the screen edge. */
export function awayFromEdgeSign(position) {
    return position === Position.LEFT ? 1 : -1;
}

export function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}
