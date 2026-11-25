/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import type { Channel, FluxEvents, Guild, Message } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { AuthenticationStore, ChannelActions, ChannelRouter, ChannelStore, ComponentDispatch, Constants, FluxDispatcher, GuildChannelStore, Menu, MessageStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UserStore, VoiceStateStore } from "@webpack/common";

import { Component, findComponent, getText } from "./components";
import { Preset, withDefaults } from "./presets";

const executeComponent: (args: Record<string, unknown>) => Promise<void> = findByCodeLazy("unarchiveThreadIfNecessary", "MESSAGE_COMPONENT");
const MessageActions = findByPropsLazy("fetchMessages", "sendMessage");

export interface TempVoiceStore {
    presets: Preset[];
    actionDelay: number;
    openChat: boolean;
    presetOnManualCreate: boolean;
}

export type ModalValues = Record<string, string>;

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

export interface TempVoiceConfig {
    name: string;
    guildId: string;
    botId: string;
    store(): TempVoiceStore;
    /** The bot message with the channel's control buttons. */
    isPanel(message: Message): boolean;
    /** The bot message that says the given user created this channel. */
    isCreatedNotice(message: Message, userId: string): boolean;
    /** Applies everything a preset sets, after the bot moved you into your new channel. */
    applyPreset(api: TempVoiceApi, channelId: string, preset: Preset): Promise<void>;
    /** Runs when you join a channel that you didn't just create and that has other people in it. */
    onJoinOthers?(api: TempVoiceApi, channelId: string, others: string[]): Promise<void>;
}

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

export const isCreatorIn = (guildId: string) => (channel: Channel | undefined) => !!channel && channel.guild_id === guildId && channel.name.includes("➕");

export function getCreators(guildId: string): Channel[] {
    const { VOCAL = [] } = GuildChannelStore.getChannels(guildId);
    return VOCAL.map(({ channel }) => channel).filter(isCreatorIn(guildId));
}

export function creatorLabel(creatorId: string) {
    const creator = ChannelStore.getChannel(creatorId);
    if (!creator) return "Unknown channel";
    const category = creator.parent_id ? ChannelStore.getChannel(creator.parent_id)?.name : null;
    return category ? `${category} › ${creator.name}` : creator.name;
}

