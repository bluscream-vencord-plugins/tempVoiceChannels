/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FluxEvents } from "@vencord/discord-types";

/** Text and patterns the core matches against channels, bot messages and Discord's code. */
export const PATTERNS = {
    /** Both bots mark their create channels with this in the name. */
    creatorMarker: "➕",
    /** A mention of the given user in message content, with or without the old nickname form. */
    mention: (userId: string) => new RegExp(`<@!?${userId}>`),

    /** Kinds of IDs the profile scanner can find. Server plugins pick the ones that matter on their server. */
    idKinds: {
        /**
         * "DisplayName#1234567": a 2 to 16 character display name (Unicode letters allowed), "#", then a number,
         * usually 7 digits. 4 digit numbers are left out, those are almost always old Discord tags.
         */
        activision: {
            label: "Activision ID",
            // The patterns limit the name to 2 to 16 characters and the number to 5 to 9 digits.
            patterns: [
                /** After a separator like "Activision: ", where the name may contain spaces ("bist gut genuuug#3506506"). */
                /[:|=>`"'„“\-–][^\S\n]*(?<id>[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,14}[\p{L}\p{N}_.\-]#\d{5,9})(?!\d)/gu,
                /** An ID alone on its line, where the name may contain spaces too. */
                /^[^\S\n]*(?<id>[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,14}[\p{L}\p{N}_.\-]#\d{5,9})[^\S\n]*$/gmu,
                /** Anywhere else, without spaces in the name. */
                /(?<![\p{L}\p{N}_.\-#])(?<id>[\p{L}\p{N}][\p{L}\p{N}_.\-]{1,15}#\d{5,9})(?!\d)/gu
            ]
        }
    },

    /** Discord message component types the plugins read or fill in. */
    componentTypes: {
        actionRow: 1,
        textInput: 4,
        textDisplay: 10,
        label: 18
    },

    /** Discord events the plugins listen for or send. The flux handler key VOICE_STATE_UPDATES has to stay a literal. */
    events: {
        messageCreate: "MESSAGE_CREATE" satisfies FluxEvents,
        /** A bot panel can arrive new, get edited, or come in with a batch of loaded messages. */
        panelChanged: ["MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS"] satisfies FluxEvents[],
        messageArrived: ["MESSAGE_CREATE", "LOAD_MESSAGES_SUCCESS"] satisfies FluxEvents[],
        channelUpdated: ["CHANNEL_UPDATES"] satisfies FluxEvents[],
        /** ComponentDispatch event that scrolls the open chat to the newest message. */
        scrollToPresent: "SCROLLTO_PRESENT"
    },

    webpack: {
        /** Discord's function that sends a message component click (button, select) to a bot. */
        executeComponent: ["unarchiveThreadIfNecessary", "MESSAGE_COMPONENT"],
        /** The module that opens a bot's form when the bot answers a click with one. */
        modalManagerFind: '"interaction_iframe_modal"',
        modalCreateHandler: /INTERACTION_MODAL_CREATE:(\i)=>\{/
    }
};
