/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { PencilIcon } from "@components/Icons";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, FluxEvents, Guild, Message } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { AuthenticationStore, ChannelActions, ChannelRouter, ChannelStore, ComponentDispatch, Constants, FluxDispatcher, GuildStore, IconUtils, Menu, MessageActions, MessageStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UserStore, UserUtils, VoiceStateStore } from "@webpack/common";

import { Component, findComponent, getText } from "./components";
import { PATTERNS } from "./patterns";
import { creatorLabel, getCreators, isCreatorChannel, Preset, presetTitle, withDefaults } from "./presets";

const logger = new Logger("TempVoiceChannels");

const executeComponent: (args: Record<string, unknown>) => Promise<void> = findByCodeLazy(...PATTERNS.webpack.executeComponent);

const settings = definePluginSettings({
    actionDelay: {
        type: OptionType.NUMBER,
        description: "Milliseconds to wait between actions, like clicking a bot button and setting the status. Every wait scales with this and varies a little so it feels natural.",
        default: 2000,
        min: 100,
        max: 10_000
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
    /** Must equal the server plugin's name, so its settings can be opened. */
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
    /** Runs when you join a channel that isn't your own new one and that has other people in it. */
    onJoinOthers?(api: TempVoiceApi, channelId: string, others: string[]): Promise<void>;
}

/**
 * Helpers for one flow in one channel. Every wait stops the flow quietly once you leave
 * that channel or the server plugin is turned off.
 */
export interface TempVoiceApi {
    logger: Logger;
    /** The ranges are tuned for the default 2000 ms delay and scale with the setting. */
    pause(min: number, max: number): Promise<void>;
    fail(text: string): void;
    openChat(): void;
    scrollToBottom(): void;
    waitFor<T>(check: () => T | null | undefined, events: FluxEvents[], timeout: number): Promise<T | null>;
    waitForPanel(): Promise<Message | null>;
    clickButton<T>(panel: Message, customId: string, parse?: (components: Component[] | undefined) => T | null): Promise<T | null>;
    /** Resolves true once the bot applied the form, false after telling you it didn't. */
    submitModal(panel: Message, button: string, modalId: string, values: ModalValues, applied: () => boolean, what: string): Promise<boolean>;
    setStatus(status: string): Promise<void>;
}

const servers = new Map<string, TempVoiceServer>();

export function registerServer(server: TempVoiceServer) {
    servers.set(server.name, server);
}

export function unregisterServer(name: string) {
    servers.delete(name);
}

const serverFor = (guildId: string | undefined) => [...servers.values()].find(s => s.guildId() === guildId);
const presetsOf = (server: TempVoiceServer) => server.presets().map(withDefaults);
const openSettings = (server: TempVoiceServer) => openPluginModal(plugins[server.name]);

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

const { actionRow, textInput, textDisplay, label } = PATTERNS.componentTypes;

// Text fields, their wrappers and plain text. Anything else (selects, uploads) we can't fill.
const FILLABLE_TYPES = new Set([actionRow, textInput, textDisplay, label]);

function canFill(list: Component[]): boolean {
    return list.every(c => FILLABLE_TYPES.has(c.type) && canFill(c.components ?? []) && (!c.component || canFill([c.component])));
}

// Fills text fields by their custom id and keeps the bot's prefilled value for any field not given.
function fillModal(list: Component[], values: ModalValues): unknown[] {
    return list.map(c => {
        if (c.type === actionRow) return { type: actionRow, components: fillModal(c.components ?? [], values) };
        if (c.type === label && c.component) return { type: label, component: fillModal([c.component], values)[0] };
        const customId = c.customId ?? c.custom_id ?? "";
        if (c.type === textInput) return { type: textInput, custom_id: customId, value: values[customId] ?? c.value ?? "" };
        return { type: c.type };
    });
}

type SubmitResult = "sent" | "failed" | "unsupported";

interface PendingModal {
    channelId: string;
    modalId: string;
    values: ModalValues;
    resolve(result: SubmitResult): void;
}

interface CreateRequest {
    server: TempVoiceServer;
    preset: Preset;
    timer: ReturnType<typeof setTimeout>;
}

let pendingModal: PendingModal | null = null;
/** A channel you asked to create from a menu, until the bot moves you. */
let request: CreateRequest | null = null;
/** Your new channel while its preset is applied; joins there aren't treated as joining someone else. */
let settingUp: string | null = null;
let lastVoiceChannel: string | null = null;
const ownerLookups = new Set<string>();

const myVoiceChannel = () => SelectedChannelStore.getVoiceChannelId() ?? null;
const fail = (text: string) => showToast({ text, variant: "critical" });

/** A voice channel in a category that has a create channel, on a registered server. */
function managedServer(id: string | null) {
    const channel = id ? ChannelStore.getChannel(id) : undefined;
    if (!channel?.isGuildVoice() || isCreatorChannel(channel)) return null;
    const server = serverFor(channel.guild_id);
    if (!server || !getCreators(channel.guild_id).some(c => c.parent_id === channel.parent_id)) return null;
    return server;
}

function findBotMessage(server: TempVoiceServer, channelId: string, match: (m: Message) => boolean) {
    return MessageStore.getMessages(channelId)._array.findLast(m => m.author.id === server.botId() && match(m)) ?? null;
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

/** Thrown inside a flow to stop it quietly. */
class FlowCancelled extends Error { }

function makeApi(server: TempVoiceServer, channelId: string): TempVoiceApi {
    const serverLogger = new Logger(server.name);

    const ensureAlive = () => {
        if (servers.get(server.name) !== server || myVoiceChannel() !== channelId) throw new FlowCancelled();
    };

    const api: TempVoiceApi = {
        logger: serverLogger,
        fail,

        async pause(min, max) {
            await sleep((min + Math.random() * (max - min)) * settings.store.actionDelay / 2000);
            ensureAlive();
        },

        openChat() {
            if (settings.store.openChat && SelectedChannelStore.getChannelId() !== channelId)
                ChannelRouter.transitionToChannel(channelId);
        },

        scrollToBottom() {
            if (SelectedChannelStore.getChannelId() === channelId) ComponentDispatch.dispatch("SCROLLTO_PRESENT");
        },

        async waitFor(check, events, ms) {
            const value = await waitFor(check, events, ms);
            ensureAlive();
            return value;
        },

        waitForPanel() {
            const find = () => findBotMessage(server, channelId, server.isPanel);
            if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
            return api.waitFor(find, ["MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS"], 20_000);
        },

        // Clicks a panel button and resolves with the first bot reply to that click that the parser accepts.
        clickButton<T>(panel: Message, customId: string, parse?: (components: Component[] | undefined) => T | null) {
            const button = findComponent(panel.components, customId);
            const channel = ChannelStore.getChannel(panel.channel_id);
            if (!button || button.disabled || !channel) {
                serverLogger.warn(`Button ${customId} not found or disabled`);
                return Promise.resolve(null);
            }

            return new Promise<T | null>(resolve => {
                const listener = ({ message }: { message: RawMessage; }) => {
                    if (!parse || message.author?.id !== server.botId() || message.interaction_metadata?.interacted_message_id !== panel.id) return;
                    const parsed = parse(message.components);
                    if (parsed) done(parsed);
                };
                const done = (value: T | null) => {
                    clearTimeout(timer);
                    FluxDispatcher.unsubscribe("MESSAGE_CREATE", listener);
                    resolve(value);
                };
                const timer = setTimeout(() => done(null), parse ? 15_000 : 0);
                if (parse) FluxDispatcher.subscribe("MESSAGE_CREATE", listener);

                executeComponent({
                    componentType: button.type,
                    messageId: panel.id,
                    messageFlags: panel.flags,
                    customId,
                    componentId: button.id,
                    applicationId: panel.applicationId ?? panel.author.id,
                    channelId: channel.id,
                    guildId: channel.guild_id
                }).catch(err => {
                    serverLogger.error(`Clicking ${customId} failed`, err);
                    done(null);
                });
            });
        },

        // Clicks a panel button that opens a bot form, fills it in the background, then waits until applied() holds.
        async submitModal(panel, button, modalId, values, applied, what) {
            if (!findComponent(panel.components, button)) {
                fail(`${what} isn't available, the bot's panel has no button for it.`);
                return false;
            }

            let mine: PendingModal | null = null;
            const submitted = new Promise<SubmitResult | "timeout">(resolve => {
                mine = pendingModal = { channelId, modalId, values, resolve };
                setTimeout(() => resolve("timeout"), 15_000);
            });
            try {
                api.clickButton(panel, button);
                const result = await submitted;
                ensureAlive();
                if (result !== "sent") {
                    fail({
                        timeout: `${what} didn't go through. The bot never opened its form.`,
                        failed: `${what} didn't go through. Sending the form to the bot failed.`,
                        unsupported: `${what} needs a choice this plugin can't fill in, so the bot's form is shown instead.`
                    }[result]);
                    return false;
                }
            } finally {
                if (pendingModal === mine) pendingModal = null;
            }

            if (await api.waitFor(() => applied() || null, ["CHANNEL_UPDATES"], 15_000)) return true;
            fail(`${what} didn't go through. The bot got the form but didn't apply it.`);
            serverLogger.warn(`${what} failed`, values);
            return false;
        },

        async setStatus(status) {
            await RestAPI.put({ url: Constants.Endpoints.UPDATE_VOICE_CHANNEL_STATUS(channelId), body: { status } })
                .catch(err => {
                    fail("Setting the channel status didn't go through.");
                    serverLogger.warn("Setting status failed", err);
                });
        }
    };
    return api;
}

/** Runs one flow, stopping quietly when it was cancelled and reporting anything else that went wrong. */
async function runFlow(server: TempVoiceServer, channelId: string, flow: (api: TempVoiceApi) => Promise<void>) {
    try {
        await flow(makeApi(server, channelId));
    } catch (err) {
        if (err instanceof FlowCancelled) return;
        logger.error(`${server.name} failed`, err);
        fail("Something went wrong while handling the voice channel. Check the console for details.");
    }
}

/** Joins the preset's create channel. The rest happens once the bot has moved you, in onCreated. */
function createChannel(server: TempVoiceServer, preset: Preset) {
    if (request) return fail("Already creating a channel.");
    if (!ChannelStore.getChannel(preset.creatorId)) return fail(`The create channel for ${presetTitle(preset)} doesn't exist anymore.`);
    if (myVoiceChannel() === preset.creatorId) return fail("You're already in that create channel. Leave it and try again.");

    const timer = setTimeout(() => {
        if (request?.timer !== timer) return;
        request = null;
        fail("The bot didn't move you to a new channel.");
    }, 20_000);
    request = { server, preset, timer };
    ChannelActions.selectVoiceChannel(preset.creatorId);
}

function clearRequest() {
    if (request) clearTimeout(request.timer);
    request = null;
}

// You went from a create channel straight into a new channel: either your own new one, or you moved on yourself.
function onCreated(server: TempVoiceServer, creatorId: string, channelId: string) {
    const requested = request?.server === server && request.preset.creatorId === creatorId ? request.preset : null;
    if (requested) clearRequest();
    const preset = requested ?? (settings.store.presetOnManualCreate ? presetsOf(server).find(p => p.creatorId === creatorId) : undefined);

    settingUp = channelId;
    return runFlow(server, channelId, async api => {
        // Only the bot's "you created this channel" message proves it's yours and not one you clicked into.
        const me = UserStore.getCurrentUser().id;
        const find = () => findBotMessage(server, channelId, m => server.isCreatedNotice(m, me));
        if (!find()) MessageActions.fetchMessages({ channelId, limit: 50 });
        if (await api.waitFor(find, ["MESSAGE_CREATE", "LOAD_MESSAGES_SUCCESS"], 20_000)) {
            if (preset) await server.applyPreset(api, channelId, preset);
            return;
        }
        if (requested) fail("This isn't the channel the bot made for you, so the preset wasn't applied.");
        await joinFlow(server, api, channelId, false);
    }).finally(() => {
        if (settingUp === channelId) settingUp = null;
    });
}

async function joinFlow(server: TempVoiceServer, api: TempVoiceApi, channelId: string, wait: boolean) {
    if (!server.onJoinOthers) return;
    if (wait) await api.pause(2000, 3000);
    const me = UserStore.getCurrentUser().id;
    const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId)).filter(id => id !== me);
    if (others.length) await server.onJoinOthers(api, channelId, others);
}

// Status and create channel on their own lines. The create channel is left out when it's already the title or the menu belongs to it.
function presetSubtext(preset: Preset, withCreator: boolean) {
    const creator = withCreator && preset.name;
    if (!preset.status && !creator) return undefined;
    return <>
        {preset.status && <div>{preset.status}</div>}
        {creator && <div>{creatorLabel(preset.creatorId)}</div>}
    </>;
}

/** The menu rows for a server's presets, shared by the right-click menus and the toolbox. */
function presetItems(server: TempVoiceServer, presets: Preset[], idPrefix: string, withCreator: boolean) {
    if (!presets.length)
        return [<Menu.MenuItem key="none" id={`${idPrefix}-none`} label="No presets yet, click to add some" action={() => openSettings(server)} />];
    return presets.map(preset => (
        <Menu.MenuItem
            key={preset.id}
            id={`${idPrefix}-${preset.id}`}
            label={presetTitle(preset)}
            subtext={presetSubtext(preset, withCreator)}
            action={() => createChannel(server, preset)}
        />
    ));
}

function createMenu(server: TempVoiceServer, presets: Preset[], withCreator: boolean) {
    const idPrefix = `vc-tempvoice-${server.name}-create`;
    return (
        <Menu.MenuItem id={idPrefix} label="Create channel">
            {presetItems(server, presets, idPrefix, withCreator)}
        </Menu.MenuItem>
    );
}

const channelMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    const server = serverFor(channel?.guild_id);
    if (!channel || !server) return;
    const presets = presetsOf(server).filter(p => p.creatorId === channel.id || ChannelStore.getChannel(p.creatorId)?.parent_id === channel.id);
    if (isCreatorChannel(channel) || presets.length) children.push(<Menu.MenuSeparator />, createMenu(server, presets, false));
};

