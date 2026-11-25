/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Text and patterns the core matches against channels, bot messages and Discord's code. */
export const PATTERNS = {
    /** Both bots mark their create channels with this in the name. */
    creatorMarker: "➕",
    /** A mention of the given user in message content, with or without the old nickname form. */
    mention: (userId: string) => new RegExp(`<@!?${userId}>`),

    /** Discord message component types the plugins read or fill in. */
    componentTypes: {
        actionRow: 1,
        textInput: 4,
        textDisplay: 10,
        label: 18
    },

    webpack: {
        /** Discord's function that sends a message component click (button, select) to a bot. */
        executeComponent: ["unarchiveThreadIfNecessary", "MESSAGE_COMPONENT"],
        /** The module that opens a bot's form when the bot answers a click with one. */
        modalManagerFind: '"interaction_iframe_modal"',
        modalCreateHandler: /INTERACTION_MODAL_CREATE:(\i)=>\{/
    }
};
