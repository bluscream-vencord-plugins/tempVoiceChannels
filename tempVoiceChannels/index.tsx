/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, FluxEvents, Guild, Message } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { AuthenticationStore, ChannelActions, ChannelRouter, ChannelStore, ComponentDispatch, Constants, FluxDispatcher, Menu, MessageStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UserStore, VoiceStateStore } from "@webpack/common";

import { Component, findComponent, getText } from "./components";
import { creatorLabel, Preset, withDefaults } from "./presets";

const logger = new Logger("TempVoiceChannels");

const executeComponent: (args: Record<string, unknown>) => Promise<void> = findByCodeLazy("unarchiveThreadIfNecessary", "MESSAGE_COMPONENT");
const MessageActions = findByPropsLazy("fetchMessages", "sendMessage");

const settings = definePluginSettings({
    actionDelay: {
        type: OptionType.NUMBER,
        description: "Average milliseconds to wait between actions, like clicking a bot button and setting the status. Each wait varies a little so it feels natural.",
        default: 2000,
        isValid: (v: number) => v >= 100 && v <= 30_000 || "Pick a delay between 100 and 30000 milliseconds."
    },
    presetOnManualCreate: {
        type: OptionType.BOOLEAN,
        description: "When you create a channel yourself by joining a create channel, apply the first preset for that create channel once the bot has moved you.",
        default: true
    },
    openChat: {
        type: OptionType.BOOLEAN,
        description: "When a server plugin creates or joins a channel for you, open its chat so you can see what it clicked and what the bot replied.",
        default: true
    }
});

export type ModalValues = Record<string, string>;

/** What a server plugin registers: how its temp voice bot works. */
export interface TempVoiceServer {
    name: string;
    guildId(): string;
    botId(): string;
    presets(): Preset[];
    /** The bot message with the channel's control buttons. */
    isPanel(message: Message): boolean;
    /** The bot message that says the given user created this channel. */
    isCreatedNotice(message: Message, userId: string): boolean;
    /** Applies everything a preset sets, after the bot moved you into your new channel. */
    applyPreset(api: TempVoiceApi, channelId: string, preset: Preset): Promise<void>;
    /** Runs when you join a channel that you didn't just create and that has other people in it. */
    onJoinOthers?(api: TempVoiceApi, channelId: string, others: string[]): Promise<void>;
}

export interface TempVoiceApi {
    logger: Logger;
    /** The ranges are tuned for the default 2000 ms delay and scale with the setting. */
    pause(min: number, max: number): Promise<void>;
    fail(text: string): void;
    openChat(channelId: string): void;
    scrollToBottom(): void;
    waitFor<T>(check: () => T | null | undefined, events: FluxEvents[], timeout: number): Promise<T | null>;
    waitForPanel(channelId: string): Promise<Message | null>;
    clickButton<T>(panel: Message, customId: string, parse?: (components: Component[] | undefined) => T | null): Promise<T | null>;
    submitModal(panel: Message, button: string, modalId: string, values: ModalValues, applied: () => boolean, what: string): Promise<void>;
    setStatus(channelId: string, status: string): Promise<void>;
}

const servers = new Map<string, TempVoiceServer>();

export function registerServer(server: TempVoiceServer) {
    servers.set(server.name, server);
}

export function unregisterServer(name: string) {
    servers.delete(name);
}

const serverFor = (guildId: string | undefined) => [...servers.values()].find(s => s.guildId() === guildId);

export const isCreator = (channel: Channel | undefined) => !!channel && !!serverFor(channel.guild_id) && channel.name.includes("➕");

interface RawMessage {
    author?: { id: string; };
    components?: Component[];
    interaction_metadata?: { interacted_message_id?: string; };
}

interface ModalCreate {
    id: string;
    channelId: string;
    customId: string;
    application: { id: string; };
    components: Component[];
}

// Fills text fields by their custom id and keeps the bot's prefilled value for any field not given.
function fillModal(list: Component[], values: ModalValues): unknown[] {
    return list.map(c => {
        if (c.type === 1) return { type: 1, components: fillModal(c.components ?? [], values) };
        if (c.type === 18 && c.component) return { type: 18, component: fillModal([c.component], values)[0] };
        if (c.type === 4) return { type: 4, custom_id: c.customId, value: values[c.customId ?? ""] ?? c.value ?? "" };
        return { type: c.type };
    });
}

let pendingModal: { channelId: string; modalId: string; values: ModalValues; opened: boolean; } | null = null;
let creating = false;
let lastVoiceChannel: string | null = null;

const myVoiceChannel = () => SelectedChannelStore.getVoiceChannelId() ?? null;

function managedServer(id: string | null) {
    const channel = id ? ChannelStore.getChannel(id) : undefined;
    if (!channel?.isGuildVoice() || channel.name.includes("➕")) return null;
    return serverFor(channel.guild_id) ?? null;
}

