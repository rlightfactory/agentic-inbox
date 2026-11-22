// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import { SHORTCUT_HELP } from "~/hooks/useShortcuts";

export default function ShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-3">
					Keyboard shortcuts
				</Dialog.Title>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm mb-5">
					{SHORTCUT_HELP.map((s) => (
						<div key={s.keys} className="contents">
							<dt className="text-kumo-default"><kbd className="kbd">{s.keys}</kbd></dt>
							<dd className="text-kumo-strong">{s.description}</dd>
						</div>
					))}
				</dl>
				<div className="flex justify-end">
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="secondary" size="sm">
								Close
							</Button>
						)}
					/>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
