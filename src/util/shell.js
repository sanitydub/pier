// SPDX-License-Identifier: GPL-2.0-or-later

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

/** The running GNOME Shell's major version, e.g. 50. */
export const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split('.')[0]);
