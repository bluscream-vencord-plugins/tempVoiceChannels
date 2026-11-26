/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { PencilIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { pluralize, sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, FluxEvents, Guild, Message, User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Alerts, AuthenticationStore, ChannelActions, ChannelRouter, ChannelStore, ComponentDispatch, Constants, FluxDispatcher, GuildStore, IconUtils, Menu, MessageActions, MessageStore, moment, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UserStore, UserUtils, useState, VoiceStateStore } from "@webpack/common";

import { Component, findComponent } from "./components";
import { clearRememberedIds, loadRememberedIds, rememberedCount, rememberedIds } from "./idStore";
import { PATTERNS } from "./patterns";
import { creatorLabel, getCreators, isCreatorChannel, Preset, presetTitle, withDefaults } from "./presets";
import { cachedIds, forgetScanned, IdKind, PROFILE_SOURCE, scanProfiles } from "./profileScanner";

const logger = new Logger("TempVoiceChannels");

const executeComponent: (args: Record<string, unknown>) => Promise<void> = findByCodeLazy(...PATTERNS.webpack.executeComponent);

function ClearRememberedIds() {
    const [{ users, ids }, setCount] = useState(rememberedCount);
    const clear = () => Alerts.show({
        title: "Forget all remembered IDs?",
        body: `This removes ${pluralize(ids, "ID")} of ${pluralize(users, "person", "people")} from this computer. It can't be undone.`,
        confirmText: "Forget them",
        cancelText: "Cancel",
        onConfirm: () => clearRememberedIds()
            .then(() => setCount(rememberedCount()))
            .catch(err => {
                logger.error("Couldn't clear the remembered IDs", err);
                fail("Couldn't forget the remembered IDs. Check the console for details.");
            })
    });
    return (
        <Flex alignItems="center" gap="1em">
            <Paragraph>{pluralize(ids, "ID")} of {pluralize(users, "person", "people")} remembered.</Paragraph>
            <Button variant="dangerSecondary" size="small" disabled={!ids} onClick={clear}>Forget all</Button>
        </Flex>
    );
}

const settings = definePluginSettings({
    actionDelay: {
        type: OptionType.NUMBER,
        description: "Milliseconds to wait between actions, like clicking a bot button and setting the status. Every wait scales with this and varies a little so it feels natural.",
        default: 2000,
        min: 100,
        max: 10_000
    },
    channelCreateMenu: {
        type: OptionType.BOOLEAN,
        description: "Show \"Create channel\" when right-clicking a create channel or its category.",
        default: true
    },
    serverCreateMenu: {
        type: OptionType.BOOLEAN,
        description: "Show \"Create channel\" when right-clicking the server icon or name.",
        default: true
    },
    copyIdMenu: {
        type: OptionType.BOOLEAN,
        description: "Show \"Copy ID\" when right-clicking someone on a server with a temp voice plugin.",
        default: true
    },
    keepRejoinable: {
        type: OptionType.BOOLEAN,
        description: "When you leave a channel you created, first make sure you can get back in, e.g. by making it public and raising its user limit. Leave again while that runs to leave right away.",
        default: true
    },
    presetOnManualCreate: {
        type: OptionType.BOOLEAN,
        description: "When you create a channel yourself by joining a create channel, apply the first preset for that create channel once the bot has moved you.",
        default: true
    },
    scanProfiles: {
        type: OptionType.BOOLEAN,
        description: "When you join a channel with people, or someone joins yours, look for IDs like Activision IDs in their server and global profiles and show them in the channel chat, only visible to you.",
        default: true
    },
    rememberIds: {
        type: OptionType.BOOLEAN,
        description: "Remember every ID found for someone, from profiles or a server's bot, even after they remove it. Stored only on this computer, and used for the Copy ID menu. Turning this off stops remembering new IDs; use Forget all to remove the ones already stored.",
        default: true
    },
    clearRememberedIds: {
        type: OptionType.COMPONENT,
        component: ClearRememberedIds
    },
    openChat: {
        type: OptionType.BOOLEAN,
        description: "When a server plugin creates or joins a channel for you, open its chat so you can see what it clicked, what the bot replied and the IDs found in profiles.",
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
    /**
     * Kinds of IDs to look for in people's profiles when you join a channel with them or they join yours,
     * e.g. PATTERNS.idKinds.activision. Leave out to not scan profiles on this server.
     */
    profileIds?: IdKind[];
    /** IDs of a user that the server's bot already showed in this channel; the profile scan leaves them out. */
    knownIds?(channelId: string, userId: string): string[];
    /** IDs of a user the server plugin knows from elsewhere (e.g. its bot), for the "Copy ID" menu. */
    otherIds?(userId: string): { id: string; source: string; }[];
    /** Runs when you join a channel that isn't your own new one and that has other people in it. */
    onJoinOthers?(api: TempVoiceApi, channelId: string, others: string[]): Promise<void>;
    /** Whether the bot treats this user as the channel's owner, e.g. from a permission it gives owners. Covers transfers and channels from before a reload. */
    isOwner?(channel: Channel, userId: string): boolean;
    /**
     * Called right when you leave a channel you own. Return a flow that runs while you're still in it, so you can
     * rejoin later, or null when nothing needs doing (then the leave isn't held back at all).
     */
    prepareLeave?(channel: Channel): ((api: TempVoiceApi) => Promise<void>) | null;
}

/**
 * Helpers for one flow in one channel. Pauses and waits stop the flow quietly once you leave
 * that channel or the server plugin is turned off; single clicks and requests don't wait, so they don't check.
 */
export interface TempVoiceApi {
    /** The ranges are tuned for the default 2000 ms delay and scale with the setting. */
    pause(min: number, max: number): Promise<void>;
    fail(text: string): void;
    openChat(): void;
    scrollToBottom(): void;
    waitForPanel(): Promise<Message | null>;
    clickButton<T>(panel: Message, customId: string, parse?: (components: Component[] | undefined) => T | null): Promise<T | null>;
    /** Resolves true once the bot applied the form, false after telling you it didn't. */
    submitModal(panel: Message, button: string, modalId: string, values: ModalValues, applied: () => boolean, what: string): Promise<boolean>;
    setStatus(status: string): Promise<void>;
    /** Resolves true once check() holds after a channel update, false after ms. */
    waitUntil(check: () => boolean, ms: number): Promise<boolean>;
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

type SubmitResult = "sent" | "failed" | "unsupported" | "timeout";

interface PendingModal {
    channelId: string;
    modalId: string;
    values: ModalValues;
    resolve(result: SubmitResult): void;
}

interface CreateRequest {
    server: TempVoiceServer;
    preset: Preset;
    timer: ReturnType<typeof setTimeout> | undefined;
}

let pendingModal: PendingModal | null = null;
/** A channel you asked to create from a menu, until the bot moves you. */
let request: CreateRequest | null = null;
/** Your new channel while its preset is applied; joins there aren't treated as joining someone else. */
let settingUp: string | null = null;
let lastVoiceChannel: string | null = null;
/** Channels the bot said you created, this session. Only used for servers without isOwner. */
const ownChannels = new Set<string>();
const ownerLookups = new Set<string>();
/**
 * Profile scans per channel, run one after another. A join flow holds its channel's queue until the server's
 * own join actions are done, so people who join meanwhile are scanned after the bot showed its IDs.
 */
const scanQueue = new Map<string, Promise<void>>();

const myVoiceChannel = () => SelectedChannelStore.getVoiceChannelId() ?? null;
const fail = (text: string) => showToast({ text, variant: "critical" });

function openChat(channelId: string) {
    if (settings.store.openChat && SelectedChannelStore.getChannelId() !== channelId)
        ChannelRouter.transitionToChannel(channelId);
}

/** A voice channel in a category that has a create channel, on a registered server. */
function managedServer(id: string | null) {
    const channel = id ? ChannelStore.getChannel(id) : undefined;
    if (!channel?.isGuildVoice() || !channel.parent_id || isCreatorChannel(channel)) return null;
    const server = serverFor(channel.guild_id);
    if (!server || !getCreators(channel.guild_id).some(c => c.parent_id === channel.parent_id)) return null;
    return server;
}

function findBotMessage(server: TempVoiceServer, channelId: string, match: (m: Message) => boolean) {
    return MessageStore.getMessages(channelId)._array.findLast(m => m.author.id === server.botId() && match(m)) ?? null;
}

function fetchRecentMessages(channelId: string) {
    MessageActions.fetchMessages({ channelId, limit: PATTERNS.messageFetchLimit });
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

function makeApi(server: TempVoiceServer, channelId: string, alive: () => boolean): TempVoiceApi {
    const serverLogger = new Logger(server.name);

    const ensureAlive = () => {
        if (servers.get(server.name) !== server || myVoiceChannel() !== channelId || !alive()) throw new FlowCancelled();
    };
    const waitAlive = async <T,>(check: () => T | null | undefined, events: FluxEvents[], ms: number) => {
        const value = await waitFor(check, events, ms);
        ensureAlive();
        return value;
    };

    const api: TempVoiceApi = {
        fail,

        async pause(min, max) {
            await sleep((min + Math.random() * (max - min)) * settings.store.actionDelay / 2000);
            ensureAlive();
        },

        openChat: () => openChat(channelId),

        scrollToBottom() {
            if (SelectedChannelStore.getChannelId() === channelId) ComponentDispatch.dispatch(PATTERNS.events.scrollToPresent);
        },

        waitForPanel() {
            const find = () => findBotMessage(server, channelId, server.isPanel);
            if (!find()) fetchRecentMessages(channelId);
            return waitAlive(find, PATTERNS.events.panelChanged, 20_000);
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
                    FluxDispatcher.unsubscribe(PATTERNS.events.messageCreate, listener);
                    resolve(value);
                };
                const timer = setTimeout(() => done(null), parse ? 15_000 : 0);
                if (parse) FluxDispatcher.subscribe(PATTERNS.events.messageCreate, listener);

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
            const found = findComponent(panel.components, button);
            if (!found || found.disabled) {
                fail(`${what} isn't available, the bot's panel has no usable button for it.`);
                return false;
            }

            let timer: ReturnType<typeof setTimeout> | undefined;
            let resolveSubmit: (result: SubmitResult) => void = () => { };
            const submitted = new Promise<SubmitResult>(resolve => {
                resolveSubmit = resolve;
                timer = setTimeout(() => resolve("timeout"), 15_000);
            });
            const mine: PendingModal = { channelId, modalId, values, resolve: resolveSubmit };
            pendingModal = mine;
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
                clearTimeout(timer);
                if (pendingModal === mine) pendingModal = null;
            }

            if (await waitAlive(() => applied() || null, PATTERNS.events.channelUpdated, 15_000)) return true;
            fail(`${what} didn't go through. The bot got the form but didn't apply it.`);
            serverLogger.warn(`${what} failed`, values);
            return false;
        },

        async waitUntil(check, ms) {
            return !!await waitAlive(() => check() || null, PATTERNS.events.channelUpdated, ms);
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
async function runFlow(server: TempVoiceServer, channelId: string, flow: (api: TempVoiceApi) => Promise<void>, alive = () => true) {
    try {
        await flow(makeApi(server, channelId, alive));
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

    request = { server, preset, timer: undefined };
    armRequestTimer();
    ChannelActions.selectVoiceChannel(preset.creatorId);
}

function armRequestTimer() {
    if (!request) return;
    clearTimeout(request.timer);
    const timer = setTimeout(() => {
        if (request?.timer !== timer) return;
        request = null;
        fail("The bot didn't move you to a new channel.");
    }, PATTERNS.createTimeoutMs);
    request.timer = timer;
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
        if (!find()) fetchRecentMessages(channelId);
        const notice = await waitFor(find, PATTERNS.events.messageArrived, 20_000);
        if (myVoiceChannel() !== channelId) return;
        if (notice) {
            ownChannels.add(channelId);
            if (preset) await server.applyPreset(api, channelId, preset);
            return;
        }
        if (requested) fail("This isn't the channel the bot made for you, so the preset wasn't applied.");
        await joinFlow(server, api, channelId, false);
    }).finally(() => {
        if (settingUp === channelId) settingUp = null;
    });
}

interface VoiceChannelSelect {
    [key: string]: unknown;
    type: FluxEvents;
    channelId?: string | null;
}

/** A leave held back while your channel is made rejoinable. Leaving again meanwhile cancels it. */
interface Hold {
    channelId: string;
    action: VoiceChannelSelect;
    cancelled: boolean;
}

let hold: Hold | null = null;
/** Leave actions that were held back and are now let through. */
const released = new WeakSet<VoiceChannelSelect>();

function releaseHold(held: Hold) {
    if (hold !== held) return;
    hold = null;
    if (held.cancelled || myVoiceChannel() !== held.channelId) return;
    released.add(held.action);
    FluxDispatcher.dispatch(held.action);
    // The hold may have eaten into the wait for the bot to move you into a channel you asked to create.
    if (request) armRequestTimer();
}

function holdLeave(action: VoiceChannelSelect) {
    if (action.type !== PATTERNS.voiceChannelSelect || !settings.store.keepRejoinable || released.has(action)) return false;
    const current = myVoiceChannel();
    if (!current || action.channelId === current) return false;
    if (hold) {
        if (hold.channelId === current) hold.cancelled = true;
        return false;
    }
    if (settingUp === current) return false;
    const server = managedServer(current);
    const channel = ChannelStore.getChannel(current);
    if (!server?.prepareLeave || !channel) return false;
    const me = UserStore.getCurrentUser().id;
    if (!(server.isOwner ? server.isOwner(channel, me) : ownChannels.has(current))) return false;
    const prepare = server.prepareLeave(channel);
    if (!prepare) return false;

    const held: Hold = { channelId: current, action, cancelled: false };
    hold = held;
    showToast({ text: "Making sure you can get back into your channel before you leave. Leave again to skip this." });
    Promise.race([
        runFlow(server, current, prepare, () => !held.cancelled).then(() => false),
        sleep(PATTERNS.leaveTimeoutMs).then(() => true)
    ]).then(timedOut => {
        if (timedOut && !held.cancelled) fail("Getting your channel ready took too long, so you left without it.");
    }).finally(() => releaseHold(held));
    return true;
}

/** Holds back leaving your own channel until its server plugin made sure you can rejoin, then leaves as asked. */
function interceptLeave(action: VoiceChannelSelect) {
    // A throw here would block every voice channel change, so let the leave through instead.
    try {
        return holdLeave(action);
    } catch (err) {
        logger.error("Checking a voice channel leave failed", err);
        return false;
    }
}

async function joinFlow(server: TempVoiceServer, api: TempVoiceApi, channelId: string, wait: boolean) {
    if (!server.onJoinOthers && !server.profileIds?.length) return;
    if (wait) await api.pause(2000, 3000);
    const me = UserStore.getCurrentUser().id;
    const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId)).filter(id => id !== me);
    if (!others.length) return;

    // The server's own join actions go first, so the profile scan can leave out IDs its bot already showed.
    // Holding the queue makes people who join meanwhile wait for that too.
    let release = () => { };
    queueScan(channelId, () => new Promise<void>(resolve => { release = resolve; }));
    try {
        if (server.onJoinOthers) await server.onJoinOthers(api, channelId, others);
    } finally {
        release();
        scanFor(server, channelId, others, true);
    }
}

function queueScan(channelId: string, task: () => Promise<void>) {
    const next = (scanQueue.get(channelId) ?? Promise.resolve()).then(task).catch(err => logger.error("Scanning profiles failed", err));
    scanQueue.set(channelId, next);
}

/** `fromJoin`: you just joined, so opening the chat to show what was found is expected. */
function scanFor(server: TempVoiceServer, channelId: string, userIds: string[], fromJoin: boolean) {
    const kinds = server.profileIds;
    if (!settings.store.scanProfiles || !kinds?.length) return;
    queueScan(channelId, () => scanProfiles(channelId, server.guildId(), userIds, kinds, {
        isActive: () => myVoiceChannel() === channelId && servers.get(server.name) === server,
        knownIds: userId => server.knownIds?.(channelId, userId) ?? [],
        // The IDs are posted in the channel's chat, so after your own join open it, or you'd never see them.
        onFound: fromJoin ? () => openChat(channelId) : undefined
    }));
}

interface VoiceStateChange {
    userId: string;
    channelId?: string | null;
    oldChannelId?: string | null;
}

// Someone else joined the channel you're in.
function onOthersJoined(voiceStates: VoiceStateChange[]) {
    const mine = myVoiceChannel();
    if (!mine) return;
    const me = UserStore.getCurrentUser().id;
    const joined = voiceStates.filter(s => s.userId !== me && s.channelId === mine && s.oldChannelId !== mine).map(s => s.userId);
    if (!joined.length) return;
    const server = managedServer(mine);
    if (server) scanFor(server, mine, joined, false);
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
    if (!channel || !server || !settings.store.channelCreateMenu) return;
    const presets = presetsOf(server).filter(p => p.creatorId === channel.id || ChannelStore.getChannel(p.creatorId)?.parent_id === channel.id);
    if (isCreatorChannel(channel) || presets.length) children.push(<Menu.MenuSeparator />, createMenu(server, presets, false));
};

/**
 * Right-clicking someone: copy any ID known for them. The server is the one they're in voice on, or the one the
 * menu was opened in; remembered IDs show anywhere. Reads caches only, so opening the menu stores nothing.
 */
const userMenu: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user || user.bot || user.id === UserStore.getCurrentUser().id || !settings.store.copyIdMenu) return;
    const voiceChannel = VoiceStateStore.getVoiceStateForUser(user.id)?.channelId;
    const server = serverFor(voiceChannel ? ChannelStore.getChannel(voiceChannel)?.guild_id : undefined) ?? serverFor(guildId);

    const found = new Map<string, { id: string; source: string; lastSeen?: number; }>();
    const add = (id: string, source: string, lastSeen?: number) => {
        if (!found.has(id.toLowerCase())) found.set(id.toLowerCase(), { id, source, lastSeen });
    };
    // What can be seen right now comes first, then remembered IDs that are gone from everywhere.
    server?.otherIds?.(user.id).forEach(({ id, source }) => add(id, source));
    let loading = false;
    if (server) for (const kind of server.profileIds ?? []) {
        const ids = cachedIds(user.id, server.guildId(), kind);
        if (ids) ids.forEach(id => add(id, PROFILE_SOURCE));
        else loading = true;
    }
    for (const { id, source, lastSeen } of rememberedIds(user.id)) add(id, source, lastSeen);
    if (!found.size && !loading) return;

    const idPrefix = `vc-tempvoice-copy-id-${user.id}`;
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id={idPrefix} label="Copy ID">
            {[...found.values()].map(({ id, source, lastSeen }) => (
                <Menu.MenuItem
                    key={id}
                    id={`${idPrefix}-${id}`}
                    label={id}
                    // "profile, 3 days ago": only IDs that aren't visible right now carry a time.
                    subtext={lastSeen ? `${source}, ${moment(lastSeen).fromNow()}` : source}
                    action={() => copyWithToast(id, `Copied ${id}`)}
                />
            ))}
            {loading && <Menu.MenuItem id={`${idPrefix}-loading`} label="Loading profile, open the menu again in a moment" disabled />}
        </Menu.MenuItem>
    );
};

