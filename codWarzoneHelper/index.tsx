/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import definePlugin from "@utils/types";
import { ChannelStore, showToast } from "@webpack/common";

import { registerServer, TempVoiceServer, unregisterServer } from "../tempVoiceChannels";
import { isPanel, parseActivision, parseLogs } from "./parsers";
import { settings } from "./settings";

const server: TempVoiceServer = {
    name: "CodWarzoneHelper",
    guildId: () => settings.store.guildId,
    botId: () => settings.store.botId,
    presets: () => settings.store.presets,
    isPanel: m => isPanel(m.components),
    // "🎮 Kanal erstellt von: @owner"
    isCreatedNotice: (m, userId) => m.content.includes("Kanal erstellt von") && new RegExp(`<@!?${userId}>`).test(m.content),

    async applyPreset(api, channelId, preset) {
        await api.pause(1500, 2500);
        api.openChat();
        const panel = await api.waitForPanel();
        if (!panel) return api.fail("Voice panel not found.");

        // The bot's rename form also sets the channel status. With only a status, the name stays as it is,
        // so the check passes as soon as the form was sent.
        if (preset.name || preset.status) {
            const name = (preset.name || ChannelStore.getChannel(channelId)?.name || "").trim();
            await api.pause(1500, 2500);
            const renamed = await api.submitModal(panel, "rename_button", "rename_modal", { channel_name: name, channel_status: preset.status },
                () => ChannelStore.getChannel(channelId)?.name.trim() === name, "Rename");
            if (!renamed) return;
        }

        if (preset.limit) {
            const { limit } = preset;
            await api.pause(1500, 2500);
            const limited = await api.submitModal(panel, "limit_button", "limit_modal", { channel_limit: String(limit) },
                () => ChannelStore.getChannel(channelId)?.userLimit === limit, "Setting the user limit");
            if (!limited) return;
        }

        if (preset.privacy !== "unchanged") {
            await api.pause(1500, 2500);
            await api.clickButton(panel, preset.privacy === "private" ? "private_button" : "public_button");
        }

        if (settings.store.clickPanelOnCreate) {
            await api.pause(2000, 3000);
            await api.clickButton(panel, "logs_button", parseLogs);
            await api.pause(2500, 3500);
            await api.clickButton(panel, "activision_button", parseActivision);
            await api.pause(800, 1200);
            api.scrollToBottom();
        }
    },

    async onJoinOthers(api, _channelId, others) {
        if (!settings.store.copyActivisionOnJoin) return;
        const panel = await api.waitForPanel();
        if (!panel) return;
        api.openChat();
        await api.pause(1500, 2500);
        const entries = await api.clickButton(panel, "activision_button", parseActivision);
        await api.pause(800, 1200);
        api.scrollToBottom();
        if (!entries) return api.fail("The bot didn't send any Activision IDs.");

        const found = entries.filter(e => others.includes(e.userId));
        if (!found.length) return showToast({ text: "Nobody else here has linked an Activision ID." });

        await copyToClipboard(found[0].activisionId);
        const rest = found.slice(1).map(e => e.activisionId);
        showToast({
            text: `Copied ${found[0].activisionId}${rest.length ? `. Also here: ${rest.join(", ")}` : ""}`,
            variant: "success",
            duration: rest.length ? 8000 : 4000
        });
    }
};

export default definePlugin({
    name: "CodWarzoneHelper",
    description: "Creates preset voice channels on the German Warzone & MW4 server and handles the V3NOM voice panel for you.",
    authors: [{ name: "Bluscream", id: 467777925790564352n }],
    dependencies: ["TempVoiceChannels"],
    settings,

    start() {
        registerServer(server);
    },

    stop() {
        unregisterServer(server.name);
    }
});
