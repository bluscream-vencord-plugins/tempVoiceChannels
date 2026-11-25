/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Works on both raw gateway components (custom_id) and store components (customId).
export interface Component {
    type: number;
    id?: string | number;
    customId?: string;
    custom_id?: string;
    content?: string;
    value?: string;
    components?: Component[];
    component?: Component;
    accessory?: Component;
}

function isComponent(x: unknown): x is Component {
    return typeof x === "object" && x !== null && typeof (x as { type?: unknown; }).type === "number";
}

export function walkComponents(list: unknown[] | undefined, visit: (c: Component) => void) {
    for (const c of list ?? []) {
        if (!isComponent(c)) continue;
        visit(c);
        walkComponents([...c.components ?? [], c.component, c.accessory], visit);
    }
}

export function findComponent(list: unknown[] | undefined, customId: string) {
    let found: Component | null = null;
    walkComponents(list, c => { if (!found && (c.customId ?? c.custom_id) === customId) found = c; });
    return found as Component | null;
}

export function getText(list: unknown[] | undefined) {
    const parts: string[] = [];
    walkComponents(list, c => { if (c.type === 10 && c.content) parts.push(c.content); });
    return parts.join("\n");
}