const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    const server = serverFor(guild?.id);
    if (server) children.push(<Menu.MenuSeparator />, createMenu(server, presetsOf(server), true));
};

function serverHeading(server: TempVoiceServer) {
    const guild = GuildStore.getGuild(server.guildId());
    const owner = guild ? UserStore.getUser(guild.ownerId) : undefined;
    // Not cached yet: look it up once so the owner shows from the next time the menu opens.
    if (guild && !owner && !ownerLookups.has(guild.ownerId)) {
        ownerLookups.add(guild.ownerId);
        UserUtils.getUser(guild.ownerId).catch(() => logger.debug(`Owner of ${guild.name} not found`));
    }
    const iconUrl = guild?.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 32 }) : undefined;

    return (
        <Menu.MenuItem
            key={`${server.name}-heading`}
            id={`vc-tempvoice-toolbox-${server.name}`}
            label={<>
                <b>{guild?.name ?? server.name}</b>
                {owner && ` by @${owner.username}`}
            </>}
            leadingAccessory={iconUrl ? { type: "image", src: iconUrl } : undefined}
            icon={PencilIcon}
            action={() => openSettings(server)}
        />
    );
}

export default definePlugin({
    name: "TempVoiceChannels",
    description: "Shared core for temp voice channel bot plugins: channel presets, joining create channels and handling bot panels. Enabled automatically by the server plugins that need it.",
    authors: [{ name: "Bluscream", id: 467777925790564352n }],
    settings,

    patches: [
        {
            find: PATTERNS.webpack.modalManagerFind,
            replacement: {
                match: PATTERNS.webpack.modalCreateHandler,
                replace: "$&if($self.interceptModal($1))return;"
            }
        }
    ],

    // One section per server: its icon and name as a heading that opens its settings, then its presets to create a channel from anywhere.
    toolboxActions() {
        return [...servers.values()].flatMap((server, index) => [
            ...index > 0 ? [<Menu.MenuSeparator key={`${server.name}-separator`} />] : [],
            serverHeading(server),
            ...presetItems(server, presetsOf(server), `vc-tempvoice-toolbox-${server.name}`, true)
        ]);
    },

    start() {
        // Without this, being in voice when the plugin starts would look like a fresh join.
        lastVoiceChannel = myVoiceChannel();
    },

    stop() {
        clearRequest();
    },

    // Fills a bot form the plugin asked for in the background instead of showing it.
    interceptModal(e: ModalCreate) {
        const pending = pendingModal;
        if (!pending || e.channelId !== pending.channelId || e.customId !== pending.modalId) return false;
        if (!canFill(e.components)) {
            pending.resolve("unsupported");
            return false;
        }
        RestAPI.post({
            url: Constants.Endpoints.INTERACTIONS,
            body: {
                type: 5,
                application_id: e.application.id,
                channel_id: e.channelId,
                guild_id: ChannelStore.getChannel(e.channelId)?.guild_id,
                data: { id: e.id, custom_id: e.customId, components: fillModal(e.components, pending.values) },
                session_id: AuthenticationStore.getSessionId(),
                nonce: SnowflakeUtils.fromTimestamp(Date.now())
            }
        }).then(
            () => pending.resolve("sent"),
            err => {
                logger.error("Form submit failed", err);
                pending.resolve("failed");
            }
        );
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
            if (!server || !current || current === settingUp) return;
            const previousChannel = previous ? ChannelStore.getChannel(previous) : undefined;
            if (previous && previousChannel?.guild_id === server.guildId() && isCreatorChannel(previousChannel))
                return onCreated(server, previous, current);
            return runFlow(server, current, api => joinFlow(server, api, current, true));
        }
    }
});
