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
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, React, Select, TextInput, useCallback, useRef, useState } from "@webpack/common";


const cl = classNameFactory("vc-tempvoice-");

/** Both bots mark their create channels with a ➕ in the name. */
export const isCreatorName = (name: string) => name.includes("➕");

export function getCreators(guildId: string): Channel[] {
    const { VOCAL = [] } = GuildChannelStore.getChannels(guildId);
    return VOCAL.map(({ channel }) => channel).filter(c => isCreatorName(c.name));
}

export function creatorLabel(creatorId: string) {
    const creator = ChannelStore.getChannel(creatorId);
    if (!creator) return "Unknown channel";
    const category = creator.parent_id ? ChannelStore.getChannel(creator.parent_id)?.name : null;
    return category ? `${category} › ${creator.name}` : creator.name;
}

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
    guildId(): string;
    fields: PresetFields;
    description: string;
    usePresets(): Preset[];
    savePresets(presets: Preset[]): void;
}

interface PresetFormProps {
    preset: Preset;
    creators: { label: string; value: string; }[];
    fields: PresetFields;
    onUpdate(patch: Partial<Preset>): void;
    onDelete(): void;
}

function PresetForm({ preset, creators, fields, onUpdate, onDelete }: PresetFormProps) {
    return (
        <>
            <div className={cl("grid")}>
                <Span weight="medium" size="md">Create channel</Span>
                <Select
                    options={creators}
                    placeholder="Pick a create channel"
                    isSelected={v => v === preset.creatorId}
                    select={v => onUpdate({ creatorId: v })}
                    serialize={v => v}
                />
                {fields.name && <>
                    <Span weight="medium" size="md">Name</Span>
                    <Input value={preset.name} placeholder="Rebirth Casual" onCommit={name => onUpdate({ name })} />
                </>}
                <Span weight="medium" size="md">Status</Span>
                <Input value={preset.status} placeholder="Leave empty for no status" onCommit={status => onUpdate({ status })} />
                {fields.limit && <>
                    <Span weight="medium" size="md">User limit</Span>
                    <Input
                        value={preset.limit ? String(preset.limit) : ""}
                        placeholder="Leave empty for the bot's default"
                        onCommit={v => onUpdate({ limit: Math.max(0, Math.min(99, parseInt(v) || 0)) })}
                    />
                </>}
                {fields.privacy && <>
                    <Span weight="medium" size="md">Visibility</Span>
                    <Select
                        options={PRIVACY_OPTIONS}
                        isSelected={v => v === preset.privacy}
                        select={(v: Privacy) => onUpdate({ privacy: v })}
                        serialize={v => v}
                    />
                </>}
            </div>
            <Button className={cl("delete")} variant="dangerPrimary" onClick={onDelete}>
                Delete Preset
            </Button>
        </>
    );
}

// ExpandableSection mounts renderContent as a component, so it needs a stable identity or the form remounts and loses focus on every save.
function PresetCard({ initialExpanded, children, ...form }: PresetFormProps & { initialExpanded: boolean; children: React.ReactNode; }) {
    const latest = useRef(form);
    latest.current = form;
    const Content = useCallback(() => <PresetForm {...latest.current} />, []);
    return <ExpandableSection initialExpanded={initialExpanded} renderContent={Content}>{children}</ExpandableSection>;
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
        const creators = getCreators(guildId()).map(c => ({ label: creatorLabel(c.id), value: c.id }));

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
                            <PresetCard
                                initialExpanded={preset.id === added}
                                preset={preset}
                                creators={creators}
                                fields={fields}
                                onUpdate={patch => update(index, patch)}
                                onDelete={() => savePresets(presets.filter((_, i) => i !== index))}
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
                            </PresetCard>
                        </div>
                    ))}
                    <Button onClick={add}>Add Preset</Button>
                </Flex>
            </section>
        );
    };
}

interface ServerSettingsOptions extends Omit<EditorOptions, "guildId"> {
    defaultGuildId: string;
    defaultBotId: string;
    defaultPresets: Preset[];
    guildId(): string;
}

/**
 * The settings every server plugin has: its presets and the hidden server and bot IDs.
 * Spread into definePluginSettings. Delays and other shared options live in TempVoiceChannels.
 */
export function serverSettings(options: ServerSettingsOptions) {
    return {
        presetEditor: {
            type: OptionType.COMPONENT as const,
            component: makePresetEditor(options)
        },
        presets: {
            type: OptionType.CUSTOM as const,
            description: "Channel presets.",
            default: options.defaultPresets satisfies Preset[]
        },
        guildId: {
            type: OptionType.STRING as const,
            description: "ID of the server this plugin works on.",
            default: options.defaultGuildId,
            hidden: true
        },
        botId: {
            type: OptionType.STRING as const,
            description: "ID of the server's temp voice bot.",
            default: options.defaultBotId,
            hidden: true
        }
    };
}
