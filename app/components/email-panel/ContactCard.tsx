// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CaretUpIcon,
	LinkSimpleIcon,
	MagnifyingGlassIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import ContactAvatar from "~/components/ContactAvatar";
import { parseAddress } from "~/lib/contacts";
import { getSnippetText } from "~/lib/utils";
import {
	useContact,
	useMergeContact,
	useUnmergeContact,
} from "~/queries/contacts";
import { useUIStore } from "~/hooks/useUIStore";

const COLLAPSED_CONVERSATIONS = 5;

/** Automated senders: merging them with a person never makes sense. */
const AUTOMATED_LOCAL_PART =
	/^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|bounces?|postmaster|newsletter)/i;

/** Calendar date with year, e.g. "Nov 22, 2026" (the shared short format is time-only). */
function formatDay(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return dateStr;
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function formatDayTime(dateStr: string): string {
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return dateStr;
	return `${formatDay(dateStr)}, ${d.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	})}`;
}

interface ContactCardProps {
	mailboxId?: string;
	/** Address of the person whose message is being read. */
	senderEmail: string;
	senderName?: string | null;
}

/**
 * "Who is this?" card shown above a conversation: the contact's name and
 * domain, every address merged into them, and all of their conversations
 * across subjects/threads, so one customer reads as one customer.
 */
export default function ContactCard({
	mailboxId,
	senderEmail,
	senderName,
}: ContactCardProps) {
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const selectEmail = useUIStore((s) => s.selectEmail);
	const [expanded, setExpanded] = useState(false);
	const [showAllConversations, setShowAllConversations] = useState(false);
	const [mergeOpen, setMergeOpen] = useState(false);
	const [mergeInput, setMergeInput] = useState("");
	const address = senderEmail.toLowerCase();

	const { data: contact } = useContact(mailboxId, address);
	const merge = useMergeContact();
	const unmerge = useUnmergeContact();

	if (!contact) return null;

	const display = parseAddress(contact.email, contact.name ?? senderName);
	const aliases = contact.addresses.filter((a) => a !== contact.email);
	const { stats } = contact;
	const localPart = contact.email.split("@")[0] ?? "";
	const isAutomated = AUTOMATED_LOCAL_PART.test(localPart);

	const conversations = showAllConversations
		? contact.conversations
		: contact.conversations.slice(0, COLLAPSED_CONVERSATIONS);
	const hiddenCount = contact.conversations.length - conversations.length;

	const error = (message: string) =>
		toastManager.add({ title: message, variant: "error" });

	const handleMerge = () => {
		const other = mergeInput.trim().toLowerCase();
		if (!mailboxId) return;
		if (!/^[^\s@<>]+@[^\s@<>]+$/.test(other)) {
			error("Enter a full email address, e.g. name@company.com");
			return;
		}
		merge.mutate(
			{ mailboxId, email: other, into: contact.email },
			{
				onSuccess: () => {
					setMergeInput("");
					setMergeOpen(false);
					toastManager.add({ title: `${other} merged into this contact` });
				},
				onError: () => error("Those addresses already belong to one contact"),
			},
		);
	};

	return (
		<div className="border-b border-kumo-line bg-kumo-tint/40 shrink-0">
			{/* Compact one-line header: name · address, with the conversation count on the right */}
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left bg-transparent border-0 cursor-pointer md:px-6"
				aria-expanded={expanded}
			>
				<ContactAvatar label={display.label} email={contact.email} size={24} />
				<div className="min-w-0 flex-1 truncate text-xs">
					<span className="font-medium text-kumo-default">{display.label}</span>
					<span className="ml-2 text-kumo-subtle">{contact.email}</span>
					{aliases.length > 0 && (
						<span className="ml-2 text-kumo-subtle">
							+{aliases.length} address{aliases.length > 1 ? "es" : ""}
						</span>
					)}
				</div>
				<span className="shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-xs text-kumo-subtle">
					{stats.conversation_count} conversation
					{stats.conversation_count !== 1 ? "s" : ""}
				</span>
				{expanded ? (
					<CaretUpIcon size={14} className="text-kumo-subtle shrink-0" />
				) : (
					<CaretDownIcon size={14} className="text-kumo-subtle shrink-0" />
				)}
			</button>

			{expanded && (
				<div className="px-4 pb-3 pt-1 md:px-6 space-y-3">
					{/* Facts, one per line so nothing is cut off */}
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
						{contact.domain && (
							<>
								<dt className="text-kumo-subtle">Company</dt>
								<dd className="text-kumo-default">{contact.domain}</dd>
							</>
						)}
						<dt className="text-kumo-subtle">Messages</dt>
						<dd className="text-kumo-default">
							{stats.total_messages} ({stats.received_messages} received)
						</dd>
						{stats.first_date && (
							<>
								<dt className="text-kumo-subtle">First contact</dt>
								<dd className="text-kumo-default">{formatDay(stats.first_date)}</dd>
							</>
						)}
						{stats.last_date && (
							<>
								<dt className="text-kumo-subtle">Last contact</dt>
								<dd className="text-kumo-default">{formatDay(stats.last_date)}</dd>
							</>
						)}
					</dl>

					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="secondary"
							size="xs"
							icon={<MagnifyingGlassIcon size={12} />}
							onClick={() =>
								navigate(
									`/mailbox/${mailboxId}/search?q=${encodeURIComponent(`contact:${contact.email}`)}`,
								)
							}
						>
							View all mail
						</Button>
						{!isAutomated && !mergeOpen && (
							<Button
								variant="ghost"
								size="xs"
								icon={<LinkSimpleIcon size={12} />}
								onClick={() => setMergeOpen(true)}
							>
								Merge another address…
							</Button>
						)}
					</div>

					{mergeOpen && !isAutomated && (
						<div className="flex items-center gap-2">
							<input
								type="email"
								autoFocus
								value={mergeInput}
								onChange={(e) => setMergeInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleMerge();
									if (e.key === "Escape") setMergeOpen(false);
								}}
								placeholder="Other address of this person"
								className="min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-xs text-kumo-default"
							/>
							<Button
								variant="primary"
								size="xs"
								onClick={handleMerge}
								disabled={!mergeInput.trim() || merge.isPending}
							>
								Merge
							</Button>
							<Button
								variant="ghost"
								size="xs"
								onClick={() => {
									setMergeOpen(false);
									setMergeInput("");
								}}
							>
								Cancel
							</Button>
						</div>
					)}

					{aliases.length > 0 && (
						<div className="space-y-1">
							<div className="text-xs font-medium text-kumo-default">
								Also known as
							</div>
							<div className="flex flex-wrap gap-1.5">
								{aliases.map((alias) => (
									<span
										key={alias}
										className="inline-flex items-center gap-1 rounded-full bg-kumo-fill px-2 py-0.5 text-xs text-kumo-strong"
									>
										{alias}
										<button
											type="button"
											aria-label={`Unmerge ${alias}`}
											className="bg-transparent border-0 p-0 cursor-pointer text-kumo-subtle hover:text-kumo-destructive"
											onClick={() =>
												mailboxId &&
												unmerge.mutate(
													{ mailboxId, email: alias },
													{ onError: () => error("Failed to unmerge address") },
												)
											}
										>
											<XIcon size={11} />
										</button>
									</span>
								))}
							</div>
						</div>
					)}

					<div className="space-y-1">
						<div className="text-xs font-medium text-kumo-default">
							Conversations ({contact.conversations.length})
						</div>
						<div className="max-h-64 overflow-y-auto -mx-2">
							{conversations.map((c) => {
								const unread = c.unread_count > 0;
								const snippet = getSnippetText(c.snippet, 90);
								return (
									<button
										key={c.id}
										type="button"
										onClick={() => selectEmail(c.id)}
										className="block w-full rounded px-2 py-1.5 text-left bg-transparent border-0 cursor-pointer hover:bg-kumo-tint"
									>
										<div className="flex items-center gap-2 text-xs">
											<span
												className={`h-1.5 w-1.5 shrink-0 rounded-full ${unread ? "bg-kumo-brand" : "bg-transparent"}`}
											/>
											<span
												className={`truncate flex-1 ${unread ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
											>
												{c.subject || "(no subject)"}
											</span>
											{c.message_count > 1 && (
												<span className="shrink-0 rounded-full bg-kumo-fill px-1.5 text-kumo-subtle">
													{c.message_count}
												</span>
											)}
											{c.folder_id !== "inbox" && (
												<span className="shrink-0 text-kumo-subtle capitalize">
													{c.folder_id}
												</span>
											)}
											<span className="shrink-0 text-kumo-subtle">
												{formatDayTime(c.date)}
											</span>
										</div>
										{snippet && (
											<div className="truncate pl-3.5 text-xs text-kumo-subtle">
												{snippet}
											</div>
										)}
									</button>
								);
							})}
						</div>
						{(hiddenCount > 0 || showAllConversations) &&
							contact.conversations.length > COLLAPSED_CONVERSATIONS && (
								<Button
									variant="ghost"
									size="xs"
									onClick={() => setShowAllConversations((v) => !v)}
								>
									{showAllConversations
										? "Show fewer"
										: `Show all ${contact.conversations.length}`}
								</Button>
							)}
					</div>
				</div>
			)}
		</div>
	);
}
