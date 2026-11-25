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

const logger = new Logger("TempVoiceChannels");

/** A kind of ID to look for in profiles, like an Activision ID. See PATTERNS.idKinds for the built-in ones. */
export interface IdKind {
    /** Shown in the message, e.g. "Activision ID". */
    label: string;
    /**
     * Tried in order, each with a named group "id" around the ID itself. Put the most specific pattern first:
     * an ID found by a later pattern is dropped when it's only the tail end of one found earlier.
     */
    patterns: RegExp[];
    /** IDs shorter or longer than this are ignored. */
    minLength: number;
    maxLength: number;
}

/** Finds every ID of one kind in free text, without duplicates. */
export function findIds(text: string, kind: IdKind) {
    const found = new Map<string, string>();
    for (const pattern of kind.patterns) {
        for (const match of text.matchAll(pattern)) {
            const id = match.groups?.id?.trim();
            if (!id || id.length < kind.minLength || id.length > kind.maxLength) continue;
            const key = id.toLowerCase();
            // "Foo Bar#1234567" was already found with its full name, don't add "Bar#1234567" as well.
            if ([...found.keys()].some(known => known !== key && known.endsWith(key))) continue;
            found.set(key, id);
        }
    }
    return [...found.values()];
}

/** Loads the user's global and server profile, unless both are cached already. */
async function loadProfiles(userId: string, guildId: string) {
    if (UserProfileStore.getUserProfile(userId) && UserProfileStore.getGuildMemberProfile(userId, guildId)) return;
    await fetchUserProfile(userId, { guild_id: guildId }, false)
        .catch(err => logger.debug(`Couldn't load the profile of ${userId}`, err));
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

/** Users already scanned in a channel, so they aren't posted again until you leave it. */
const scanned = new Set<string>();

/**
 * Loads each user's profiles if they aren't cached, looks for the given kinds of IDs and posts what it finds
 * in the channel's chat as a message only you can see. Profiles are loaded one after another with a short
 * pause, to stay clear of Discord's rate limits.
 */
export async function scanProfiles(channelId: string, guildId: string, userIds: string[], kinds: IdKind[]) {
    if (!kinds.length) return;
    for (const userId of userIds) {
        const key = `${channelId}:${userId}`;
        if (scanned.has(key)) continue;
        scanned.add(key);

        await loadProfiles(userId, guildId);
        const text = profileText(userId, guildId);
        const lines = kinds.flatMap(kind => {
            const ids = findIds(text, kind);
            if (!ids.length) return [];
            return [`${kind.label}${ids.length > 1 ? "s" : ""} of <@${userId}> from their profile: ${ids.map(id => `\`${id}\``).join(", ")}`];
        });
        if (lines.length) sendBotMessage(channelId, { content: lines.join("\n") });
        await sleep(500 + Math.random() * 500);
    }
}

/** Forgets who was scanned in a channel once you leave it, so they're shown again next time. */
export function forgetScanned(channelId: string) {
    for (const key of scanned) if (key.startsWith(`${channelId}:`)) scanned.delete(key);
}
