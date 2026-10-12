// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, min, max, step, subtitle = '') {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.set_title(title);
    row.set_subtitle(subtitle);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** ComboRow for a string key with a fixed set of choices: [[value, label], ...]. */
function choiceRow(settings, key, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const values = choices.map(([value]) => value);

    const syncFromSettings = () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    syncFromSettings();
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, syncFromSettings);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function scaleRow(settings, key, title, min, max, step) {
    const row = new Adw.ActionRow({title});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
    scale.set_hexpand(true);
    scale.set_size_request(220, -1);
    scale.set_draw_value(false);
    scale.set_valign(Gtk.Align.CENTER);
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

export default class PierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        window.set_default_size(640, 720);

        window.add(this._appearancePage(settings));
        window.add(this._behaviourPage(settings));
        window.add(this._aboutPage());
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        layout.add(choiceRow(settings, 'position', _('Position on screen'), [
            ['bottom', _('Bottom')],
            ['left', _('Left')],
            ['right', _('Right')],
        ]));
        layout.add(spinRow(settings, 'icon-size', _('Icon size'), 24, 128, 2));
        layout.add(switchRow(settings, 'show-apps-button', _('Show Applications button')));
        page.add(layout);

        const magnification = new Adw.PreferencesGroup({title: _('Magnification')});
        magnification.add(switchRow(settings, 'magnification-enabled', _('Magnify icons on hover')));
        const size = spinRow(settings, 'magnification-size', _('Magnified size'), 24, 192, 2);
        const range = spinRow(settings, 'magnification-range', _('Spread'), 1, 6, 1,
            _('How many neighbouring icons grow with the hovered one'));
        for (const row of [size, range]) {
            settings.bind('magnification-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            magnification.add(row);
        }
        page.add(magnification);

        const style = new Adw.PreferencesGroup({title: _('Style')});
        style.add(scaleRow(settings, 'bg-opacity', _('Background opacity'), 0, 1, 0.05));
        style.add(switchRow(settings, 'blur-background', _('Blur background'),
            _('Frosted-glass effect. The blur is rectangular and ignores rounded corners.')));
        style.add(switchRow(settings, 'show-running-dots', _('Show running indicators')));
        page.add(style);

        return page;
    }

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Behaviour'),
            icon_name: 'preferences-system-symbolic',
        });

        const visibility = new Adw.PreferencesGroup({title: _('Visibility')});
        visibility.add(choiceRow(settings, 'autohide-mode', _('Autohide'), [
            ['off', _('Never hide')],
            ['always', _('Always hide')],
            ['intellihide', _('Hide when a window overlaps')],
        ], _('A hidden dock appears when you push the pointer against the screen edge')));
        page.add(visibility);

        const animation = new Adw.PreferencesGroup({title: _('Animation')});
        animation.add(switchRow(settings, 'animate-launch', _('Bounce icons while apps launch')));
        page.add(animation);

        return page;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: this.metadata.name,
            description: this.metadata.description,
        });
        group.add(new Adw.ActionRow({
            title: _('Version'),
            subtitle: this.metadata['version-name'] ?? String(this.metadata.version ?? ''),
        }));
        page.add(group);
        return page;
    }
}
