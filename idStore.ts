/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

const logger = new Logger("TempVoiceChannels");

/** One ID remembered for a user, with where it came from and when it was seen. */
export interface RememberedId {
    id: string;
    source: string;
    firstSeen: number;
    lastSeen: number;
}

/** A user's remembered IDs, keyed by the ID in lower case so the same ID isn't stored twice. */
type UserIds = Record<string, RememberedId>;

// Created on first use, so nothing touches the database while the plugin is off.
let store: DataStore.UseStore | undefined;
const getStore = () => store ??= DataStore.createStore("TempVoiceChannels", "rememberedIds");

/** Mirrors the database, so menus can read it instantly. */
const memory = new Map<string, UserIds>();
let enabled = () => true;

/** Loads everything remembered into memory. `isEnabled` is checked before anything new is stored. */
export async function loadRememberedIds(isEnabled: () => boolean) {
    enabled = isEnabled;
    try {
        for (const [userId, ids] of await DataStore.entries<string, UserIds>(getStore())) memory.set(userId, ids);
    } catch (err) {
        logger.error("Couldn't load the remembered IDs", err);
    }
}

/**
 * Remembers IDs seen for a user. Known ones only get a new "last seen" time and keep their first source.
 * Nothing is ever removed, so an ID someone deleted from their profile or the bot can still be looked up.
 */
export function rememberIds(userId: string, ids: { id: string; source: string; }[]) {
    if (!ids.length || !enabled()) return;
    const now = Date.now();
    const known: UserIds = { ...memory.get(userId) };
    for (const { id, source } of ids) {
        const key = id.toLowerCase();
        const existing = known[key];
        known[key] = existing ? { ...existing, lastSeen: now } : { id, source, firstSeen: now, lastSeen: now };
    }
    memory.set(userId, known);
    DataStore.set(userId, known, getStore()).catch(err => logger.error("Couldn't save remembered IDs", err));
}

/** Everything remembered for a user, most recently seen first. */
export function rememberedIds(userId: string) {
    return Object.values(memory.get(userId) ?? {}).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function rememberedCount() {
    let ids = 0;
    for (const user of memory.values()) ids += Object.keys(user).length;
    return { users: memory.size, ids };
}

export async function clearRememberedIds() {
    memory.clear();
    await DataStore.clear(getStore());
}
