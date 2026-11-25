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
    disabled?: boolean;
    components?: Component[];
    component?: Component;
    accessory?: Component;
}

function isComponent(x: unknown): x is Component {
    return typeof x === "object" && x !== null && "type" in x && typeof x.type === "number";
}

/** Every component in the tree, depth first, including section accessories and label children. */
export function* walkComponents(list: unknown[] | undefined): Generator<Component> {
    for (const c of list ?? []) {
        if (!isComponent(c)) continue;
        yield c;
        yield* walkComponents([...c.components ?? [], c.component, c.accessory]);
    }
}

export function findComponent(list: unknown[] | undefined, customId: string) {
    for (const c of walkComponents(list))
        if ((c.customId ?? c.custom_id) === customId) return c;
    return null;
}

export function getText(list: unknown[] | undefined) {
    return [...walkComponents(list)].filter(c => c.type === 10 && c.content).map(c => c.content).join("\n");
}
