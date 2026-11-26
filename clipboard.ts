/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { PluginNative } from "@utils/types";

const Native = IS_WEB ? undefined : VencordNative.pluginHelpers.TempVoiceChannels as PluginNative<typeof import("./native")> | undefined;

/** Copies through the main process when possible, which works while Discord isn't focused (e.g. in game). */
export async function copyText(text: string) {
    if (Native && await Native.copyText(text)) return;
    await copyToClipboard(text);
}
