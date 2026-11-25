# warzoneVoiceHelpers

Equicord user plugins for the temp voice channel bots on two German Call of Duty Discord servers.

| Folder | What it is |
| --- | --- |
| `_tempVoice` | Shared core: preset editor, joining create channels, detecting your own channels, clicking bot buttons and filling bot forms. The leading `_` keeps Equicord from loading it as a plugin. |
| `codWarzoneHelper` | Plugin for "⭐ Call of Duty: Warzone & MW4 \| Deutschland" and its V3NOM bot: rename, status, user limit, visibility, voice logs and Activision IDs. |
| `warzoneDeutschlandHelper` | Plugin for "Call of Duty: Warzone Deutschland" and its Xavis bot: channel status. |

## Install

All three folders must sit directly in `src/userplugins`, because the plugins import the shared core with `../_tempVoice`. Either copy them there or link them, for example on Windows:

```powershell
foreach ($d in "_tempVoice", "codWarzoneHelper", "warzoneDeutschlandHelper") {
    New-Item -ItemType Junction -Path "src\userplugins\$d" -Target "path\to\warzoneVoiceHelpers\$d"
}
```

Then rebuild Equicord and enable the plugin for your server.

## Features

- Right-click a create channel, its category, the server icon or the server name to create a channel from a preset.
- Joining a create channel yourself applies the first preset for it once the bot has moved you.
- Presets are edited in the plugin settings with collapsible cards and drag and drop ordering.
- Every action waits a configurable, slightly randomised delay so the bot has time to respond.
- CodWarzoneHelper also copies the Activision ID of the people in a channel you join to your clipboard.
