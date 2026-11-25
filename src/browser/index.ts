import { dirname, join } from "node:path/posix";
import { Hono } from "hono";
import { html } from "hono/html";
import { createFileSystem, NotFoundError } from "../fs";
import { decodePath, toHref } from "../path";

const browser = new Hono<{ Bindings: CloudflareBindings }>();

const NAME_WIDTH = 50;
const SIZE_WIDTH = 20;

browser.get("*", async (c, next) => {
  let path: string;
  try {
    path = decodePath(new URL(c.req.url).pathname);
  } catch {
    return c.text("Invalid path", 400);
  }

  const fs = createFileSystem(c.env);
  let stat;
  try {
    stat = await fs.userOperations.stat(path);
  } catch (err) {
    if (err instanceof NotFoundError) return next();
    throw err;
  }
  if (stat.kind !== "dir") return next();

  const names = (await fs.userOperations.list(path)).sort();
  const children = await Promise.all(
    names.map(async (name) => {
      const childPath = join(path, name);
      const stat = await fs.userOperations.stat(childPath);
      return {
        name,
        path: childPath,
        directory: stat.kind === "dir",
        size: stat.size,
        modifiedTime: stat.modifiedTime,
      };
    }),
  );

  const title = toHref(path, true);
  const parent = path === "/" ? undefined : dirname(path);
  const rows = [
    ...(parent ? [html`<a href="${toHref(parent, true)}">../</a>${"\n"}`] : []),
    ...children.map((entry) => {
      const name = `${entry.name}${entry.directory ? "/" : ""}`;
      const shown =
        name.length > NAME_WIDTH ? `${name.slice(0, NAME_WIDTH - 3)}..>` : name;
      const time = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: "UTC",
        })
          .formatToParts(entry.modifiedTime)
          .map(({ type, value }) => [type, value]),
      );
      const href = toHref(entry.path, entry.directory);
      const date = `${time.day}-${time.month}-${time.year} ${time.hour}:${time.minute}`;
      const size = (entry.directory ? "-" : String(entry.size)).padStart(
        SIZE_WIDTH,
      );
      const pad = " ".repeat(NAME_WIDTH + 1 - shown.length);
      return html`<a href="${href}">${shown}</a>${pad}${date}${size}${"\n"}`;
    }),
  ];

  return c.html(html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Index of ${title}</title>
      </head>
      <body>
        <h1>Index of ${title}</h1>
        <hr />
        <pre>${rows}</pre>
        <hr />
        <center>cf-fs</center>
      </body>
    </html>
  `);
});

export default browser;
