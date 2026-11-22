// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Checkbox,
	Dialog,
	Pagination,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	ChecksIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import ContactAvatar from "~/components/ContactAvatar";
import MailboxSplitView from "~/components/MailboxSplitView";
import { getRowPeople } from "~/lib/contacts";
import { getSnippetText } from "~/lib/utils";
import {
	useConversationAction,
	useDeleteEmail,
	useEmails,
	useEmptyFolder,
	useMarkConversationRead,
	useMarkFolderRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useMailbox } from "~/queries/mailboxes";
import { useShortcuts } from "~/hooks/useShortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

type Filter = "all" | "unread" | "starred";

const FILTERS: { id: Filter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "unread", label: "Unread" },
	{ id: "starred", label: "Starred" },
];

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Trash is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	filter,
	onCompose,
}: {
	folder?: string;
	filter: Filter;
	onCompose: () => void;
}) {
	if (filter !== "all") {
		return (
			<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
				<EnvelopeSimpleIcon
					size={48}
					weight="thin"
					className="text-kumo-subtle mb-4"
				/>
				<h3 className="text-base font-semibold text-kumo-default mb-1.5">
					{filter === "unread" ? "No unread conversations" : "No starred conversations"}
				</h3>
				<p className="text-sm text-kumo-subtle max-w-xs">
					{filter === "unread"
						? "You're all caught up."
						: "Star a conversation to find it here quickly."}
				</p>
			</div>
		);
	}

	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const [filter, setFilter] = useState<Filter>("all");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pendingDelete, setPendingDelete] = useState<{
		ids: string[];
		kind: "draft" | "conversation";
	} | null>(null);
	const [confirmEmpty, setConfirmEmpty] = useState(false);
	const toastManager = useKumoToastManager();

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const deleteEmail = useDeleteEmail();
	const conversationAction = useConversationAction();
	const markConversationRead = useMarkConversationRead();
	const markFolderRead = useMarkFolderRead();
	const emptyFolder = useEmptyFolder();

	const isDraftFolder = folder === Folders.DRAFT;
	const isTrashFolder = folder === Folders.TRASH;
	const isArchiveFolder = folder === Folders.ARCHIVE;
	const isOutgoingFolder = folder === Folders.SENT || isDraftFolder;
	const canArchive = !isDraftFolder && !isArchiveFolder;

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
			...(filter !== "all" && !isDraftFolder ? { filter } : {}),
		}),
		[folder, page, filter, isDraftFolder],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);
	const { data: mailbox } = useMailbox(mailboxId);

	const currentFolder = folders.find((f) => f.id === folder);
	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder]);
	const folderUnread = currentFolder?.unreadCount ?? 0;

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
			setFilter("all");
		}
	}, [mailboxId, folder, closePanel]);

	// A selection only makes sense for the rows it was made on.
	useEffect(() => {
		setSelected(new Set());
	}, [mailboxId, folder, page, filter]);

	const changeFilter = (next: Filter) => {
		setFilter(next);
		setPage(1);
	};

	const notifyError = (title: string) =>
		toastManager.add({ title, variant: "error" });

	// ── Actions ────────────────────────────────────────────────────

	/** Archive / trash / move conversations, with an Undo toast. */
	const moveConversations = async (
		ids: string[],
		action: "archive" | "trash" | "move",
		doneLabel: string,
		folderId?: string,
	) => {
		if (!mailboxId || ids.length === 0) return;
		try {
			const result = await conversationAction.mutateAsync({
				mailboxId,
				emailIds: ids,
				action,
				folderId,
			});
			if (selectedEmailId && ids.includes(selectedEmailId)) closePanel();
			setSelected(new Set());
			const origin = result.originalFolder;
			toastManager.add({
				title:
					ids.length > 1
						? `${ids.length} conversations ${doneLabel}`
						: `Conversation ${doneLabel}`,
				actions:
					origin && result.affected.length > 0
						? [
								{
									children: "Undo",
									variant: "secondary",
									size: "sm",
									onClick: () =>
										conversationAction.mutate({
											mailboxId,
											emailIds: result.affected,
											action: "move_messages",
											folderId: origin,
										}),
								},
							]
						: undefined,
			});
		} catch {
			notifyError("Action failed. Please try again.");
		}
	};

	const archive = (ids: string[]) => moveConversations(ids, "archive", "archived");

	const setRead = (ids: string[], read: boolean) => {
		if (!mailboxId || ids.length === 0 || isDraftFolder) return;
		conversationAction.mutate(
			{ mailboxId, emailIds: ids, action: read ? "read" : "unread" },
			{ onError: () => notifyError("Action failed. Please try again.") },
		);
	};

	const toggleStarFor = (email: Email) => {
		if (!mailboxId) return;
		if (isDraftFolder) {
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
			return;
		}
		conversationAction.mutate({
			mailboxId,
			emailIds: [email.id],
			action: email.starred ? "unstar" : "star",
		});
	};

	/** Trash by default; permanent (with confirmation) from Trash and for drafts. */
	const requestDelete = (ids: string[]) => {
		if (ids.length === 0) return;
		if (isDraftFolder) setPendingDelete({ ids, kind: "draft" });
		else if (isTrashFolder) setPendingDelete({ ids, kind: "conversation" });
		else moveConversations(ids, "trash", "moved to Trash");
	};

	const confirmDelete = async () => {
		const target = pendingDelete;
		setPendingDelete(null);
		if (!mailboxId || !target) return;
		try {
			if (target.kind === "draft") {
				await Promise.all(
					target.ids.map((id) => deleteEmail.mutateAsync({ mailboxId, id })),
				);
			} else {
				await conversationAction.mutateAsync({
					mailboxId,
					emailIds: target.ids,
					action: "delete",
				});
			}
			if (selectedEmailId && target.ids.includes(selectedEmailId)) closePanel();
			setSelected(new Set());
			toastManager.add({
				title:
					target.ids.length > 1
						? `${target.ids.length} conversations deleted`
						: "Deleted",
			});
		} catch {
			notifyError("Failed to delete");
		}
	};

	const handleMarkAllRead = () => {
		if (!mailboxId || !folder) return;
		markFolderRead.mutate(
			{ mailboxId, folderId: folder },
			{
				onSuccess: () => toastManager.add({ title: "All marked as read" }),
				onError: () => notifyError("Action failed. Please try again."),
			},
		);
	};

	const handleEmptyFolder = () => {
		setConfirmEmpty(false);
		if (!mailboxId || !folder) return;
		emptyFolder.mutate(
			{ mailboxId, folderId: folder },
			{
				onSuccess: () => {
					closePanel();
					toastManager.add({ title: `${folderName} emptied` });
				},
				onError: () => notifyError("Failed to empty folder"),
			},
		);
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// ── Selection ──────────────────────────────────────────────────

	const toggleSelected = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const allSelected = emails.length > 0 && emails.every((e) => selected.has(e.id));
	const toggleAll = () =>
		setSelected(allSelected ? new Set() : new Set(emails.map((e) => e.id)));

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (isDraftFolder) {
				updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } });
			} else {
				markConversationRead.mutate({ mailboxId, emailId: email.id });
			}
		}
	};

	/** Who this row is about: other people (or recipients in Sent/Drafts). */
	const getRow = (email: Email) =>
		getRowPeople(email, mailbox?.email, isOutgoingFolder);

	// ── Keyboard shortcuts ─────────────────────────────────────────

	const targetIds = selected.size > 0
		? [...selected]
		: selectedEmailId
			? [selectedEmailId]
			: [];

	const moveSelection = (delta: number) => {
		if (emails.length === 0) return;
		const idx = emails.findIndex((e) => e.id === selectedEmailId);
		const next =
			idx === -1
				? delta > 0
					? 0
					: emails.length - 1
				: Math.min(Math.max(idx + delta, 0), emails.length - 1);
		handleRowClick(emails[next]);
	};

	useShortcuts(
		{
			j: () => moveSelection(1),
			k: () => moveSelection(-1),
			x: () => selectedEmailId && toggleSelected(selectedEmailId),
			e: () => canArchive && archive(targetIds),
			"#": () => requestDelete(targetIds),
			Delete: () => requestDelete(targetIds),
			s: () => {
				const row = emails.find((e) => e.id === selectedEmailId);
				if (row) toggleStarFor(row);
			},
			u: () => {
				setRead(targetIds, false);
				if (selectedEmailId) closePanel();
			},
			c: (event) => {
				event.preventDefault();
				startCompose();
			},
			"/": (event) => {
				event.preventDefault();
				document
					.querySelector<HTMLInputElement>('input[placeholder^="Search emails"]')
					?.focus();
			},
			Escape: () => {
				if (selected.size > 0) setSelected(new Set());
				else if (selectedEmailId) closePanel();
			},
		},
		!isComposing && !pendingDelete && !confirmEmpty,
	);

	const bulkMode = selected.size > 0;

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header / bulk action bar */}
				{bulkMode ? (
					<div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-kumo-line shrink-0 bg-kumo-tint md:px-5">
						<span className="text-sm font-medium text-kumo-default">
							{selected.size} selected
						</span>
						<div className="flex items-center gap-0.5">
							{canArchive && (
								<Tooltip content="Archive (e)" side="bottom" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<ArchiveIcon size={18} />}
										onClick={() => archive([...selected])}
										aria-label="Archive selected"
									/>
								</Tooltip>
							)}
							<Tooltip
								content={isTrashFolder || isDraftFolder ? "Delete forever" : "Move to Trash (#)"}
								side="bottom"
								asChild
							>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<TrashIcon size={18} />}
									onClick={() => requestDelete([...selected])}
									aria-label="Delete selected"
								/>
							</Tooltip>
							{!isDraftFolder && (
								<>
									<Tooltip content="Mark as read" side="bottom" asChild>
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<EnvelopeOpenIcon size={18} />}
											onClick={() => {
												setRead([...selected], true);
												setSelected(new Set());
											}}
											aria-label="Mark selected as read"
										/>
									</Tooltip>
									<Tooltip content="Mark as unread (u)" side="bottom" asChild>
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<EnvelopeSimpleIcon size={18} />}
											onClick={() => {
												setRead([...selected], false);
												setSelected(new Set());
											}}
											aria-label="Mark selected as unread"
										/>
									</Tooltip>
								</>
							)}
							<Tooltip content="Clear selection (Esc)" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<XIcon size={18} />}
									onClick={() => setSelected(new Set())}
									aria-label="Clear selection"
								/>
							</Tooltip>
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
						<h1 className="text-lg font-semibold text-kumo-default">
							{folderName}
						</h1>
						<div className="flex items-center gap-1">
							{totalCount > 0 && (
								<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
									{totalCount} conversation{totalCount !== 1 ? "s" : ""}
								</span>
							)}
							{folderUnread > 0 && !isDraftFolder && (
								<Tooltip content="Mark all as read" side="bottom" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<ChecksIcon size={18} />}
										onClick={handleMarkAllRead}
										disabled={markFolderRead.isPending}
										aria-label="Mark all as read"
									/>
								</Tooltip>
							)}
							{(isTrashFolder || folder === Folders.SPAM) && totalCount > 0 && (
								<Button
									variant="ghost"
									size="sm"
									icon={<TrashIcon size={16} />}
									onClick={() => setConfirmEmpty(true)}
								>
									Empty {folderName.toLowerCase()}
								</Button>
							)}
							<Tooltip
								content={isRefreshing ? "Refreshing..." : "Refresh"}
								side="bottom"
								asChild
							>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={
										<ArrowsClockwiseIcon
											size={18}
											className={isRefreshing ? "animate-spin" : ""}
										/>
									}
									onClick={handleRefresh}
									disabled={isRefreshing}
									aria-label="Refresh"
								/>
							</Tooltip>
						</div>
					</div>
				)}

				{/* Select-all + filter tabs */}
				{(emails.length > 0 || filter !== "all") && (
					<div className="flex items-center gap-3 px-4 py-1.5 border-b border-kumo-line shrink-0 md:px-5">
						<Checkbox
							aria-label="Select all conversations"
							checked={allSelected}
							onCheckedChange={toggleAll}
						/>
						{!isDraftFolder && (
							<div className="flex items-center gap-1" role="tablist" aria-label="Filter conversations">
								{FILTERS.map((f) => (
									<button
										key={f.id}
										type="button"
										role="tab"
										aria-selected={filter === f.id}
										onClick={() => changeFilter(f.id)}
										className={`rounded-full border-0 px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${
											filter === f.id
												? "bg-kumo-fill text-kumo-default"
												: "bg-transparent text-kumo-subtle hover:text-kumo-default"
										}`}
									>
										{f.label}
									</button>
								))}
							</div>
						)}
					</div>
				)}

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const isChecked = selected.has(email.id);
								const snippet = getSnippetText(email.snippet);
								const row = getRow(email);
								const unread = hasUnread(email);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.target !== e.currentTarget) return;
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-5 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected || isChecked ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Select */}
										<div
											className="shrink-0"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											<Checkbox
												aria-label="Select conversation"
												checked={isChecked}
												onCheckedChange={() => toggleSelected(email.id)}
											/>
										</div>

										{/* Unread dot */}
										<div className="w-2 shrink-0 flex justify-center">
											{unread && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											aria-label={email.starred ? "Unstar" : "Star"}
											onClick={(e) => {
												e.stopPropagation();
												toggleStarFor(email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Avatar of the latest sender */}
										<ContactAvatar
											label={row.primary.label}
											email={row.primary.email}
											size={36}
										/>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													title={row.title}
													className={`truncate text-sm shrink-0 max-w-[70%] ${unread ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{row.label}
												</span>
												{row.people.length === 1 && row.people[0].domain && (
													<span className="hidden sm:inline min-w-0 truncate text-xs text-kumo-subtle">
														{row.people[0].domain}
													</span>
												)}
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														Draft
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={unread ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{email.subject}
												</span>
												{snippet && (
													<span className="text-kumo-subtle font-normal">
														{" "}&mdash; {snippet}
													</span>
												)}
											</div>
										</div>

										{/* Row actions -- always visible on touch, hover-only on desktop */}
										<div
											className="flex md:hidden md:group-hover:flex items-center shrink-0"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											{canArchive && (
												<Tooltip content="Archive" asChild>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														icon={<ArchiveIcon size={14} />}
														onClick={() => archive([email.id])}
														aria-label="Archive"
													/>
												</Tooltip>
											)}
											{!isDraftFolder && (
												<Tooltip content={unread ? "Mark read" : "Mark unread"} asChild>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														icon={unread ? <EnvelopeOpenIcon size={14} /> : <EnvelopeSimpleIcon size={14} />}
														onClick={() => setRead([email.id], unread)}
														aria-label={unread ? "Mark read" : "Mark unread"}
													/>
												</Tooltip>
											)}
											<Tooltip
												content={isTrashFolder || isDraftFolder ? "Delete forever" : "Move to Trash"}
												asChild
											>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													onClick={() => requestDelete([email.id])}
													aria-label="Delete"
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							filter={filter}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}

				{/* Permanent delete confirmation */}
				<Dialog.Root
					open={pendingDelete !== null}
					onOpenChange={(open) => {
						if (!open) setPendingDelete(null);
					}}
				>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="text-base font-semibold mb-2">
							Delete forever
						</Dialog.Title>
						<Dialog.Description className="text-kumo-subtle text-sm mb-5">
							{pendingDelete && pendingDelete.ids.length > 1
								? `Delete ${pendingDelete.ids.length} conversations permanently? This action cannot be undone.`
								: "Delete this permanently? This action cannot be undone."}
						</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								variant="destructive"
								size="sm"
								onClick={confirmDelete}
							>
								Delete
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>

				{/* Empty Trash / Spam confirmation */}
				<Dialog.Root open={confirmEmpty} onOpenChange={setConfirmEmpty}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="text-base font-semibold mb-2">
							Empty {folderName.toLowerCase()}
						</Dialog.Title>
						<Dialog.Description className="text-kumo-subtle text-sm mb-5">
							Permanently delete everything in {folderName}? This action cannot
							be undone.
						</Dialog.Description>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								variant="destructive"
								size="sm"
								onClick={handleEmptyFolder}
							>
								Empty {folderName.toLowerCase()}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
		</MailboxSplitView>
	);
}
