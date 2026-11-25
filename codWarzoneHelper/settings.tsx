/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { tempVoiceSettings } from "../_tempVoice/presets";

export const GUILD_ID = "500074231544152074";

const PRESET_KEYS: ["presets"] = ["presets"];

export const settings = definePluginSettings({
    ...tempVoiceSettings({
        guildId: GUILD_ID,
        fields: { name: true, limit: true, privacy: true },
        description: "Each preset joins a create channel, waits for the bot to move you, then renames the new channel and sets its status, user limit and visibility.",
        usePresets: () => settings.use(PRESET_KEYS).presets,
        savePresets: presets => settings.store.presets = presets,
        defaultPresets: [
            { id: "rebirth-casual", name: "Rebirth Casual", status: "Casual Rebirth, jeder willkommen", creatorId: "1075199439704170516", limit: 0, privacy: "unchanged" }
        ]
    }),
    clickPanelOnCreate: {
        type: OptionType.BOOLEAN,
        description: "After creating a channel, click Logs and Activision IDs in its voice panel.",
        default: true
    },
    copyActivisionOnJoin: {
        type: OptionType.BOOLEAN,
        description: "When you join someone else's channel and others are in it, fetch their Activision IDs and copy the first one to your clipboard.",
        default: true
    }
});
