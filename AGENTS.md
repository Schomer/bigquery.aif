<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:model-requirement -->
# REQUIRED: Always use gemini-3.5-flash

**This project uses `gemini-3.5-flash` everywhere. Do NOT change this — ever.**

The model string in `src/app/api/chat/route.ts` must always be:
```ts
model: google('gemini-3.5-flash')
```

The model string in `scripts/test-loop.mjs` must always be:
```
gemini-3.5-flash:generateContent
```

Do NOT change to pro-preview, flash-lite, 2.5-pro, or any other model variant.
If `gemini-3.5-flash` returns an error, fix the error — do not change the model.

Verify with: `grep -rn "gemini-" src/ scripts/` — all results must show `gemini-3.5-flash`.
<!-- END:model-requirement -->

<!-- BEGIN:no-emojis -->
# REQUIRED: No emojis. Ever.

Do NOT use emojis anywhere — not in code, comments, UI text, log messages, commit messages, responses, plans, documentation, or any other output. This rule has zero exceptions.
<!-- END:no-emojis -->

<!-- BEGIN:auto-build -->
# REQUIRED: Automatically build on file changes

This project uses server-side rendering (no static export). To validate that edits compile correctly, always run the build command after making changes to the source files before ending your turn:
1. `npm run build`
<!-- END:auto-build -->

