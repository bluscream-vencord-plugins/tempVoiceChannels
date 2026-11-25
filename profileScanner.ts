/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { fetchUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { GuildMemberStore, UserProfileStore, UserStore } from "@webpack/common";

import { rememberIds } from "./idStore";

const logger = new Logger("TempVoiceChannels");

/** A kind of ID to look for in profiles, like an Activision ID. See PATTERNS.idKinds for the built-in ones. */
export interface IdKind {
    /** Shown in the message, e.g. "Activision ID". */
    label: string;
    /**
     * Tried in order, each with a named group "id" around the ID itself. When one ID is only part of another
     * ("Bar#1234567" in "Foo-Bar#1234567"), the longer one is kept, whichever pattern found it.
     */
    patterns: RegExp[];
    /**
     * Optional limits on the whole ID's length. Usually the patterns' own quantifiers are enough; use these when
     * the total length is easier to state than the length of each part.
     */
    minLength?: number;
    maxLength?: number;
}

/** Where an ID came from, as shown in the Copy ID menu and stored with remembered IDs. */
export const PROFILE_SOURCE = "profile";

/**
 * Whether `part` is just a piece of `whole`: its tail ("bar#1234567" of "foo bar#1234567")
 * or, for a name found without a number, its name ("foo" of "foo#1234567").
 */
const isPartOf = (part: string, whole: string) => part !== whole && (whole.endsWith(part) || whole.startsWith(`${part}#`));

/** Finds every ID of one kind in free text, without duplicates. */
export function findIds(text: string, kind: IdKind) {
    const found = new Map<string, string>();
    for (const pattern of kind.patterns) {
        for (const match of text.matchAll(pattern)) {
            const id = match.groups?.id?.trim();
            if (!id || id.length < (kind.minLength ?? 0) || id.length > (kind.maxLength ?? Infinity)) continue;
            const key = id.toLowerCase();
            if ([...found.keys()].some(known => isPartOf(key, known))) continue;
            for (const known of found.keys()) if (isPartOf(known, key)) found.delete(known);
            found.set(key, id);
        }
    }
    return [...found.values()];
}

const profilesCached = (userId: string, guildId: string) =>
    !!UserProfileStore.getUserProfile(userId) && !!UserProfileStore.getGuildMemberProfile(userId, guildId);

/** Profile loads in progress, so asking twice doesn't send two requests. */
const loading = new Map<string, Promise<void>>();
/** Profiles that were requested already; some server profiles never end up in the cache, so they aren't asked for again. */
const requested = new Set<string>();

/** Loads the user's global and server profile, unless both are cached or were already requested. */
function loadProfiles(userId: string, guildId: string) {
    const key = `${guildId}:${userId}`;
    if (profilesCached(userId, guildId) || requested.has(key)) return Promise.resolve();
    const pending = loading.get(key);
    if (pending) return pending;

    const load = fetchUserProfile(userId, { guild_id: guildId }, false)
        .then(() => { requested.add(key); })
        .catch(err => logger.debug(`Couldn't load the profile of ${userId}`, err))
        .finally(() => loading.delete(key));
    loading.set(key, load);
    return load;
}

/** Everything in a user's profiles that people tend to put IDs in. */
function profileText(userId: string, guildId: string) {
    const global = UserProfileStore.getUserProfile(userId);
    const member = UserProfileStore.getGuildMemberProfile(userId, guildId);
    return [
        GuildMemberStore.getNick(guildId, userId),
        UserStore.getUser(userId)?.globalName,
        member?.bio,
        member?.pronouns,
        global?.bio,
        global?.pronouns
    ].filter(Boolean).join("\n");
}

/** The IDs of one kind in a user's loaded profiles, remembered for later. */
function profileIds(userId: string, guildId: string, kind: IdKind) {
    const ids = findIds(profileText(userId, guildId), kind);
    rememberIds(userId, ids.map(id => ({ id, source: PROFILE_SOURCE })));
    return ids;
}

/** Looks up one kind of ID in a user's profiles, loading them first if they aren't cached. */
export async function lookupIds(userId: string, guildId: string, kind: IdKind) {
    await loadProfiles(userId, guildId);
    return profileIds(userId, guildId, kind);
}

/**
 * The IDs of one kind in a user's profiles, from cache only, for places that can't wait like menus. It doesn't
 * remember anything, so opening a menu changes nothing. Returns null and starts loading when nothing is cached yet.
 */
export function cachedIds(userId: string, guildId: string, kind: IdKind) {
    if (!profilesCached(userId, guildId) && !requested.has(`${guildId}:${userId}`)) {
        loadProfiles(userId, guildId);
        return null;
    }
    return findIds(profileText(userId, guildId), kind);
}

/** Users already scanned in a channel, so they aren't posted again until you leave it. */
const scanned = new Set<string>();

export interface ScanOptions {
    /** Called when something was posted. */
    onFound?(): void;
    /** IDs already shown another way, e.g. by the server's bot. They're left out so the same ID isn't posted twice. */
    knownIds?(userId: string): string[];
    /** Checked before each user; the scan stops once this is false, e.g. after you left the channel. */
    isActive(): boolean;
}

/**
 * Loads each user's profiles if they aren't cached, looks for the given kinds of IDs and posts what it finds
 * in the channel's chat as a message only you can see. Profiles are loaded one after another with a short
 * pause, to stay clear of Discord's rate limits.
 */
export async function scanProfiles(channelId: string, guildId: string, userIds: string[], kinds: IdKind[], options: ScanOptions) {
    if (!kinds.length) return;
    for (const userId of userIds) {
        if (!options.isActive()) return;
        const key = `${channelId}:${userId}`;
        if (scanned.has(key)) continue;

        await loadProfiles(userId, guildId);
        if (!options.isActive()) return;
        scanned.add(key);

        const known = new Set((options.knownIds?.(userId) ?? []).map(id => id.toLowerCase()));
        const lines = kinds.flatMap(kind => {
            const ids = profileIds(userId, guildId, kind).filter(id => !known.has(id.toLowerCase()));
            if (!ids.length) return [];
            return [`${kind.label}${ids.length > 1 ? "s" : ""} of <@${userId}> from their profile: ${ids.map(id => `\`${id}\``).join(", ")}`];
        });
        if (lines.length) {
            sendBotMessage(channelId, { content: lines.join("\n") });
            options.onFound?.();
        }
        await sleep(500 + Math.random() * 500);
    }
}

/** Forgets who was scanned in a channel once you leave it, so they're shown again next time. */
export function forgetScanned(channelId?: string) {
    for (const key of scanned) if (!channelId || key.startsWith(`${channelId}:`)) scanned.delete(key);
}