const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    const server = serverFor(guild?.id);
    if (server && settings.store.serverCreateMenu) children.push(<Menu.MenuSeparator />, createMenu(server, presetsOf(server), true));
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
    authors: [
        { name: "Bluscream", id: 467777925790564352n },
        { name: "Claude Opus 5.5", id: 0n },
        { name: "Claude Fable 5.2", id: 0n }
    ],
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
        loadRememberedIds(() => settings.store.rememberIds);
        FluxDispatcher.addInterceptor(interceptLeave);
    },

    stop() {
        const index = FluxDispatcher._interceptors.indexOf(interceptLeave);
        if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
        if (hold) {
            const held = hold;
            releaseHold(held);
            held.cancelled = true;
        }
        ownChannels.clear();
        clearRequest();
        pendingModal?.resolve("timeout");
        pendingModal = null;
        settingUp = null;
        scanQueue.clear();
        forgetScanned();
    },

    // Fills a bot form the plugin asked for in the background instead of showing it.
    interceptModal(e: ModalCreate) {
        const pending = pendingModal;
        if (!pending || e.channelId !== pending.channelId || e.customId !== pending.modalId) return false;
        if (!canFill(e.components)) {
            pending.resolve("unsupported");
            return false;
        }
        const submit = (retried: boolean) => RestAPI.post({
            url: Constants.Endpoints.INTERACTIONS,
            body: {
                type: PATTERNS.modalSubmitInteraction,
                application_id: e.application.id,
                channel_id: e.channelId,
                guild_id: ChannelStore.getChannel(e.channelId)?.guild_id,
                data: { id: e.id, custom_id: e.customId, components: fillModal(e.components, pending.values) },
                session_id: AuthenticationStore.getSessionId(),
                nonce: SnowflakeUtils.fromTimestamp(Date.now())
            }
        }).then(
            () => pending.resolve("sent"),
            (err: { status?: number; body?: { retry_after?: number; }; }) => {
                const retryAfter = err?.status === PATTERNS.rateLimitedStatus ? err.body?.retry_after : undefined;
                if (!retried && retryAfter !== undefined && retryAfter * 1000 <= PATTERNS.maxRateLimitWaitMs) {
                    logger.info(`Form submit rate limited, retrying in ${retryAfter}s`);
                    setTimeout(() => submit(true), retryAfter * 1000 + PATTERNS.rateLimitPaddingMs);
                    return;
                }
                logger.error("Form submit failed", err);
                pending.resolve("failed");
            }
        );
        submit(false);
        return true;
    },

    contextMenus: {
        [PATTERNS.contextMenus.channel]: channelMenu,
        [PATTERNS.contextMenus.guild]: guildMenu,
        [PATTERNS.contextMenus.guildHeader]: guildMenu,
        [PATTERNS.contextMenus.user]: userMenu
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChange[]; }) {
            const current = myVoiceChannel();
            const previous = lastVoiceChannel;
            if (current === previous) return onOthersJoined(voiceStates);
            lastVoiceChannel = current;
            if (previous) {
                forgetScanned(previous);
                scanQueue.delete(previous);
            }
            const server = managedServer(current);
            if (!server || !current || current === settingUp) return;
            const previousChannel = previous ? ChannelStore.getChannel(previous) : undefined;
            if (previous && previousChannel?.guild_id === server.guildId() && isCreatorChannel(previousChannel))
                return onCreated(server, previous, current);
            return runFlow(server, current, api => joinFlow(server, api, current, true));
        }
    }
});
