import { readdir, readFile } from "fs/promises";
import { join } from "path";

const LABS_DIR = "/mnt/data/labs";
const PORT = 8083;

interface LabManifest {
  name: string;
  title: string;
  description: string;
  port: number;
  status: string;
}

async function discoverLabs(): Promise<LabManifest[]> {
  const labs: LabManifest[] = [];

  let entries: string[];
  try {
    entries = await readdir(LABS_DIR);
  } catch (err) {
    console.error(`Failed to read labs directory: ${err}`);
    return labs;
  }

  for (const entry of entries) {
    const manifestPath = join(LABS_DIR, entry, "lab.json");
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const manifest: LabManifest = JSON.parse(raw);
      if (manifest.status === "active") {
        labs.push(manifest);
      }
    } catch {
      // No lab.json or invalid — skip silently
    }
  }

  return labs;
}

function renderIndex(labs: LabManifest[]): string {
  const items =
    labs.length === 0
      ? `<p style="color:#666">No active labs yet. Run <code>new-lab.sh &lt;name&gt;</code> to create one.</p>`
      : labs
          .map(
            (lab) => `
    <div class="lab">
      <a href="/${lab.name}/">${lab.title}</a>
      <p>${lab.description}</p>
    </div>`
          )
          .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>labs.clung.us</title>
  <style>
    body { font-family: monospace; max-width: 720px; margin: 60px auto; padding: 0 20px; background: #0d0d0d; color: #e0e0e0; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; margin-bottom: 2rem; font-size: 0.9rem; }
    .lab { border: 1px solid #222; padding: 14px 18px; margin-bottom: 12px; border-radius: 4px; }
    .lab a { color: #7eb8f7; text-decoration: none; font-size: 1rem; font-weight: bold; }
    .lab a:hover { text-decoration: underline; }
    .lab p { margin: 6px 0 0; color: #999; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>labs.clung.us</h1>
  <p class="subtitle">active experiments — ${labs.length} running</p>
  ${items}
</body>
</html>`;
}

async function proxyRequest(
  req: Request,
  lab: LabManifest,
  subpath: string
): Promise<Response> {
  const targetUrl = `http://127.0.0.1:${lab.port}${subpath || "/"}`;

  const headers = new Headers(req.headers);
  headers.set("X-Forwarded-For", "127.0.0.1");
  headers.set("X-Lab-Name", lab.name);
  headers.set("X-Lab-Base-Path", `/${lab.name}`);

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Root — serve index
    if (pathname === "/" || pathname === "") {
      const labs = await discoverLabs();
      return new Response(renderIndex(labs), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Extract lab name from path: /<name> or /<name>/*
    const parts = pathname.split("/").filter(Boolean);
    const labName = parts[0];
    const subpath = "/" + parts.slice(1).join("/") + (pathname.endsWith("/") && parts.length > 1 ? "/" : "");

    const labs = await discoverLabs();
    const lab = labs.find((l) => l.name === labName);

    if (!lab) {
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d0d0d;color:#e0e0e0">
          <h2>404 — lab not found</h2>
          <p>No active lab named <code>${labName}</code>.</p>
          <p><a href="/" style="color:#7eb8f7">← back to index</a></p>
        </body></html>`,
        {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    try {
      return await proxyRequest(req, lab, (subpath || "/") + url.search);
    } catch (err) {
      console.error(`Proxy error for lab ${labName}: ${err}`);
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d0d0d;color:#e0e0e0">
          <h2>502 — lab unreachable</h2>
          <p>Lab <code>${labName}</code> is registered but not responding on port ${lab.port}.</p>
          <p><a href="/" style="color:#7eb8f7">← back to index</a></p>
        </body></html>`,
        {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }
  },
});

console.log(`labs-router listening on port ${PORT}`);
