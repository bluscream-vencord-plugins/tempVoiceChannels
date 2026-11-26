# TempVoiceChannels

Equicord user plugin: a shared core for servers that use a temp voice channel bot (join a "➕ create" channel, the bot makes you your own channel and moves you there). On its own it does nothing; server plugins register how their server's bot works and get presets, menus and bot automation from this core.

## Server plugins

| Plugin | Server | Bot |
| --- | --- | --- |
| [codWarzoneHelper](https://github.com/bluscream-vencord-plugins/codWarzoneHelper) | ⭐ Call of Duty: Warzone & MW4 \| Deutschland | V3NOM: rename, status, user limit, visibility, voice logs, Activision IDs |
| [warzoneDeutschlandHelper](https://github.com/bluscream-vencord-plugins/warzoneDeutschlandHelper) | Call of Duty: Warzone Deutschland | Xavis: channel status |

## Install

Clone this repo and the server plugins you want into `src/userplugins`, next to each other, then rebuild Equicord:

```sh
cd src/userplugins
git clone https://github.com/bluscream-vencord-plugins/tempVoiceChannels
git clone https://github.com/bluscream-vencord-plugins/codWarzoneHelper
git clone https://github.com/bluscream-vencord-plugins/warzoneDeutschlandHelper
```

Update each with `git pull` in its folder. Keep this core up to date together with the server plugins, since they build on it.

Enabling a server plugin enables TempVoiceChannels automatically. The first time, Discord needs a restart, because this plugin patches how bot forms are shown.

## Features

- **Presets** per server: which create channel to join, plus whatever the server's bot can set (name, status, user limit, visibility). Edited in each server plugin's settings with collapsible cards and drag and drop ordering.
- **Right-click menus** on create channels, their categories, the server icon and the server name to create a channel from a preset.
- **Equicord Toolbox** section: one heading per server (icon, name and owner) that opens that plugin's settings, with all its presets below to create a channel from anywhere in Discord. When the toolbox groups plugins into submenus (with more than five plugins in it), clicking TempVoiceChannels itself opens the shared settings.
- **Manual creation:** joining a create channel yourself applies the first preset for it once the bot has moved you. Presets are only applied after the bot's own message confirms the new channel is yours.
- **Profile IDs:** when you join a channel with people, or someone joins yours, their server and global profiles are loaded (if not cached) and scanned for IDs like Activision IDs. What it finds is posted in the channel chat as a message only you can see. Server plugins choose which kinds of IDs to look for (`profileIds`); a kind is a label and regexes with a named `id` group, optionally with a minimum and maximum length for the whole ID (see `PATTERNS.idKinds` and `profileScanner.ts`).
- **Copy ID menu:** right-click someone in voice on a registered server for every ID known for them, from their profiles or a server's bot, each with its source.
- **Remembered IDs:** every ID found is stored on your computer (Equicord's DataStore) with when it was first and last seen, and never removed, so the Copy ID menu still offers it after someone deletes it, without waiting for Discord or a bot. Can be turned off and cleared in the settings.
- **Rejoinable own channels:** when you leave a channel you own (disconnecting or moving elsewhere), the leave is held back while the server plugin makes sure you can get back in (`prepareLeave`), then goes through. Nothing is held when there's nothing to do (e.g. you're alone, so the channel goes away anyway). It never takes longer than 12 seconds, you're told if it ran out of time, and leaving again meanwhile leaves right away and cancels it. Can be turned off. A channel counts as yours when the bot said you created it, or when the server plugin recognises you as its owner (`isOwner`), which also covers transfers and channels from before a reload.
- **Menu toggles:** each menu item (Create channel on channels, Create channel on the server, Copy ID) has its own setting.
- **Bot automation:** clicks the bot's panel buttons and fills its forms in the background instead of showing them.
- **Natural pacing:** every action waits a configurable, slightly randomised delay so the bot has time to respond. Flows stop on their own when you leave the channel.

## Writing a server plugin

Depend on the core and register your server in `start()`:

```ts
import { registerServer, TempVoiceServer, unregisterServer } from "../tempVoiceChannels";
import { serverSettings } from "../tempVoiceChannels/presets";

const server: TempVoiceServer = {
    name: "MyServerHelper", // must equal the plugin name
    guildId: () => settings.store.guildId,
    botId: () => settings.store.botId,
    presets: () => settings.store.presets,
    isPanel: m => /* the bot's control panel message */,
    isCreatedNotice: (m, userId) => /* the bot's "you created this channel" message */,
    async applyPreset(api, channelId, preset) { /* use api.pause, api.waitForPanel, api.clickButton, api.submitModal, api.setStatus */ }
};

export default definePlugin({
    name: "MyServerHelper",
    dependencies: ["TempVoiceChannels"],
    settings,
    start() { registerServer(server); },
    stop() { unregisterServer(server.name); }
});
```

`serverSettings(...)` gives the plugin its preset editor and hidden server and bot ID settings. Keep every string, regex and ID you match in a `PATTERNS` object (see `patterns.ts`), not inline.
