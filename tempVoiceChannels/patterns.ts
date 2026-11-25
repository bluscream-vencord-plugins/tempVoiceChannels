/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Text and patterns the core matches against channels and bot messages. */
export const PATTERNS = {
    /** Both bots mark their create channels with this in the name. */
    creatorMarker: "➕",
    /** A mention of the given user in message content, with or without the old nickname form. */
    mention: (userId: string) => new RegExp(`<@!?${userId}>`)
};
