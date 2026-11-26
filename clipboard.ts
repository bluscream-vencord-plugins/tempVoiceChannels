/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { copyToClipboard } from "@utils/clipboard";

import { PATTERNS } from "./patterns";

/** Uses the optional NativeUtils plugin when it's there, which copies while Discord isn't focused (e.g. in game). */
export async function copyText(text: string) {
    const nativeCopy = IS_WEB ? undefined : VencordNative.pluginHelpers[PATTERNS.nativeUtils]?.copyText;
    if (nativeCopy && isPluginEnabled(PATTERNS.nativeUtils) && await nativeCopy(text) === true) return;
    await copyToClipboard(text);
}
