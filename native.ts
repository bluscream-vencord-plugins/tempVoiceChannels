/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { clipboard, IpcMainInvokeEvent } from "electron";

const MAX_LENGTH = 2000;

export function copyText(_: IpcMainInvokeEvent, text: unknown) {
    if (typeof text !== "string" || !text || text.length > MAX_LENGTH) return false;
    clipboard.writeText(text);
    return true;
}
