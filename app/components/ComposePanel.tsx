// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Input } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon, PaperPlaneTiltIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import api from "~/services/api";
import { stripHtml } from "~/lib/utils";
import AttachmentPicker from "./AttachmentPicker";
import RichTextEditor from "./RichTextEditor";

export default function ComposePanel() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		attachments,
		addAttachments,
		removeAttachment,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		closeCompose,
		closePanel,
	} = useComposeForm(mailboxId, folder);

	// AI helpers: rewrite the text above the quoted reply / signature.
	type RewriteMode = "polish" | "friendly" | "shorter";
	const [aiBusy, setAiBusy] = useState<RewriteMode | null>(null);
	const [aiError, setAiError] = useState<string | null>(null);
	const [bodyBeforeAi, setBodyBeforeAi] = useState<string | null>(null);
	const hasText = stripHtml(body).length >= 10;

	const runRewrite = async (mode: RewriteMode) => {
		if (!mailboxId || aiBusy) return;
		setAiBusy(mode);
		setAiError(null);
		try {
			const result = await api.rewriteDraft(mailboxId, body, mode);
			if (result.changed) {
				setBodyBeforeAi(body);
				setBody(result.body);
			} else {
				setAiError("The AI had nothing to change.");
			}
		} catch {
			setAiError("AI is unavailable right now. Please try again.");
		} finally {
			setAiBusy(null);
		}
	};

	return (
		<div className="flex flex-col h-full bg-kumo-base">
			<div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
				<h2 className="text-base font-semibold text-kumo-default">
					{formTitle}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={closeCompose}
						disabled={isSending}
						aria-label="Close compose"
					/>
				</div>
			</div>

			<form
				onSubmit={(e) => handleSend(e, closePanel)}
				className="flex flex-col flex-1 min-h-0 overflow-y-auto"
			>
				<div className="p-4 md:p-6 space-y-4">
					{error && <Banner variant="error" text={error} />}

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
								To
							</label>
							<div className="flex-1 flex items-center gap-2 min-w-0">
								<Input
									type="text"
									placeholder="recipient@example.com"
									size="sm"
									value={to}
									onChange={(e) => setTo(e.target.value)}
									required
								/>
								{!showCcBcc && (
									<button
										type="button"
										onClick={() => setShowCcBcc(true)}
										className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium"
									>
										CC / BCC
									</button>
								)}
							</div>
						</div>

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
									CC
								</label>
								<div className="flex-1">
									<Input
										type="text"
										size="sm"
										value={cc}
										onChange={(e) => setCc(e.target.value)}
										placeholder="Separate multiple addresses with commas"
									/>
								</div>
							</div>
						)}

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
									BCC
								</label>
								<div className="flex-1">
									<Input
										type="text"
										size="sm"
										value={bcc}
										onChange={(e) => setBcc(e.target.value)}
										placeholder="Separate multiple addresses with commas"
									/>
								</div>
							</div>
						)}

						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
								Subject
							</label>
							<div className="flex-1">
								<Input
									type="text"
									placeholder="Email subject"
									size="sm"
									value={subject}
									onChange={(e) => setSubject(e.target.value)}
									required
								/>
							</div>
						</div>
					</div>

					<div className="border border-kumo-line rounded-md overflow-hidden bg-kumo-base">
						<RichTextEditor
							value={body}
							onChange={setBody}
							onAttach={addAttachments}
						/>
					</div>

					<div className="flex flex-wrap items-center gap-1.5">
						<span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-kumo-subtle">
							<SparkleIcon size={14} weight="fill" className="text-kumo-link" />
							AI
						</span>
						{(
							[
								{ mode: "polish", label: "Polish" },
								{ mode: "friendly", label: "Friendlier" },
								{ mode: "shorter", label: "Shorter" },
							] as const
						).map((pill) => (
							<Button
								key={pill.mode}
								type="button"
								variant="secondary"
								size="sm"
								loading={aiBusy === pill.mode}
								disabled={!hasText || aiBusy !== null || isSending}
								onClick={() => runRewrite(pill.mode)}
							>
								{pill.label}
							</Button>
						))}
						{bodyBeforeAi !== null && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={() => {
									setBody(bodyBeforeAi);
									setBodyBeforeAi(null);
								}}
							>
								Undo
							</Button>
						)}
						{aiError && <span className="text-xs text-kumo-destructive">{aiError}</span>}
					</div>

					<AttachmentPicker
						attachments={attachments}
						onRemove={removeAttachment}
						disabled={isSending}
					/>
				</div>

				{/* Footer actions */}
				<div className="mt-auto px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 shrink-0 md:px-6">
					<div className="flex items-center justify-between">
						<Button type="button" variant="ghost" size="sm" onClick={closeCompose} disabled={isSending}>
							Discard
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
}
