// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import type { ComposeAttachment } from "~/hooks/useComposeForm";
import { formatBytes } from "~/lib/utils";

interface AttachmentPickerProps {
	attachments: ComposeAttachment[];
	onAdd: (files: FileList | File[]) => void;
	onRemove: (index: number) => void;
	disabled?: boolean;
}

/**
 * File-attachment control shared by the compose modal and reply panel.
 * Lets the user pick local files (encoded to base64 by the compose hook)
 * and shows the selected files with a remove button.
 */
export default function AttachmentPicker({
	attachments,
	onAdd,
	onRemove,
	disabled,
}: AttachmentPickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			onAdd(e.target.files);
		}
		// Reset so selecting the same file again still fires onChange
		e.target.value = "";
	};

	return (
		<div className="space-y-2">
			<input
				ref={inputRef}
				type="file"
				multiple
				className="hidden"
				onChange={handleChange}
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				icon={<PaperclipIcon size={14} />}
				onClick={() => inputRef.current?.click()}
				disabled={disabled}
			>
				Attach files
			</Button>

			{attachments.length > 0 && (
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
			)}
		</div>
	);
}
