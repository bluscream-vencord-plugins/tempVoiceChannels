/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import { ExpandableSection } from "@components/ExpandableCard";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { classNameFactory } from "@utils/css";
import { OptionType } from "@utils/types";
import { React, Select, TextInput, useState } from "@webpack/common";

import { creatorLabel, getCreators } from "./core";

const cl = classNameFactory("vc-tempvoice-");

export type Privacy = "unchanged" | "private" | "public";

export interface Preset {
    id: string;
    name: string;
    status: string;
    creatorId: string;
    /** 0 leaves the bot's default limit */
    limit: number;
    privacy: Privacy;
}

/** Which preset fields the server's bot can actually apply. */
export interface PresetFields {
    name: boolean;
    limit: boolean;
    privacy: boolean;
}

const PRIVACY_OPTIONS: { label: string; value: Privacy; }[] = [
    { label: "Leave as is", value: "unchanged" },
    { label: "Private", value: "private" },
    { label: "Public", value: "public" }
];

// Presets saved before limit and privacy existed lack these fields.
export const withDefaults = (p: Preset): Preset => ({ ...p, limit: p.limit ?? 0, privacy: p.privacy ?? "unchanged" });

function Input({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit(value: string): void; }) {
    const [draft, setDraft] = useState(value);
    return <TextInput value={draft} placeholder={placeholder} onChange={setDraft} onBlur={() => draft !== value && onCommit(draft)} />;
}

interface Drop { index: number; after: boolean; }

interface EditorOptions {
    guildId: string;
    fields: PresetFields;
    description: string;
    usePresets(): Preset[];
    savePresets(presets: Preset[]): void;
}

function summary(preset: Preset) {
    return [
        creatorLabel(preset.creatorId),
        preset.status,
        preset.limit && `${preset.limit} slots`,
        preset.privacy !== "unchanged" && (preset.privacy === "private" ? "Private" : "Public")
    ].filter(Boolean).join(" · ");
}

