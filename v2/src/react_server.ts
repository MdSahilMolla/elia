import { serve } from "bun";
import { join } from "path";

const port = 3000;
const staticDir = join(process.cwd(), "workspace/react_site");

serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (pathname === "/") pathname = "/index.html";
    const filePath = join(staticDir, pathname);
    try {
      const file = await Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      const headers = new Headers();
      if (filePath.endsWith('.html')) headers.set('Content-Type', 'text/html');
      else if (filePath.endsWith('.css')) headers.set('Content-Type', 'text/css');
      else if (filePath.endsWith('.js')) headers.set('Content-Type', 'application/javascript');
      else if (filePath.endsWith('.svg')) headers.set('Content-Type', 'image/svg+xml');
      return new Response(file, { headers });
    } catch (e) {
      return new Response("Error", { status: 500 });
    }
  },
});

console.log(`React site server listening on http://localhost:${port}`);
