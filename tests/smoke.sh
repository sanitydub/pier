#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Smoke test: runs Pier in a private, headless GNOME Shell and checks that it
# loads, survives every setting, the overview and being disabled, without any
# errors in the shell's log. Nothing touches your session: the shell gets its
# own D-Bus, in-memory GSettings and a throwaway data directory.
#
# Usage: make test   (or tests/smoke.sh)
# Needs: gnome-shell (with --headless), dbus-run-session, gdbus, python3.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/metadata.json")
HELPER=pier-test-helper@sanitydub.github.io

# Re-run inside a private session bus.
if [ "${PIER_TEST_INNER:-}" != 1 ]; then
    for tool in gnome-shell dbus-run-session gdbus python3; do
        command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
    done
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    # Background services started on the private bus are noisy, so their
    # output goes to a log; the test reports on file descriptor 3.
    PIER_TEST_INNER=1 PIER_TEST_WORK=$WORK timeout 180 dbus-run-session -- "$0" 3>&1 >"$WORK/session.log" 2>&1
    status=$?
    [ $status = 124 ] && echo "FAIL (timed out)"
    exit $status
fi

WORK=$PIER_TEST_WORK
exec 1>&3
mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/run"
chmod 700 "$WORK/run"
ln -s "$ROOT" "$WORK/data/gnome-shell/extensions/$UUID"
cp -r "$ROOT/tests/helper" "$WORK/data/gnome-shell/extensions/$HELPER"
glib-compile-schemas "$ROOT/schemas"

export GSETTINGS_BACKEND=memory XDG_DATA_HOME="$WORK/data" XDG_RUNTIME_DIR="$WORK/run"
unset WAYLAND_DISPLAY DISPLAY

gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 \
    --wayland-display=pier-test >"$WORK/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null' EXIT

BUS=(--session --dest org.gnome.Shell --object-path /org/gnome/Shell)
for _ in $(seq 1 30); do
    gdbus introspect "${BUS[@]}" >/dev/null 2>&1 && break
    sleep 1
done
sleep 3

call() { gdbus call "${BUS[@]}" --method "org.gnome.Shell.Extensions.$1" "${@:2}"; }
# Evaluate JS in the shell; prints the returned string.
ev() {
    gdbus call "${BUS[@]}" --method org.gnome.Shell.Eval "$1" | python3 -c '
import ast, re, sys
m = re.fullmatch(r"\((true|false), (.*)\)", sys.stdin.read().strip(), re.S)
if not m:
    print("EVAL FAILED: no reply")
else:
    value = ast.literal_eval(m.group(2))
    print(value if m.group(1) == "true" else "EVAL FAILED: " + value)'
}

FAILED=0
check() { # name, JS that evaluates to the string "ok" or a failure message
    local result
    result=$(ev "$2")
    if [ "$result" = '"ok"' ]; then
        echo "  ok    $1"
    else
        echo "  FAIL  $1: $result"
        FAILED=1
    fi
}

call EnableExtension "$HELPER" >/dev/null
call EnableExtension "$UUID" >/dev/null
sleep 2

echo "GNOME Shell $(gnome-shell --version | grep -oE '[0-9.]+$'), testing $UUID"

ev 'globalThis.pier = () => Main.extensionManager.lookup("'"$UUID"'");
globalThis.dock = () => Main.uiGroup.get_children().find(a => a.name === "pier");
globalThis.settings = () => pier().stateObj._manager._settings;
globalThis.expect = (cond, msg) => cond ? "ok" : msg;
Main.overview.hide(); "ready"' >/dev/null
sleep 1

check "extension is active" 'expect(pier()?.state === 1, `state ${pier()?.state}, error: ${pier()?.error}`)'
check "dock is on screen with items" 'expect(dock()?.mapped && dock().items.length > 0, "no dock or no items")'

for position in left right bottom; do
    ev "settings().set_string('position', '$position'); 'ok'" >/dev/null
    sleep 1
    check "position $position" "expect(dock()?.edge === '$position' && dock().mapped, 'edge ' + dock()?.edge)"
done

workArea='Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex)'
monitor='Main.layoutManager.primaryMonitor'
ev "settings().set_string('autohide-mode', 'off'); 'ok'" >/dev/null
sleep 1
check "autohide off reserves the dock's strip" "expect($workArea.y + $workArea.height < $monitor.y + $monitor.height, 'work area not reduced')"
for mode in intellihide always; do
    ev "settings().set_string('autohide-mode', '$mode'); 'ok'" >/dev/null
    sleep 1
    check "autohide $mode releases the strip" "expect($workArea.y + $workArea.height === $monitor.y + $monitor.height, 'work area still reduced')"
done
ev "settings().set_string('autohide-mode', 'off'); 'ok'" >/dev/null
sleep 1

for blur in true false true; do
    ev "settings().set_boolean('blur-background', $blur); 'ok'" >/dev/null
    sleep 0.5
    check "blur $blur" "expect(Boolean(dock()?._blurBg) === $blur, 'blur actor mismatch')"
    # Before the overview has been used (it's shown at login), the frosted
    # glass must still show on the desktop.
    [ $blur = true ] && check "frosted glass shown on the desktop" 'expect(!dock()?._blurBg || (dock()._blurBg.visible && dock()._blurBg.opacity === 255), `blur visible=${dock()?._blurBg?.visible} opacity=${dock()?._blurBg?.opacity}`)'
done
for mag in false true; do
    ev "settings().set_boolean('magnification-enabled', $mag); 'ok'" >/dev/null
    sleep 1
    check "magnification $mag" 'expect(dock()?.mapped, "dock missing after rebuild")'
done

ev 'Main.overview.show(); "ok"' >/dev/null; sleep 2
check "overview open" 'expect(Main.overview.visible && dock()?.mapped, "overview or dock not visible")'
ev 'Main.overview.showApps(); "ok"' >/dev/null; sleep 2
check "app grid open" 'expect(dock()?.mapped, "dock not visible")'
ev 'Main.overview.hide(); "ok"' >/dev/null; sleep 2
check "overview closed" 'expect(!Main.overview.visible && dock()?.mapped, "overview still visible")'

call DisableExtension "$UUID" >/dev/null; sleep 1
check "disable removes the dock and restores the dash" 'expect(!dock() && Main.overview.dash.height !== 0, "dock left behind or dash still hidden")'
call EnableExtension "$UUID" >/dev/null; sleep 2
check "re-enable" 'expect(pier()?.state === 1 && dock()?.mapped, `state ${pier()?.state}`)'

errors=$(call GetExtensionErrors "$UUID")
if [ "$errors" != "(@as [],)" ]; then
    echo "  FAIL  extension errors: $errors"
    FAILED=1
fi

kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null

# Errors and critical warnings logged by GNOME Shell, ignoring unrelated
# services that fail without a display in this headless session.
log_problems=$(grep -E 'JS ERROR|JS WARNING|CRITICAL|already disposed' "$WORK/shell.log" |
    grep -vE 'Screencast|xdg-desktop-portal|calendar-server|evolution' || true)
if [ -n "$log_problems" ]; then
    echo "  FAIL  problems in the shell log:"
    echo "$log_problems" | sed 's/^/        /' | head -20
    FAILED=1
else
    echo "  ok    no errors in the shell log"
fi

if [ $FAILED = 0 ]; then
    echo "PASS"
else
    echo "FAIL"
fi
exit $FAILED
