import { Dithering } from "@paper-design/shaders-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

type PreviewRow =
	| {
			id: string;
			kind: "prompt";
			text: string;
	  }
	| {
			id: string;
			kind: "assistant";
			text: string;
			streaming: boolean;
	  }
	| {
			id: string;
			kind: "tool";
			name: string;
			detail: string;
			result?: string;
			status: "calling" | "completed";
	  };

type ScriptAction =
	| {
			kind: "prompt";
			text: string;
	  }
	| {
			kind: "assistant";
			text: string;
	  }
	| {
			kind: "tool";
			name: string;
			detail: string;
			result: string;
	  };

const scenarios: readonly (readonly ScriptAction[])[] = [
	[
		{ kind: "prompt", text: "Make session recovery deterministic." },
		{
			kind: "assistant",
			text: "I’ll inspect the journal boundary first, then tighten the recovery path.",
		},
		{
			kind: "tool",
			name: "read_file",
			detail: "src/session-store.ts",
			result: "214 lines read",
		},
		{
			kind: "assistant",
			text: "The projection is already pure. I’m moving retry ownership to the store boundary.",
		},
		{
			kind: "tool",
			name: "apply_patch",
			detail: "src/session-store.ts",
			result: "+18  −7",
		},
		{
			kind: "assistant",
			text: "Recovery now replays from durable facts and rejects stale heads.",
		},
	],
	[
		{ kind: "prompt", text: "Run the focused tests." },
		{
			kind: "assistant",
			text: "I’ll verify projection, branching, and retry behavior together.",
		},
		{
			kind: "tool",
			name: "run_tests",
			detail: "session-store.test.ts",
			result: "18 passed  ·  0 failed",
		},
		{
			kind: "assistant",
			text: "All focused tests pass. The inherited branch prefix remains immutable.",
		},
	],
	[
		{ kind: "prompt", text: "Review the final diff." },
		{
			kind: "assistant",
			text: "The change stays inside the recovery boundary; provider and tool semantics are untouched.",
		},
		{
			kind: "tool",
			name: "git_diff",
			detail: "--stat",
			result: "2 files changed  ·  +31  −12",
		},
		{
			kind: "assistant",
			text: "The result is smaller, durable, and restart-safe.",
		},
	],
];

const initialStreamingRowId = "initial-active-assistant";
const initialAssistantText =
	"The projection is already pure. I’m moving retry ownership";
const initialAssistantRemainder = " to the store boundary.";

const initialRows: readonly PreviewRow[] = [
	{
		id: "initial-branch-result",
		kind: "assistant",
		text: "The parent remains independent, and the branch keeps its frozen inherited prefix.",
		streaming: false,
	},
	{
		id: "initial-branch-prompt",
		kind: "prompt",
		text: "Check branch replay after restart.",
	},
	{
		id: "initial-branch-opening",
		kind: "assistant",
		text: "I’ll reconstruct the inherited prefix and compare it with the projected head.",
		streaming: false,
	},
	{
		id: "initial-branch-read",
		kind: "tool",
		name: "read_facts",
		detail: "session:branch-42",
		result: "prefix 31  ·  suffix 6",
		status: "completed",
	},
	{
		id: "initial-tests",
		kind: "tool",
		name: "run_tests",
		detail: "session-store.test.ts",
		result: "18 passed  ·  0 failed",
		status: "completed",
	},
	{
		id: "initial-tests-result",
		kind: "assistant",
		text: "All focused tests pass. The inherited branch prefix remains immutable.",
		streaming: false,
	},
	{
		id: "initial-review-prompt",
		kind: "prompt",
		text: "Review the final diff.",
	},
	{
		id: "initial-review-opening",
		kind: "assistant",
		text: "I’ll inspect the changed boundary and verify that no provider semantics moved.",
		streaming: false,
	},
	{
		id: "initial-review-read",
		kind: "tool",
		name: "read_file",
		detail: "src/session-projector.ts",
		result: "186 lines read",
		status: "completed",
	},
	{
		id: "initial-review",
		kind: "assistant",
		text: "The change stays inside the recovery boundary; provider and tool semantics are untouched.",
		streaming: false,
	},
	{
		id: "initial-diff",
		kind: "tool",
		name: "git_diff",
		detail: "--stat",
		result: "2 files changed  ·  +31  −12",
		status: "completed",
	},
	{
		id: "initial-review-result",
		kind: "assistant",
		text: "The result is smaller, durable, and restart-safe.",
		streaming: false,
	},
	{
		id: "initial-recovery-prompt",
		kind: "prompt",
		text: "Make session recovery deterministic.",
	},
	{
		id: "initial-recovery-opening",
		kind: "assistant",
		text: "I’ll inspect the journal boundary first, then tighten the recovery path.",
		streaming: false,
	},
	{
		id: "initial-read",
		kind: "tool",
		name: "read_file",
		detail: "src/session-store.ts",
		result: "214 lines read",
		status: "completed",
	},
	{
		id: initialStreamingRowId,
		kind: "assistant",
		text: initialAssistantText,
		streaming: true,
	},
];

