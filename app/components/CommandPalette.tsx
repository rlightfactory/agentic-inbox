// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Dialog } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	FileIcon,
	FolderIcon,
	GearSixIcon,
	KeyboardIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	RobotIcon,
	TrashIcon,
	TrayIcon,
	UserIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Folders } from "shared/folders";
import { useFolders } from "~/queries/folders";
import { useUIStore } from "~/hooks/useUIStore";

interface Command {
	id: string;
	label: string;
	section: "Search" | "Go to" | "Actions";
	icon: ReactNode;
	hint?: string;
	run: () => void;
}

const FOLDER_ICONS: Record<string, ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={16} />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={16} />,
	[Folders.DRAFT]: <FileIcon size={16} />,
	[Folders.ARCHIVE]: <ArchiveIcon size={16} />,
	[Folders.TRASH]: <TrashIcon size={16} />,
};

/**
 * Cmd/Ctrl+K quick switcher: jump to a folder, run an action, or turn what you
 * type into a mail / contact search.
 */
export default function CommandPalette({
	onShowShortcuts,
}: {
	onShowShortcuts: () => void;
}) {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const {
		isCommandPaletteOpen,
		closeCommandPalette,
		startCompose,
		toggleAgentPanel,
	} = useUIStore();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (isCommandPaletteOpen) {
			setQuery("");
			setActive(0);
		}
	}, [isCommandPaletteOpen]);

	const commands = useMemo<Command[]>(() => {
		if (!mailboxId) return [];
		const go = (path: string) => () => navigate(`/mailbox/${mailboxId}${path}`);
		const list: Command[] = [
			...folders.map((f) => ({
				id: `folder:${f.id}`,
				label: f.name,
				section: "Go to" as const,
				icon: FOLDER_ICONS[f.id] ?? <FolderIcon size={16} />,
				hint: f.unreadCount > 0 ? `${f.unreadCount} unread` : undefined,
				run: go(`/emails/${f.id}`),
			})),
			{
				id: "compose",
				label: "Compose new email",
				section: "Actions",
				icon: <PencilSimpleIcon size={16} />,
				hint: "C",
				run: () => startCompose(),
			},
			{
				id: "settings",
				label: "Open settings",
				section: "Actions",
				icon: <GearSixIcon size={16} />,
				run: go("/settings"),
			},
			{
				id: "agent",
				label: "Toggle assistant panel",
				section: "Actions",
				icon: <RobotIcon size={16} />,
				run: toggleAgentPanel,
			},
			{
				id: "shortcuts",
				label: "Keyboard shortcuts",
				section: "Actions",
				icon: <KeyboardIcon size={16} />,
				hint: "?",
				run: onShowShortcuts,
			},
		];
		return list;
	}, [mailboxId, folders, navigate, startCompose, toggleAgentPanel, onShowShortcuts]);

	const results = useMemo<Command[]>(() => {
		const q = query.trim();
		const needle = q.toLowerCase();
		const matched = needle
			? commands.filter((c) => c.label.toLowerCase().includes(needle))
			: commands;
		if (!q || !mailboxId) return matched;
		const search = (text: string) => () =>
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(text)}`);
		return [
			{
				id: "search",
				label: `Search emails for “${q}”`,
				section: "Search",
				icon: <MagnifyingGlassIcon size={16} />,
				run: search(q),
			},
			{
				id: "contact",
				label: `All mail with “${q}” (contact)`,
				section: "Search",
				icon: <UserIcon size={16} />,
				run: search(`contact:${q}`),
			},
			...matched,
		];
	}, [query, commands, mailboxId, navigate]);

	useEffect(() => {
		if (active >= results.length) setActive(Math.max(results.length - 1, 0));
	}, [results.length, active]);

	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const run = (cmd: Command | undefined) => {
		if (!cmd) return;
		closeCommandPalette();
		// Let the dialog unmount first so focus returns cleanly to the page.
		window.setTimeout(cmd.run, 0);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			run(results[active]);
		}
	};

	let lastSection = "";

	return (
		<Dialog.Root
			open={isCommandPaletteOpen}
			onOpenChange={(open) => {
				if (!open) closeCommandPalette();
			}}
		>
			<Dialog size="sm" className="overflow-hidden p-0">
				<Dialog.Title className="sr-only">Command palette</Dialog.Title>
				<div className="flex items-center gap-2 border-b border-kumo-line px-4 py-3">
					<MagnifyingGlassIcon size={16} className="shrink-0 text-kumo-subtle" />
					<input
						autoFocus
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						placeholder="Type a command or search…"
						aria-label="Command palette"
						className="w-full bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-subtle"
					/>
					<kbd className="kbd shrink-0 text-kumo-subtle">Esc</kbd>
				</div>

				<div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
					{results.length === 0 && (
						<div className="px-3 py-8 text-center text-sm text-kumo-subtle">
							No matching commands
						</div>
					)}
					{results.map((cmd, index) => {
						const showSection = cmd.section !== lastSection;
						lastSection = cmd.section;
						return (
							<div key={cmd.id}>
								{showSection && (
									<div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle">
										{cmd.section}
									</div>
								)}
								<button
									type="button"
									role="option"
									aria-selected={index === active}
									data-index={index}
									onMouseMove={() => setActive(index)}
									onClick={() => run(cmd)}
									className={`flex w-full items-center gap-2.5 rounded-md border-0 px-2.5 py-2 text-left text-sm cursor-pointer transition-colors ${
										index === active
											? "bg-kumo-fill text-kumo-default"
											: "bg-transparent text-kumo-strong"
									}`}
								>
									<span className="shrink-0 text-kumo-subtle">{cmd.icon}</span>
									<span className="min-w-0 flex-1 truncate">{cmd.label}</span>
									{cmd.hint && (
										<span className="shrink-0 text-xs text-kumo-subtle">
											{cmd.hint.length === 1 ? (
												<kbd className="kbd">{cmd.hint}</kbd>
											) : (
												cmd.hint
											)}
										</span>
									)}
								</button>
							</div>
						);
					})}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
