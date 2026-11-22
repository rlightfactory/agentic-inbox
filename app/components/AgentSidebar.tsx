// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useUIStore } from "~/hooks/useUIStore";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

export default function AgentSidebar() {
	const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");
	const { closeAgentPanel } = useUIStore();

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar: segmented control */}
			<div className="flex items-center gap-2 border-b border-kumo-line px-3 py-2.5 shrink-0">
				<div className="flex flex-1 items-center gap-1 rounded-lg bg-kumo-fill p-1" role="tablist" aria-label="Assistant panels">
					{(
						[
							{ id: "agent", label: "Agent", icon: RobotIcon },
							{ id: "mcp", label: "MCP", icon: PlugsIcon },
						] as const
					).map((tab) => {
						const active = activeTab === tab.id;
						const Icon = tab.icon;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => setActiveTab(tab.id)}
								className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border-0 px-3 py-1.5 text-sm font-medium transition-all cursor-pointer ${
									active
										? "bg-kumo-base text-kumo-default shadow-sm"
										: "bg-transparent text-kumo-subtle hover:text-kumo-default"
								}`}
							>
								<Icon size={14} weight={active ? "fill" : "regular"} />
								{tab.label}
							</button>
						);
					})}
				</div>
				{/* Close -- mobile overlay only */}
				<button
					type="button"
					onClick={closeAgentPanel}
					className="p-1.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors cursor-pointer bg-transparent border-0 lg:hidden"
					aria-label="Close agent panel"
				>
					<XIcon size={16} />
				</button>
			</div>

			{/* Tab content — keep agent mounted so chat isn't lost */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div className={activeTab === "agent" ? "h-full" : "hidden"}>
					<LazyAgentPanel />
				</div>
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
