/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findComponent, getText } from "../tempVoiceChannels/components";

export function isPanel(components: unknown[] | undefined) {
    return !!findComponent(components, "rename_button") && !!findComponent(components, "activision_button");
}

export interface LogEntry {
    joined: boolean;
    name: string;
    level: number | null;
    time: string;
    userId: string;
}

export function parseLogs(components: unknown[] | undefined): LogEntry[] | null {
    const text = getText(components);
    if (!text.includes("VOICE CHANNEL LOGS")) return null;
    return [...text.matchAll(/\*\*`(🟢|🔴)` (.+?)\*\*\n-# `([\d:]+)` `(\d+)`/g)].map(([, dot, label, time, userId]) => {
        // "name 🔥103": the number is the user's level on the server, when the bot shows one.
        const level = label.match(/ 🔥(\d+)$/);
        return {
            joined: dot === "🟢",
            name: level ? label.slice(0, level.index) : label,
            level: level ? Number(level[1]) : null,
            time,
            userId
        };
    });
}

export interface ActivisionEntry {
    userId: string;
    activisionId: string;
}

export function parseActivision(components: unknown[] | undefined): ActivisionEntry[] | null {
    if (!findComponent(components, "editgamertag_button")) return null;
    return [...getText(components).matchAll(/von <@!?(\d+)>\*\*\s*```(?:\w+)?\n([^`]+?)\n?```/g)]
        .map(([, userId, activisionId]) => ({ userId, activisionId: activisionId.trim() }));
}
