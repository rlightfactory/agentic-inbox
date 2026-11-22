// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
}: EmailPanelHeaderProps) {
	return (
		<div className="px-4 py-4 border-b border-kumo-line shrink-0 md:px-6">
			<h2 className="text-lg font-semibold leading-snug tracking-tight text-kumo-default">
				{subject}
			</h2>
			{showThreadCount && (
				<span className="mt-1.5 inline-flex items-center rounded-full bg-kumo-fill px-2 py-0.5 text-xs font-medium text-kumo-subtle">
					{messageCount} messages
				</span>
			)}
		</div>
	);
}
