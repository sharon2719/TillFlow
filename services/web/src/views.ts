const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

export function hidden(name: string, value: unknown): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - TillFlow</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  form { margin: 1rem 0; padding: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  label { display: block; margin: .5rem 0 .25rem; font-size: .9rem; }
  input, select { width: 100%; padding: .4rem; box-sizing: border-box; }
  button { margin-top: .75rem; padding: .5rem 1rem; cursor: pointer; }
  .err { color: #b00020; }
  .ok { color: #0a7a0a; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin: 1rem 0; background: #fafafa; }
  .muted { color: #666; font-size: .85rem; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
</body>
</html>`;
}
