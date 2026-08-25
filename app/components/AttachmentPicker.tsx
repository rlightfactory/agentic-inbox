// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import type { ComposeAttachment } from "~/hooks/useComposeForm";
import { formatBytes } from "~/lib/utils";

interface AttachmentListProps {
	attachments: ComposeAttachment[];
	onRemove: (index: number) => void;
	disabled?: boolean;
}

/**
 * Shows the files attached to a compose/reply draft, each with its size
 * and a remove button. The paperclip button that adds files lives in the
 * editor toolbar (see RichTextEditor's `onAttach`).
 */
export default function AttachmentList({
	attachments,
	onRemove,
	disabled,
}: AttachmentListProps) {
	if (attachments.length === 0) return null;

	return (
		<ul className="space-y-1.5">
			{attachments.map((att, index) => (
				<li
					key={`${att.filename}-${index}`}
					className="flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-fill/30 px-2.5 py-1.5 text-sm"
				>
					<PaperclipIcon size={14} className="shrink-0 text-kumo-subtle" />
					<span className="flex-1 truncate text-kumo-default" title={att.filename}>
						{att.filename}
					</span>
					<span className="shrink-0 text-xs text-kumo-subtle">
						{formatBytes(att.size)}
					</span>
					<button
						type="button"
						onClick={() => onRemove(index)}
						disabled={disabled}
						aria-label={`Remove ${att.filename}`}
						className="shrink-0 text-kumo-subtle hover:text-kumo-default disabled:opacity-50"
					>
						<XIcon size={14} />
					</button>
				</li>
			))}
		</ul>
	);
}
