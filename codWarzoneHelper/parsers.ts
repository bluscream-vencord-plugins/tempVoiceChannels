/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findComponent, getText } from "../tempVoiceChannels/components";
import { PATTERNS } from "./patterns";

export function isPanel(components: unknown[] | undefined) {
    return !!findComponent(components, PATTERNS.buttons.rename) && !!findComponent(components, PATTERNS.buttons.activision);
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
    if (!text.includes(PATTERNS.logs.header)) return null;
    return [...text.matchAll(PATTERNS.logs.entry)].map(([, dot, label, time, userId]) => {
        const level = label.match(PATTERNS.logs.level);
        return {
            joined: dot === PATTERNS.logs.joined,
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
    if (!findComponent(components, PATTERNS.buttons.editGamertag)) return null;
    return [...getText(components).matchAll(PATTERNS.activisionEntry)]
        .map(([, userId, activisionId]) => ({ userId, activisionId: activisionId.trim() }));
}
