import {Autohide} from './autohide.js';
import {LaunchBounce} from './launchBounce.js';
import {Magnification} from './magnification.js';

/**
 * Feature registry. Each feature is a self-contained class:
 *
 *   constructor(dock, settings)  - store references only, no side effects
 *   enable()                     - connect signals, start doing things
 *   disable()                    - undo everything enable() did
 *
 * DockManager creates one instance per dock and calls enable()/disable()
 * around the dock's lifetime. To add a feature, create a module in this
 * folder and append its class here.
 */
export const FEATURES = [
    Magnification,
    LaunchBounce,
    Autohide,
];
