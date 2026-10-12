// SPDX-License-Identifier: GPL-2.0-or-later

// Used only by tests/smoke.sh, inside a throwaway headless GNOME Shell.
// Unsafe mode lets the test call org.gnome.Shell.Eval to inspect the shell.
export default class PierTestHelper {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