export function createTempVoice(config: TempVoiceConfig) {
    const { guildId, botId } = config;
    const logger = new Logger(config.name);
    const isCreator = isCreatorIn(guildId);
    const menuId = `vc-tempvoice-${config.name.toLowerCase()}`;

    let pendingModal: { channelId: string; modalId: string; values: ModalValues; opened: boolean; } | null = null;
    let creating = false;
    let lastVoiceChannel: string | null = null;

    const getPresets = () => config.store().presets.map(withDefaults);
    const myVoiceChannel = () => SelectedChannelStore.getVoiceChannelId() ?? null;

    function isManagedChannel(id: string | null): id is string {
        const channel = id ? ChannelStore.getChannel(id) : undefined;
        return !!channel && channel.guild_id === guildId && !isCreator(channel) && channel.isGuildVoice();
    }

    function findBotMessage(channelId: string, match: (m: Message) => boolean) {
        let found: Message | null = null;
        MessageStore.getMessages(channelId).forEach(m => {
            if (m.author.id === botId && match(m)) found = m;
        });
        return found as Message | null;
    }

    const api: TempVoiceApi = {
        logger,
        pause: (min, max) => sleep((min + Math.random() * (max - min)) * config.store().actionDelay / 2000),
        fail: text => showToast({ text, variant: "critical" }),

        openChat(channelId) {
            if (config.store().openChat && SelectedChannelStore.getChannelId() !== channelId)
                ChannelRouter.transitionToChannel(channelId);
        },

        scrollToBottom: () => ComponentDispatch.dispatch("SCROLLTO_PRESENT"),

        waitFor(check, events, timeout) {
            return new Promise(resolve => {
                const first = check();
                if (first) return resolve(first);
                const done = (value: ReturnType<typeof check> | null) => {
                    clearTimeout(timer);
                    events.forEach(e => FluxDispatcher.unsubscribe(e, listener));
                    resolve(value ?? null);
                };
                const listener = () => {
                    const value = check();
                    if (value) done(value);
                };
                const timer = setTimeout(() => done(null), timeout);
                events.forEach(e => FluxDispatcher.subscribe(e, listener));
            });
        },

        waitForPanel(channelId) {
            const find = () => findBotMessage(channelId, config.isPanel);
            if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
            return api.waitFor(find, ["MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS"], 20_000);
        },

        // Clicks a panel button and resolves with the first bot reply to that click that the parser accepts.
        clickButton(panel, customId, parse) {
            const button = findComponent(panel.components, customId);
            const channel = ChannelStore.getChannel(panel.channel_id);
            if (!button || !channel) {
                logger.warn(`Button ${customId} not found`);
                return Promise.resolve(null);
            }

            const reply = new Promise<ReturnType<NonNullable<typeof parse>> | null>(resolve => {
                if (!parse) return resolve(null);
                const listener = ({ message }: { message: RawMessage; }) => {
                    if (message.author?.id !== botId || message.interaction_metadata?.interacted_message_id !== panel.id) return;
                    const parsed = parse(message.components);
                    if (parsed) done(parsed);
                };
                const done = (value: ReturnType<typeof parse> | null) => {
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
            }).catch(err => logger.error(`Clicking ${customId} failed`, err));
            return reply;
        },

        // Clicks a panel button that opens a bot form, fills it in the background and waits until applied() holds.
        async submitModal(panel, button, modalId, values, applied, what) {
            const pending = pendingModal = { channelId: panel.channel_id, modalId, values, opened: false };
            api.clickButton(panel, button, components => getText(components) || null)
                .then(reply => logger.info(`${what}: bot replied`, reply ?? "nothing"));
            const ok = await api.waitFor(() => applied() || null, ["CHANNEL_UPDATES"], 15_000);
            pendingModal = null;
            if (ok) return;
            api.fail(pending.opened ? `${what} didn't go through. The bot got the form but didn't apply it.` : `${what} didn't go through. The bot never opened its form.`);
            logger.warn(`${what} failed`, { opened: pending.opened, values });
        },

        async setStatus(channelId, status) {
            await RestAPI.put({ url: `/channels/${channelId}/voice-status`, body: { status } })
                .catch(err => {
                    api.fail("Setting the channel status didn't go through.");
                    logger.warn("Setting status failed", err);
                });
        }
    };

    async function runPreset(channelId: string, preset: Preset) {
        try {
            await config.applyPreset(api, channelId, preset);
        } finally {
            pendingModal = null;
        }
    }

    async function createChannel(preset: Preset) {
        if (creating) return api.fail("Already creating a channel.");
        if (!ChannelStore.getChannel(preset.creatorId)) return api.fail(`The create channel for ${preset.name || "this preset"} doesn't exist anymore.`);
        creating = true;
        try {
            ChannelActions.selectVoiceChannel(preset.creatorId);
            const channelId = await api.waitFor(() => {
                const id = myVoiceChannel();
                return isManagedChannel(id) ? id : null;
            }, ["VOICE_STATE_UPDATES", "VOICE_CHANNEL_SELECT"], 20_000);
            if (!channelId) return api.fail("The bot didn't move you to a new channel.");
            lastVoiceChannel = channelId;
            await runPreset(channelId, preset);
        } finally {
            creating = false;
        }
    }

    // You joined a create channel yourself and the bot moved you into a new one.
    async function onManualCreate(creatorId: string, channelId: string) {
        const preset = getPresets().find(p => p.creatorId === creatorId);
        if (!config.store().presetOnManualCreate || !preset) return;

        creating = true;
        try {
            const me = UserStore.getCurrentUser().id;
            const find = () => findBotMessage(channelId, m => config.isCreatedNotice(m, me));
            if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
            const notice = await api.waitFor(find, ["MESSAGE_CREATE", "LOAD_MESSAGES_SUCCESS"], 20_000);
            if (!notice || myVoiceChannel() !== channelId) return;
            await runPreset(channelId, preset);
        } finally {
            creating = false;
        }
    }

    async function onJoin(channelId: string) {
        if (!config.onJoinOthers) return;
        await api.pause(2000, 3000);
        const me = UserStore.getCurrentUser().id;
        const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId)).filter(id => id !== me);
        if (others.length && myVoiceChannel() === channelId) await config.onJoinOthers(api, channelId, others);
    }

    function CreateMenu(presets: Preset[], withCategory: boolean) {
        return (
            <Menu.MenuItem id={`${menuId}-create`} label="Create channel">
                {presets.length
                    ? presets.map(preset => (
                        <Menu.MenuItem
                            key={preset.id}
                            id={`${menuId}-create-${preset.id}`}
                            label={preset.name || creatorLabel(preset.creatorId)}
                            subtext={withCategory ? creatorLabel(preset.creatorId) : preset.status || undefined}
                            action={() => createChannel(preset)}
                        />
                    ))
                    : <Menu.MenuItem id={`${menuId}-none`} label="No presets here yet, add some in the plugin settings" disabled />}
            </Menu.MenuItem>
        );
    }

    const channelMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
        if (channel?.guild_id !== guildId) return;
        const presets = getPresets().filter(p => p.creatorId === channel.id || ChannelStore.getChannel(p.creatorId)?.parent_id === channel.id);
        if (isCreator(channel) || presets.length) children.push(<Menu.MenuSeparator />, CreateMenu(presets, false));
    };

    const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
        if (guild?.id === guildId) children.push(<Menu.MenuSeparator />, CreateMenu(getPresets(), true));
    };

    return {
        api,
        createChannel,

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
                if (creating || !isManagedChannel(current)) return;
                if (previous && isCreator(ChannelStore.getChannel(previous))) onManualCreate(previous, current);
                else onJoin(current);
            }
        },

        /** Call from a patch on Discord's INTERACTION_MODAL_CREATE handler; true means the form was handled here. */
        interceptModal(e: ModalCreate) {
            if (!pendingModal || e.channelId !== pendingModal.channelId || e.customId !== pendingModal.modalId) return false;
            pendingModal.opened = true;
            RestAPI.post({
                url: Constants.Endpoints.INTERACTIONS,
                body: {
                    type: 5,
                    application_id: e.application.id,
                    channel_id: e.channelId,
                    guild_id: guildId,
                    data: { id: e.id, custom_id: e.customId, components: fillModal(e.components, pendingModal.values) },
                    session_id: AuthenticationStore.getSessionId(),
                    nonce: SnowflakeUtils.fromTimestamp(Date.now())
                }
            }).catch(err => logger.error("Form submit failed", err));
            return true;
        }
    };
}