function makePresetEditor({ guildId, fields, description, usePresets, savePresets }: EditorOptions) {
    return function PresetEditor() {
        const presets = usePresets().map(withDefaults);
        const [dragged, setDragged] = useState<number | null>(null);
        const [drop, setDrop] = useState<Drop | null>(null);
        const [added, setAdded] = useState<string | null>(null);
        const creators = getCreators(guildId).map(c => ({ label: creatorLabel(c.id), value: c.id }));

        const update = (index: number, patch: Partial<Preset>) => savePresets(presets.map((p, i) => i === index ? { ...p, ...patch } : p));
        const add = () => {
            const id = crypto.randomUUID();
            setAdded(id);
            savePresets([...presets, { id, name: "", status: "", creatorId: creators[0]?.value ?? "", limit: 0, privacy: "unchanged" }]);
        };

        const onDragOver = (index: number) => (e: React.DragEvent) => {
            e.preventDefault();
            if (dragged === null) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const after = e.clientY - rect.top > rect.height / 2;
            if (drop?.index !== index || drop.after !== after) setDrop({ index, after });
        };
        const onDrop = (e: React.DragEvent) => {
            e.preventDefault();
            if (dragged !== null && drop) {
                let target = drop.index + (drop.after ? 1 : 0);
                if (target > dragged) target--;
                if (target !== dragged) {
                    const next = presets.filter((_, i) => i !== dragged);
                    next.splice(target, 0, presets[dragged]);
                    savePresets(next);
                }
            }
            setDragged(null);
            setDrop(null);
        };

        return (
            <section>
                <Heading className={Margins.bottom8}>Channel Presets</Heading>
                <Paragraph className={Margins.bottom16}>{description} Drag presets to reorder them in the menu.</Paragraph>
                <Flex flexDirection="column" gap="0.5em">
                    {!presets.length && <Paragraph>No presets yet.</Paragraph>}
                    {presets.map((preset, index) => (
                        <div
                            key={preset.id}
                            className={cl("row", { "row-dragging": dragged === index })}
                            onDragOver={onDragOver(index)}
                            onDrop={onDrop}
                        >
                            {drop?.index === index && <div className={cl("drop", drop.after ? "drop-after" : "drop-before")} />}
                            <ExpandableSection
                                initialExpanded={preset.id === added}
                                renderContent={() => (
                                    <>
                                        <div className={cl("grid")}>
                                            <Span weight="medium" size="md">Create channel</Span>
                                            <Select
                                                options={creators}
                                                placeholder="Pick a create channel"
                                                isSelected={v => v === preset.creatorId}
                                                select={v => update(index, { creatorId: v })}
                                                serialize={v => v}
                                            />
                                            {fields.name && <>
                                                <Span weight="medium" size="md">Name</Span>
                                                <Input value={preset.name} placeholder="Rebirth Casual" onCommit={name => update(index, { name })} />
                                            </>}
                                            <Span weight="medium" size="md">Status</Span>
                                            <Input value={preset.status} placeholder="Leave empty for no status" onCommit={status => update(index, { status })} />
                                            {fields.limit && <>
                                                <Span weight="medium" size="md">User limit</Span>
                                                <Input
                                                    value={preset.limit ? String(preset.limit) : ""}
                                                    placeholder="Leave empty for the bot's default"
                                                    onCommit={v => update(index, { limit: Math.max(0, Math.min(99, parseInt(v) || 0)) })}
                                                />
                                            </>}
                                            {fields.privacy && <>
                                                <Span weight="medium" size="md">Visibility</Span>
                                                <Select
                                                    options={PRIVACY_OPTIONS}
                                                    isSelected={v => v === preset.privacy}
                                                    select={(v: Privacy) => update(index, { privacy: v })}
                                                    serialize={v => v}
                                                />
                                            </>}
                                        </div>
                                        <Button className={cl("delete")} variant="dangerPrimary" onClick={() => savePresets(presets.filter((_, i) => i !== index))}>
                                            Delete Preset
                                        </Button>
                                    </>
                                )}
                            >
                                <div
                                    className={cl("header")}
                                    draggable
                                    onDragStart={e => { setDragged(index); e.dataTransfer.setData("text/plain", String(index)); }}
                                    onDragEnd={() => { setDragged(null); setDrop(null); }}
                                >
                                    <Paragraph weight="medium" size="md">{preset.name || `Preset ${index + 1}`}</Paragraph>
                                    <Paragraph size="sm">{summary(preset)}</Paragraph>
                                </div>
                            </ExpandableSection>
                        </div>
                    ))}
                    <Button onClick={add}>Add Preset</Button>
                </Flex>
            </section>
        );
    };
}

/** The settings every temp voice plugin shares. Spread into definePluginSettings. */
export function tempVoiceSettings(options: EditorOptions & { defaultPresets: Preset[]; }) {
    return {
        presetEditor: {
            type: OptionType.COMPONENT as const,
            component: makePresetEditor(options)
        },
        presets: {
            type: OptionType.CUSTOM as const,
            description: "Channel presets.",
            default: options.defaultPresets
        },
        actionDelay: {
            type: OptionType.NUMBER as const,
            description: "Average milliseconds to wait between actions, like clicking a bot button and setting the status. Each wait varies a little so it feels natural.",
            default: 2000,
            isValid: (v: number) => v >= 100 && v <= 30_000 || "Pick a delay between 100 and 30000 milliseconds."
        },
        presetOnManualCreate: {
            type: OptionType.BOOLEAN as const,
            description: "When you create a channel yourself by joining a create channel, apply the first preset for that create channel once the bot has moved you.",
            default: true
        },
        openChat: {
            type: OptionType.BOOLEAN as const,
            description: "When the plugin creates or joins a channel for you, open its chat so you can see what it clicked and what the bot replied.",
            default: true
        }
    };
}
