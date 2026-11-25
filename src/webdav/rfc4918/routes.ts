import { join } from "node:path/posix";
import type { PropfindRequest, LockDepth, LockToken } from "./types";
import type { Locks } from "./locks";
import type { ByteRange, Path } from "../core/types";
import type { Env } from "../types";
import { NotFoundError } from "../../fs";
import { Hono } from "hono";
import rangeParser from "range-parser";
import { ifHeaderMatches, parseIfHeader } from "./http";
import { propertyKey, propertyXattrPrefix } from "./properties";
import { decodePath, toHref } from "../../path";
import { isValidXml } from "../core/xml";
import {
  quotaLiveProperties,
  quotaProtectedPropertyNames,
} from "../rfc4331/quota";
import {
  multistatus,
  parseLockInfo,
  parsePropfind,
  parseProppatch,
  lockResponse,
} from "./xml";
import type { Resource } from "../core/resource";

const XML = { "Content-Type": "application/xml; charset=utf-8" };
const ALLOW =
  "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK";
const DAV = "1, 2, extended-mkcol";

const isLockedWithoutToken = async (
  locks: Locks,
  path: Path,
  ifHeader: string | undefined,
) => {
  const active = await locks.getLocks(path);
  if (!active.length) return false;
  if (!ifHeader) return true;
  const header = parseIfHeader(ifHeader);
  const submitted = header.flatMap((list) =>
    list.conditions.flatMap((condition) =>
      condition.kind === "state-token" ? [condition.token] : [],
    ),
  );
  return !submitted.some((token) =>
    active.some((lock) => lock.token === token),
  );
};

const copyResource = async (
  source: Resource,
  destination: Resource,
  recursive: boolean,
) => {
  const info = await source.stat();
  if (!info) throw new NotFoundError(source.path);
  if (info.kind === "collection") {
    const names = await source.fs.list(source.path);
    await destination.createCollection();
    if (recursive)
      for (const name of names)
        await copyResource(
          source.resolve(join(source.path, name)),
          destination.resolve(join(destination.path, name)),
          recursive,
        );
  } else {
    await destination.writeFile(await source.readFile());
  }
  for (const [name, value] of Object.entries(
    await source.fs.listXAttrs(source.path),
  ))
    if (name.startsWith(propertyXattrPrefix) && value)
      await destination.fs.setXAttr(destination.path, name, value);
};

export const rfc4918 = new Hono<Env>();

rfc4918.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV }));

rfc4918.on("PROPFIND", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depth === "infinity")
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      XML,
    );
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);
  const body = c.req.raw.body ? await c.req.text() : "";
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);
  const request: PropfindRequest = body
    ? parsePropfind(body)
    : { kind: "allprop" };
  const info = await resource.stat();
  if (!info) return c.text("Resource not found", 404);
  const requestedPropertyKeys =
    request.kind === "prop"
      ? new Set(request.names.map(propertyKey))
      : undefined;
  const includeQuota =
    request.kind !== "allprop" &&
    (requestedPropertyKeys === undefined ||
      quotaProtectedPropertyNames.some((name) =>
        requestedPropertyKeys.has(propertyKey(name)),
      ));
  const resources = [{ resource, info }];
  if (depth === "1" && info.kind === "collection") {
    for await (const child of resource.children()) {
      resources.push(child);
    }
  }
  const propfindItems = resources.map(
    ({ resource: itemResource, info: itemInfo }) => ({
      resource: itemResource,
      info: itemInfo,
      extraLive: quotaLiveProperties(itemInfo, includeQuota),
    }),
  );
  const propstats = await c
    .get("dav")
    .properties.propfind(propfindItems, request);
  const responses = propfindItems.map((item, index) => ({
    href: toHref(item.resource.path, item.info.kind === "collection"),
    propstats: propstats[index],
  }));
  return c.body(multistatus(responses), 207, XML);
});