function findBotMessage(server: TempVoiceServer, channelId: string, match: (m: Message) => boolean) {
    let found: Message | null = null;
    MessageStore.getMessages(channelId).forEach(m => {
        if (m.author.id === server.botId() && match(m)) found = m;
    });
    return found as Message | null;
}

function waitFor<T>(check: () => T | null | undefined, events: FluxEvents[], timeout: number): Promise<T | null> {
    return new Promise(resolve => {
        const first = check();
        if (first) return resolve(first);
        const done = (value: T | null) => {
            clearTimeout(timer);
            events.forEach(e => FluxDispatcher.unsubscribe(e, listener));
            resolve(value);
        };
        const listener = () => {
            const value = check();
            if (value) done(value);
        };
        const timer = setTimeout(() => done(null), timeout);
        events.forEach(e => FluxDispatcher.subscribe(e, listener));
    });
}

function makeApi(server: TempVoiceServer): TempVoiceApi {
    const serverLogger = new Logger(server.name);

    const api: TempVoiceApi = {
        logger: serverLogger,
        pause: (min, max) => sleep((min + Math.random() * (max - min)) * settings.store.actionDelay / 2000),
        fail: text => showToast({ text, variant: "critical" }),

        openChat(channelId) {
            if (settings.store.openChat && SelectedChannelStore.getChannelId() !== channelId)
                ChannelRouter.transitionToChannel(channelId);
        },

        scrollToBottom: () => ComponentDispatch.dispatch("SCROLLTO_PRESENT"),
        waitFor,

        waitForPanel(channelId) {
            const find = () => findBotMessage(server, channelId, server.isPanel);
            if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
            return waitFor(find, ["MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS"], 20_000);
        },

        // Clicks a panel button and resolves with the first bot reply to that click that the parser accepts.
        clickButton<T>(panel: Message, customId: string, parse?: (components: Component[] | undefined) => T | null) {
            const button = findComponent(panel.components, customId);
            const channel = ChannelStore.getChannel(panel.channel_id);
            if (!button || !channel) {
                serverLogger.warn(`Button ${customId} not found`);
                return Promise.resolve(null);
            }

            const reply = new Promise<T | null>(resolve => {
                if (!parse) return resolve(null);
                const listener = ({ message }: { message: RawMessage; }) => {
                    if (message.author?.id !== server.botId() || message.interaction_metadata?.interacted_message_id !== panel.id) return;
                    const parsed = parse(message.components);
                    if (parsed) done(parsed);
                };
                const done = (value: T | null) => {
                    clearTimeout(timer);
                    FluxDispatcher.unsubscribe("MESSAGE_CREATE", listener);
                    resolve(value);
                };
                const timer = setTimeout(() => done(null), 15_000);
                FluxDispatcher.subscribe("MESSAGE_CREATE", listener);
            });

            executeComponent({
                componentType: button.type,
                messageId: panel.id,
                messageFlags: panel.flags,
                customId,
                componentId: button.id,
                applicationId: panel.applicationId ?? panel.author.id,
                channelId: channel.id,
                guildId: channel.guild_id
            }).catch(err => serverLogger.error(`Clicking ${customId} failed`, err));
            return reply;
        },

        // Clicks a panel button that opens a bot form, fills it in the background and waits until applied() holds.
        async submitModal(panel, button, modalId, values, applied, what) {
            const pending = pendingModal = { channelId: panel.channel_id, modalId, values, opened: false };
            api.clickButton(panel, button, components => getText(components) || null)
                .then(reply => serverLogger.info(`${what}: bot replied`, reply ?? "nothing"));
            const ok = await waitFor(() => applied() || null, ["CHANNEL_UPDATES"], 15_000);
            pendingModal = null;
            if (ok) return;
            api.fail(pending.opened ? `${what} didn't go through. The bot got the form but didn't apply it.` : `${what} didn't go through. The bot never opened its form.`);
            serverLogger.warn(`${what} failed`, { opened: pending.opened, values });
        },

        async setStatus(channelId, status) {
            await RestAPI.put({ url: `/channels/${channelId}/voice-status`, body: { status } })
                .catch(err => {
                    api.fail("Setting the channel status didn't go through.");
                    serverLogger.warn("Setting status failed", err);
                });
        }
    };
    return api;
}

async function runPreset(server: TempVoiceServer, channelId: string, preset: Preset) {
    try {
        await server.applyPreset(makeApi(server), channelId, preset);
    } finally {
        pendingModal = null;
    }
}

const fail = (text: string) => showToast({ text, variant: "critical" });

async function createChannel(server: TempVoiceServer, preset: Preset) {
    if (creating) return fail("Already creating a channel.");
    if (!ChannelStore.getChannel(preset.creatorId)) return fail(`The create channel for ${preset.name || "this preset"} doesn't exist anymore.`);
    creating = true;
    try {
        ChannelActions.selectVoiceChannel(preset.creatorId);
        const channelId = await waitFor(() => {
            const id = myVoiceChannel();
            return managedServer(id) ? id : null;
        }, ["VOICE_STATE_UPDATES", "VOICE_CHANNEL_SELECT"], 20_000);
        if (!channelId) return fail("The bot didn't move you to a new channel.");
        lastVoiceChannel = channelId;
        await runPreset(server, channelId, preset);
    } finally {
        creating = false;
    }
}

