UUID := pier@sanitydub.github.io
SCHEMA := org.gnome.shell.extensions.pier.gschema.xml
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall enable disable pack nested logs clean

all: schemas

schemas:
	glib-compile-schemas schemas/

# Symlink this checkout into the extensions dir, so edits are picked up by the next shell start.
install: schemas
	mkdir -p "$(dir $(INSTALL_DIR))"
	rm -rf "$(INSTALL_DIR)"
	ln -s "$(CURDIR)" "$(INSTALL_DIR)"

uninstall:
	rm -rf "$(INSTALL_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Installable zip in dist/ (for gnome-extensions install or extensions.gnome.org)
pack:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=src \
		--schema=schemas/$(SCHEMA) \
		.

# Run a nested GNOME Shell in a window; the extension can be tested without logging out.
nested:
	@v=$$(gnome-shell --version | grep -oE '[0-9]+' | head -n1); \
	if [ "$$v" -ge 49 ]; then \
		dbus-run-session -- gnome-shell --devkit --wayland; \
	else \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000 dbus-run-session -- gnome-shell --nested --wayland; \
	fi

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf dist schemas/gschemas.compiled