rfc4918.on("PROPPATCH", "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const body = await c.req.text();
  if (!isValidXml(body)) return c.text("Invalid XML", 400);
  const info = await resource.stat();
  if (!info) return c.text("Not Found", 404);
  if (await isLockedWithoutToken(c.get("dav").locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  let propstats;
  try {
    propstats = await c
      .get("dav")
      .properties.proppatch(resource, parseProppatch(body));
  } catch (error) {
    if (error instanceof NotFoundError) return c.text("Not Found", 404);
    throw error;
  }
  const responseHref = toHref(path, info.kind === "collection");
  return c.body(multistatus([{ href: responseHref, propstats }]), 207, XML);
});

rfc4918.on(["GET", "HEAD"], "*", async (c) => {
  const path = c.get("path");
  const resource = c.get("dav").resource(path);
  const info = await resource.stat();
  if (!info) return c.text("Not Found", 404);
  if (info.kind !== "file") return c.text("Resource is a directory", 405);
  const rangeHeader = c.req.header("range");
  let range: ByteRange | undefined;
  if (rangeHeader) {
    const ranges = rangeParser(info.contentLength, rangeHeader);
    if (
      ranges === -1 ||
      ranges === -2 ||
      ranges.type.toLowerCase() !== "bytes" ||
      ranges.length !== 1
    )
      return c.body(null, 416);
    const [parsed] = ranges;
    range = { start: parsed.start, end: parsed.end };
  }
  const etag = await resource.etag();
  const status = range ? 206 : 200;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control":
      status === 200 ? "public, max-age=60, must-revalidate" : "no-store",
    ETag: etag,
    "Last-Modified": info.lastModified.toUTCString(),
    "Content-Length": String(
      range ? range.end - range.start + 1 : info.contentLength,
    ),
  });
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${info.contentLength}`,
    );
  const content = await resource.readFile(range).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (content === null) return c.text("Not Found", 404);
  return c.req.method === "HEAD"
    ? c.body(null, { status, headers })
    : c.body(content, { status, headers });
});

rfc4918.put("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Collection", 405, { Allow: ALLOW });
  const resource = c.get("dav").resource(path);
  const existing = await resource.stat();
  if (existing?.kind === "collection")
    return c.text("Collection exists", 405, { Allow: ALLOW });
  const parent = resource.parent();
  const parentInfo = parent ? await parent.stat() : undefined;
  if (!parentInfo) return c.text("Parent directory not found", 409);
  const dav = c.get("dav");
  const ifHeader = c.req.header("if");
  const locks = await dav.locks.getLocks(path);
  if (ifHeader) {
    const header = parseIfHeader(ifHeader);
    const submitted = header.flatMap((list) =>
      list.conditions.flatMap((condition) =>
        condition.kind === "state-token" ? [condition.token] : [],
      ),
    );
    if (
      locks.length &&
      !submitted.some((token) => locks.some((lock) => lock.token === token))
    )
      return c.text("Resource is locked", 423);
    if (
      !(await ifHeaderMatches(header, path, async (target) => {
        const targetResource = dav.resource(target);
        const targetInfo = await targetResource.stat();
        const targetLocks = await dav.locks.getLocks(target);
        return {
          etag: targetInfo ? await targetResource.etag() : undefined,
          lockTokens: new Set(targetLocks.map((lock) => lock.token)),
        };
      }))
    )
      return c.body(null, 412);
  } else if (locks.length) return c.text("Resource is locked", 423);
  const etag = await resource.writeFile(
    c.req.raw.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
  );
  return c.body(null, existing ? 204 : 201, {
    ETag: etag,
    ...(existing ? {} : { Location: c.req.url }),
  });
});

rfc4918.delete("*", async (c) => {
  const path = c.get("path");
  if (path === "/") return c.text("Cannot delete root collection", 403);
  const dav = c.get("dav");
  if (await isLockedWithoutToken(dav.locks, path, c.req.header("if")))
    return c.text("Resource is locked", 423);
  try {
    await dav.resource(path).delete();
  } catch (error) {
    if (error instanceof NotFoundError) return c.text("Not Found", 404);
    throw error;
  }
  return c.body(null, 204);
});

rfc4918.on(["COPY", "MOVE"], "*", async (c) => {
  const dav = c.get("dav");
  const source = dav.resource(c.get("path"));
  const destinationHeader = c.req.header("destination");
  if (!destinationHeader) return c.text("Invalid Destination header", 400);
  let destination: Path;
  try {
    const url = new URL(destinationHeader, c.req.url);
    if (url.origin !== new URL(c.req.url).origin)
      return c.text("Cross-origin destinations are not supported", 502);
    destination = decodePath(url.pathname);
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (destination === "/") return c.text("Invalid destination", 403);
  const sourceInfo = await source.stat();
  if (!sourceInfo) return c.text("Not Found", 404);
  const isMove = c.req.method === "MOVE";
  if (
    isMove &&
    (await isLockedWithoutToken(dav.locks, source.path, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (
    sourceInfo.kind === "collection" &&
    depth !== "infinity" &&
    (isMove || depth !== "0")
  )
    return c.text("Invalid Depth header", 400);
  const overwriteHeader = (c.req.header("overwrite") ?? "T").toUpperCase();
  if (overwriteHeader !== "T" && overwriteHeader !== "F")
    return c.text("Invalid Overwrite header", 400);
  const overwrite = overwriteHeader === "T";
  const destinationResource = dav.resource(destination);
  const existing = await destinationResource.stat();
  if (existing && !overwrite) return c.text("Destination exists", 412);
  if (
    existing &&
    (await isLockedWithoutToken(dav.locks, destination, c.req.header("if")))
  )
    return c.text("Resource is locked", 423);
  if (destination === source.path || destination.startsWith(source.path + "/"))
    return c.text("Cannot copy/move a resource into itself", 403);
  if (existing) await destinationResource.delete();
  try {
    if (isMove) await source.moveTo(destinationResource);
    else
      await copyResource(
        source,
        destinationResource,
        sourceInfo.kind === "collection" && depth !== "0",
      );
  } catch (error) {
    if (error instanceof NotFoundError)
      return c.text("Parent directory not found", 409);
    throw error;
  }
  return c.body(
    null,
    existing ? 204 : 201,
    existing ? undefined : { Location: destinationHeader },
  );
});

rfc4918.on("LOCK", "*", async (c) => {
  const path = c.get("path");
  const dav = c.get("dav");
  const resource = dav.resource(path);
  const timeoutHeader =
    c.req.header("timeout")?.split(",")[0].trim() ?? "Infinite";
  let seconds: number | undefined;
  if (timeoutHeader !== "Infinite") {
    const match = /^Second-(\d+)$/.exec(timeoutHeader);
    if (!match) return c.text("Invalid Timeout header", 400);
    seconds = Number(match[1]);
  }
  const depthHeader = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depthHeader !== "0" && depthHeader !== "infinity")
    return c.text("Invalid Depth header", 400);
  const depth: LockDepth = depthHeader;
  const token = c.req.header("if")?.match(/<([^>]+)>/)?.[1];
  const body = c.req.raw.body ? await c.req.text() : "";
  if (!body && !token) return c.text("Lock body is required", 400);
  if (body && !isValidXml(body)) return c.text("Invalid XML", 400);
  const existing = await resource.stat();
  if (!token && !existing) {
    const parent = resource.parent();
    const parentInfo = parent ? await parent.stat() : undefined;
    if (parentInfo?.kind !== "collection")
      return c.text("Parent directory not found", 409);
  }
  let lock;
  try {
    lock = token
      ? await dav.locks.refresh(path, token as LockToken, seconds)
      : await (async () => {
          const info = parseLockInfo(body);
          return dav.locks.lock(path, {
            scope: info.scope,
            depth,
            ...(seconds === undefined ? {} : { timeout: seconds }),
            ...(info.owner ? { owner: info.owner } : {}),
          });
        })();
  } catch (error) {
    if (error instanceof NotFoundError) return c.text("Not Found", 404);
    throw error;
  }
  if (!lock)
    return c.text(
      token ? "Lock token does not match" : "Resource is locked",
      token ? 412 : 423,
    );
  if (!existing && !token) {
    await resource.writeFile(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    );
  }
  return c.body(lockResponse(lock), existing ? 200 : 201, {
    "Content-Type": "application/xml; charset=utf-8",
    ...(token ? {} : { "Lock-Token": `<${lock.token}>` }),
    Timeout:
      lock.timeout === undefined || lock.timeout === "infinite"
        ? "Infinite"
        : `Second-${lock.timeout}`,
  });
});

rfc4918.on("UNLOCK", "*", async (c) => {
  const token = c.req
    .header("lock-token")
    ?.match(/^<([^>]+)>$/)?.[1]
    ?.trim();
  if (!token) return c.text("Lock token does not match", 400);
  try {
    await c.get("dav").locks.unlock(c.get("path"), token as LockToken);
  } catch (error) {
    if (error instanceof NotFoundError) return c.text("Not Found", 404);
    throw error;
  }
  return c.body(null, 204);
});
