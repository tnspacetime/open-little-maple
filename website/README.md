# Little Maple website

The Little Maple site is a TanStack Start application in `src/`. It uses Tailwind CSS and targets Cloudflare Workers.

```bash
bun install --frozen-lockfile
bun run dev
```

To make a production build:

```bash
bun run build
```

To deploy from this directory, sign in to Cloudflare and run:

```bash
bunx wrangler login
bun run deploy
```

The deploy script builds the site and publishes the Worker named `open-little-maple` from `wrangler.jsonc`. Set `VITE_SITE_URL` to the site's public origin before building if you want absolute canonical and social image URLs. The generated output stays local and is ignored by Git.