// You joined a create channel yourself and the bot moved you into a new one.
async function onManualCreate(server: TempVoiceServer, creatorId: string, channelId: string) {
    const preset = server.presets().map(withDefaults).find(p => p.creatorId === creatorId);
    if (!settings.store.presetOnManualCreate || !preset) return;

    creating = true;
    try {
        const me = UserStore.getCurrentUser().id;
        const find = () => findBotMessage(server, channelId, m => server.isCreatedNotice(m, me));
        if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
        const notice = await waitFor(find, ["MESSAGE_CREATE", "LOAD_MESSAGES_SUCCESS"], 20_000);
        if (!notice || myVoiceChannel() !== channelId) return;
        await runPreset(server, channelId, preset);
    } finally {
        creating = false;
    }
}

async function onJoin(server: TempVoiceServer, channelId: string) {
    if (!server.onJoinOthers) return;
    const api = makeApi(server);
    await api.pause(2000, 3000);
    const me = UserStore.getCurrentUser().id;
    const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId)).filter(id => id !== me);
    if (others.length && myVoiceChannel() === channelId) await server.onJoinOthers(api, channelId, others);
}

function CreateMenu(server: TempVoiceServer, presets: Preset[], withCategory: boolean) {
    const menuId = `vc-tempvoice-${server.name.toLowerCase()}`;
    return (
        <Menu.MenuItem id={`${menuId}-create`} label="Create channel">
            {presets.length
                ? presets.map(preset => (
                    <Menu.MenuItem
                        key={preset.id}
                        id={`${menuId}-create-${preset.id}`}
                        label={preset.name || creatorLabel(preset.creatorId)}
                        subtext={withCategory ? creatorLabel(preset.creatorId) : preset.status || undefined}
                        action={() => createChannel(server, preset)}
                    />
                ))
                : <Menu.MenuItem id={`${menuId}-none`} label="No presets here yet, add some in the plugin settings" disabled />}
        </Menu.MenuItem>
    );
}

const channelMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    const server = serverFor(channel?.guild_id);
    if (!channel || !server) return;
    const presets = server.presets().map(withDefaults)
        .filter(p => p.creatorId === channel.id || ChannelStore.getChannel(p.creatorId)?.parent_id === channel.id);
    if (isCreator(channel) || presets.length) children.push(<Menu.MenuSeparator />, CreateMenu(server, presets, false));
};

const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    const server = serverFor(guild?.id);
    if (server) children.push(<Menu.MenuSeparator />, CreateMenu(server, server.presets().map(withDefaults), true));
};

export default definePlugin({
    name: "TempVoiceChannels",
    description: "Shared core for temp voice channel bot plugins: channel presets, joining create channels and handling bot panels. Enabled automatically by the server plugins that need it.",
    authors: [{ name: "Bluscream", id: 467777925790564352n }],
    settings,

    patches: [
        {
            find: '"interaction_iframe_modal"',
            replacement: {
                match: /INTERACTION_MODAL_CREATE:(\i)=>\{/,
                replace: "$&if($self.interceptModal($1))return;"
            }
        }
    ],

    // Fills a bot form the plugin asked for in the background instead of showing it.
    interceptModal(e: ModalCreate) {
        if (!pendingModal || e.channelId !== pendingModal.channelId || e.customId !== pendingModal.modalId) return false;
        pendingModal.opened = true;
        RestAPI.post({
            url: Constants.Endpoints.INTERACTIONS,
            body: {
                type: 5,
                application_id: e.application.id,
                channel_id: e.channelId,
                guild_id: ChannelStore.getChannel(e.channelId)?.guild_id,
                data: { id: e.id, custom_id: e.customId, components: fillModal(e.components, pendingModal.values) },
                session_id: AuthenticationStore.getSessionId(),
                nonce: SnowflakeUtils.fromTimestamp(Date.now())
            }
        }).catch(err => logger.error("Form submit failed", err));
        return true;
    },

    contextMenus: {
        "channel-context": channelMenu,
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu
    },

    flux: {
        VOICE_STATE_UPDATES() {
            const current = myVoiceChannel();
            const previous = lastVoiceChannel;
            if (current === previous) return;
            lastVoiceChannel = current;
            const server = managedServer(current);
            if (creating || !server || !current) return;
            const previousChannel = previous ? ChannelStore.getChannel(previous) : undefined;
            if (previous && previousChannel?.guild_id === server.guildId() && previousChannel.name.includes("➕")) onManualCreate(server, previous, current);
            else onJoin(server, current);
        }
    }
});
