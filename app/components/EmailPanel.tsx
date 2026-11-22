// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import ContactCard from "~/components/email-panel/ContactCard";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { parseAddress } from "~/lib/contacts";
import { splitEmailList, toEmailListValue } from "~/lib/utils";
import api from "~/services/api";
import { useConversation, useConversationAction, useDeleteEmail, useEmail, useReplyToEmail, useSendEmail, useUpdateEmail } from "~/queries/emails";
import { useShortcuts } from "~/hooks/useShortcuts";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Folder, Mailbox } from "~/types";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const value = reader.result;
			if (typeof value !== "string") return reject(new Error("Failed to read draft attachment"));
			resolve(value.slice(value.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read draft attachment"));
		reader.readAsDataURL(blob);
	});
}

export default function EmailPanel({ emailId }: { emailId: string }) {
	const { mailboxId, folder } = useParams<{ mailboxId: string; folder: string }>();
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useConversation(mailboxId, emailId) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const conversationAction = useConversationAction();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { closePanel, startCompose, isComposing } = useUIStore();
	const scrollRef = useRef<HTMLDivElement>(null);
	const initializedFor = useRef<string | null>(null);
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const isDraftFolder = folder === Folders.DRAFT;

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	// Once the whole conversation has loaded: expand the newest message plus any
	// unread ones, collapse the rest, and scroll the newest into view (Gmail style).
	// Runs once per opened email, so background refetches don't undo manual toggles.
	useEffect(() => {
		if (!currentEmailId || allMessages.length < 2) return;
		if (initializedFor.current === currentEmailId) return;
		initializedFor.current = currentEmailId;
		const newest = allMessages[allMessages.length - 1];
		setExpandedMessages(new Set([newest.id, ...allMessages.filter((m) => m.id !== newest.id && !m.read).map((m) => m.id)]));
		requestAnimationFrame(() => {
			scrollRef.current?.querySelector("[data-latest]")?.scrollIntoView({ block: "start" });
		});
	}, [currentEmailId, allMessages]);

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const newestFirst = [...allMessages].reverse();
		const received = newestFirst.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = newestFirst.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	// Reply / reply all / forward from the keyboard (Gmail: r, a, f).
	useShortcuts(
		{
			r: () => { if (email) startCompose({ mode: "reply", originalEmail: lastReceivedMessage }); },
			a: () => { if (email) startCompose({ mode: "reply-all", originalEmail: lastReceivedMessage }); },
			f: () => { if (email) startCompose({ mode: "forward", originalEmail: email }); },
		},
		!!email && !isDraftFolder && !isComposing,
	);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur); }, [folders, folder, email?.folder_id]);

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const moveConversation = async (action: "archive" | "trash" | "move", doneLabel: string, folderId?: string) => {
		if (!mailboxId) return;
		try {
			const result = await conversationAction.mutateAsync({ mailboxId, emailIds: [email.id], action, folderId });
			closePanel();
			const origin = result.originalFolder;
			toastManager.add({
				title: `Conversation ${doneLabel}`,
				actions: origin && result.affected.length > 0
					? [{
						children: "Undo",
						variant: "secondary",
						size: "sm",
						onClick: () => conversationAction.mutate({ mailboxId, emailIds: result.affected, action: "move_messages", folderId: origin }),
					}]
					: undefined,
			});
		} catch {
			toastManager.add({ title: "Action failed. Please try again.", variant: "error" });
		}
	};
	const handleMove = (folderId: string) => { moveConversation("move", "moved", folderId); };
	const handleArchive = () => { moveConversation("archive", "archived"); };
	const inTrash = folder === Folders.TRASH || email.folder_id === Folders.TRASH;
	const handleDelete = async () => {
		if (!mailboxId) return;
		if (isDraftFolder || inTrash) {
			if (!window.confirm("Delete this permanently? This cannot be undone.")) return;
			try {
				if (isDraftFolder) await deleteEmailMut.mutateAsync({ mailboxId, id: email.id });
				else await conversationAction.mutateAsync({ mailboxId, emailIds: [email.id], action: "delete" });
				closePanel();
			} catch {
				toastManager.add({ title: "Failed to delete", variant: "error" });
			}
			return;
		}
		moveConversation("trash", "moved to Trash");
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to), draftEmail: target }); }
		else { startCompose({ mode: "new", originalEmail: undefined, draftEmail: target }); }
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("Discard this draft?")) return;
		deleteEmailMut.mutate({ mailboxId, id: target.id });
		toastManager.add({ title: "Draft discarded" });
		if (target.id === emailId) closePanel();
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject || target.attachments === undefined) { try { const fresh = await api.getEmail(mailboxId, target.id) as Email; if (fresh) target = fresh; } catch {} }
			if (!target.recipient) { toastManager.add({ title: "Cannot send: no recipient set on this draft.", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "Cannot send: no valid recipient set on this draft.", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			const storedAttachments = await Promise.all((target.attachments || []).map(async (attachment) => ({
				content: await blobToBase64(await api.getAttachment(mailboxId, target.id, attachment.id)),
				filename: attachment.filename,
				type: attachment.mimetype || "application/octet-stream",
				disposition: (attachment.disposition === "inline" ? "inline" : "attachment") as "inline" | "attachment",
			})));
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "(no subject)",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
				...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
			};
			if (originalEmail) await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData }); else await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			toastManager.add({ title: "Email sent!" });
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const hasThread = allMessages.length > 1;

	// The contact is whoever we're talking to: the latest sender that isn't
	// this mailbox, or the first recipient when only our own mail is shown.
	const mailboxAddress = currentMailbox?.email?.toLowerCase();
	const contactTarget = (() => {
		const m = lastReceivedMessage ?? email;
		if (m.sender && m.sender.toLowerCase() !== mailboxAddress) {
			return { email: m.sender, name: m.sender_name };
		}
		const firstRecipient = splitEmailList(m.recipient)
			.map((r) => parseAddress(r).email)
			.find((r) => r && r !== mailboxAddress);
		return firstRecipient ? { email: firstRecipient, name: null } : null;
	})();

	return (
		<div className="flex flex-col h-full">
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isSending={isSending}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				canArchive={!isDraftFolder && folder !== Folders.ARCHIVE && email.folder_id !== Folders.ARCHIVE}
				onArchive={handleArchive}
				deleteLabel={isDraftFolder || inTrash ? "Delete forever" : "Move to Trash"}
				onViewSource={() => setSourceViewEmail(email)}
				onDelete={handleDelete}
			/>

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
			/>

			{contactTarget && (
				<ContactCard
					key={contactTarget.email}
					mailboxId={mailboxId}
					senderEmail={contactTarget.email}
					senderName={contactTarget.name}
				/>
			)}

			<div ref={scrollRef} className="flex-1 overflow-y-auto">
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (<div key={msg.id} data-latest={idx === allMessages.length - 1 ? "" : undefined}><ThreadMessage
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/></div>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
