# warzoneVoiceHelpers

Equicord user plugins for the temp voice channel bots on two German Call of Duty Discord servers.

| Folder | Plugin | What it does |
| --- | --- | --- |
| `tempVoiceChannels` | TempVoiceChannels | Shared core the server plugins depend on. Owns the shared settings (action delay, open chat, apply preset on manual create), the right-click "Create channel" menus, joining create channels, detecting channels you created yourself, clicking bot buttons and filling bot forms in the background. Enabled automatically by the server plugins. |
| `codWarzoneHelper` | CodWarzoneHelper | "⭐ Call of Duty: Warzone & MW4 \| Deutschland" and its V3NOM bot: rename, status, user limit, visibility, voice logs, Activision IDs, and copying the Activision ID of people in a channel you join. |
| `warzoneDeutschlandHelper` | WarzoneDeutschlandHelper | "Call of Duty: Warzone Deutschland" and its Xavis bot: channel status. |

Each server plugin registers its bot with TempVoiceChannels when it starts. Its server and bot IDs are stored as hidden settings with the defaults above. They have no UI, but can be changed in the settings file without touching the code.

## Install

All three folders must sit directly in `src/userplugins`, because the server plugins import the core with `../tempVoiceChannels`. Keep this repo inside `src/userplugins` under a name starting with `.` (Equicord skips those folders) and link the plugin folders next to it, for example on Windows:

```powershell
cd src\userplugins
git clone https://github.com/bluscream-vencord-plugins/warzoneVoiceHelpers .warzoneVoiceHelpers
foreach ($d in "tempVoiceChannels", "codWarzoneHelper", "warzoneDeutschlandHelper") {
    New-Item -ItemType Junction -Path $d -Target ".warzoneVoiceHelpers\$d"
}
```

The checkout has to stay inside the Equicord source tree; otherwise the build can't resolve Equicord's `@utils/…` imports. Then rebuild Equicord and enable the plugin for your server. The first time, Discord needs a restart, because TempVoiceChannels patches how bot forms are shown.

## Features

- Right-click a create channel, its category, the server icon or the server name to create a channel from a preset.
- The Equicord Toolbox has a TempVoiceChannels section: one heading per server (its icon, name and owner) that opens that plugin's settings, with all its presets below to create a channel from anywhere in Discord. Clicking TempVoiceChannels itself opens the shared settings.
- Joining a create channel yourself applies the first preset for it once the bot has moved you. Presets are only applied after the bot's own message confirms the new channel is yours.
- Presets are edited in each server plugin's settings with collapsible cards and drag and drop ordering. Only the fields that server's bot supports are shown.
- Every action waits a configurable, slightly randomised delay so the bot has time to respond.