const settledRows: readonly PreviewRow[] = initialRows.map((row) =>
	row.id === initialStreamingRowId && row.kind === "assistant"
		? {
				...row,
				text: `${initialAssistantText}${initialAssistantRemainder}`,
				streaming: false,
			}
		: row,
);

const visibleRowLimit = initialRows.length;
const previewSpeed = 0.82;

function streamDelay(character: string) {
	if (character === ".") return 105;
	if (character === "," || character === ";") return 65;
	if (character === " ") return 18;
	return 24;
}

function usePreviewRows(reducedMotion: boolean | null) {
	const [rows, setRows] = useState<readonly PreviewRow[]>(initialRows);

	useEffect(() => {
		if (reducedMotion) {
			setRows(settledRows);
			return;
		}

		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		let nextRowNumber = 0;
		setRows(initialRows);

		function wait(duration: number) {
			return new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.round(duration * previewSpeed));
			});
		}

		function appendRow(row: PreviewRow) {
			setRows((currentRows) => [...currentRows, row].slice(-visibleRowLimit));
		}

		function updateRow(id: string, update: (row: PreviewRow) => PreviewRow) {
			setRows((currentRows) =>
				currentRows.map((row) => (row.id === id ? update(row) : row)),
			);
		}

		function nextId(kind: PreviewRow["kind"]) {
			const id = `${kind}-${nextRowNumber}`;
			nextRowNumber += 1;
			return id;
		}

		async function streamIntoAssistant(
			id: string,
			initialText: string,
			remainingText: string,
		) {
			let streamedText = initialText;
			for (const character of remainingText) {
				if (cancelled) return;
				streamedText += character;
				const nextText = streamedText;
				updateRow(id, (row) =>
					row.kind === "assistant" ? { ...row, text: nextText } : row,
				);
				await wait(streamDelay(character));
			}

			updateRow(id, (row) =>
				row.kind === "assistant" ? { ...row, streaming: false } : row,
			);
			await wait(360);
		}

		async function streamAssistant(text: string) {
			const id = nextId("assistant");
			appendRow({ id, kind: "assistant", text: "", streaming: true });
			await streamIntoAssistant(id, "", text);
		}

		async function runTool(action: Extract<ScriptAction, { kind: "tool" }>) {
			const id = nextId("tool");
			appendRow({
				id,
				kind: "tool",
				name: action.name,
				detail: action.detail,
				status: "calling",
			});
			await wait(900);
			if (cancelled) return;
			updateRow(id, (row) =>
				row.kind === "tool"
					? {
							...row,
							result: action.result,
							status: "completed",
						}
					: row,
			);
			await wait(620);
		}

		async function run() {
			await wait(1050);
			await streamIntoAssistant(
				initialStreamingRowId,
				initialAssistantText,
				initialAssistantRemainder,
			);
			await runTool({
				kind: "tool",
				name: "apply_patch",
				detail: "src/session-store.ts",
				result: "+18  −7",
			});
			await streamAssistant(
				"Recovery now replays from durable facts and rejects stale heads.",
			);
			await wait(1050);

			let firstPass = true;

			while (!cancelled) {
				const nextScenarios = firstPass ? scenarios.slice(1) : scenarios;
				firstPass = false;

				for (const scenario of nextScenarios) {
					for (const action of scenario) {
						if (cancelled) return;

						if (action.kind === "prompt") {
							appendRow({
								id: nextId("prompt"),
								kind: "prompt",
								text: action.text,
							});
							await wait(520);
						} else if (action.kind === "assistant") {
							await streamAssistant(action.text);
						} else {
							await runTool(action);
						}
					}

					await wait(1050);
				}
			}
		}

		void run();

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [reducedMotion]);

	return rows;
}

