// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DockManager} from './src/dockManager.js';

export default class PierExtension extends Extension {
    enable() {
        this._manager = new DockManager(this);
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;
    }
}
