import { createFileRoute } from "@tanstack/react-router";
import AnimatedHeroText from "../components/AnimatedHeroText";
import GitHubInvite from "../components/GitHubInvite";
import Principles from "../components/Principles";
import StreamingTurnPreview from "../components/StreamingTurnPreview";

export const Route = createFileRoute("/")({
	component: HomePage,
});

function HomePage() {
	return (
		<main className="mx-auto w-[min(960px,calc(100%-2rem))] pt-12 pb-24 sm:pt-14 sm:pb-32">
			<header className="mx-auto flex max-w-4xl flex-col items-center text-center">
				<AnimatedHeroText />
			</header>

			<StreamingTurnPreview />
			<Principles />
			<GitHubInvite />
		</main>
	);
}