function PromptRow({ row }: { row: Extract<PreviewRow, { kind: "prompt" }> }) {
	return (
		<div className="flex items-start gap-2.5 text-[clamp(0.64rem,1.15vw,0.78rem)] leading-[1.45] text-[var(--contrast-ink-soft)]">
			<span className="mt-[0.58em] size-1.5 shrink-0 rounded-full bg-[var(--contrast-ink-soft)]" />
			<span>{row.text}</span>
		</div>
	);
}

function AssistantRow({
	row,
}: {
	row: Extract<PreviewRow, { kind: "assistant" }>;
}) {
	return (
		<p className="m-0 text-[clamp(0.72rem,1.38vw,0.96rem)] leading-[1.45] tracking-[-0.015em] text-[var(--contrast-ink)]">
			{row.text}
			{row.streaming ? (
				<motion.span
					className="ml-[0.14em] inline-block h-[1em] w-[0.08em] translate-y-[0.12em] bg-[var(--contrast-ink)]"
					animate={{ opacity: [1, 1, 0, 0] }}
					transition={{ duration: 0.8, repeat: Number.POSITIVE_INFINITY }}
				/>
			) : null}
		</p>
	);
}

function ToolRow({ row }: { row: Extract<PreviewRow, { kind: "tool" }> }) {
	const completed = row.status === "completed";

	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[clamp(0.58rem,1.04vw,0.72rem)]">
			<motion.span
				className={`size-1.5 shrink-0 rounded-full ${completed ? "bg-[var(--contrast-ink)]" : "bg-[var(--contrast-ink-soft)]"}`}
				animate={completed ? { opacity: 1 } : { opacity: [0.35, 1, 0.35] }}
				transition={{ duration: 0.9, repeat: Number.POSITIVE_INFINITY }}
			/>
			<span className="font-semibold text-[var(--contrast-ink)]">
				{row.name}
			</span>
			<span className="min-w-0 truncate text-[var(--contrast-ink-soft)]">
				{row.detail}
			</span>
			<span className="ml-auto shrink-0 text-[var(--contrast-ink-soft)]">
				{completed ? row.result : "calling…"}
			</span>
		</div>
	);
}

function StreamRow({ row }: { row: PreviewRow }) {
	return (
		<motion.div
			layout="position"
			initial={{ opacity: 0, y: 10, filter: "blur(3px)" }}
			animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
			exit={{ opacity: 0, y: -8 }}
			transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
		>
			{row.kind === "prompt" ? <PromptRow row={row} /> : null}
			{row.kind === "assistant" ? <AssistantRow row={row} /> : null}
			{row.kind === "tool" ? <ToolRow row={row} /> : null}
		</motion.div>
	);
}

export default function StreamingTurnPreview() {
	const reducedMotion = useReducedMotion();
	const rows = usePreviewRows(reducedMotion);

	return (
		<section className="relative mt-6 aspect-[8/5] w-full overflow-hidden sm:mt-7">
			<div
				className="pointer-events-none absolute inset-y-0 left-0 flex w-[72%] items-center px-7 py-4 sm:px-14 sm:py-6 md:px-20"
				aria-hidden="true"
			>
				<div className="h-full w-full rounded-[1.4rem] bg-[var(--contrast-surface)]" />
			</div>

			<div className="absolute top-1/2 left-[68%] z-10 aspect-square h-[62%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full mix-blend-difference">
				<Dithering
					className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
					width="132%"
					height="132%"
					colorBack="#00000000"
					colorFront="#ffffff"
					shape="sphere"
					type="random"
					size={11}
					speed={reducedMotion ? 0 : 0.68}
					aria-hidden="true"
				/>
			</div>

			<motion.div
				className="absolute inset-y-0 left-0 z-20 flex w-[72%] items-center px-7 py-4 sm:px-14 sm:py-6 md:px-20"
				initial={
					reducedMotion ? false : { opacity: 0, y: 12, filter: "blur(5px)" }
				}
				animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
				transition={{
					duration: reducedMotion ? 0 : 0.8,
					ease: [0.22, 1, 0.36, 1],
				}}
			>
				<div className="flex h-full w-full flex-col justify-end gap-1.5 overflow-hidden px-5 py-4 sm:px-6 sm:py-5">
					<AnimatePresence initial={false} mode="popLayout">
						{rows.map((row) => (
							<StreamRow key={row.id} row={row} />
						))}
					</AnimatePresence>
				</div>
			</motion.div>

			<p className="sr-only">
				Animated demonstration of a coding-agent response streaming text,
				invoking tools, receiving results, and continuing its answer.
			</p>
		</section>
	);
}
