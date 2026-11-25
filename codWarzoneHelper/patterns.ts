/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Everything this plugin matches in V3NOM's messages, buttons and forms. */
export const PATTERNS = {
    /** "🎮 Kanal erstellt von: @owner", posted in every new channel. */
    createdNotice: "Kanal erstellt von",

    buttons: {
        rename: "rename_button",
        limit: "limit_button",
        private: "private_button",
        public: "public_button",
        logs: "logs_button",
        activision: "activision_button",
        /** Only present in the bot's Activision IDs reply. */
        editGamertag: "editgamertag_button"
    },

    modals: {
        rename: { id: "rename_modal", name: "channel_name", status: "channel_status" },
        limit: { id: "limit_modal", limit: "channel_limit" }
    },

    logs: {
        header: "VOICE CHANNEL LOGS",
        /** "**`🟢` name 🔥103**\n-# `14:09:50` `userId`", 🟢 for a join and 🔴 for a leave. */
        entry: /\*\*`(🟢|🔴)` (.+?)\*\*\n-# `([\d:]+)` `(\d+)`/g,
        joined: "🟢",
        /** " 🔥103" at the end of a name: the user's level on the server. */
        level: / 🔥(\d+)$/
    },

    /** "**… von <@userId>** ```cs\nName#1234567```" */
    activisionEntry: /von <@!?(\d+)>\*\*\s*```(?:\w+)?\n([^`]+?)\n?```/g
};
