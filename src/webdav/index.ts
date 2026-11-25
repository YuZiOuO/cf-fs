import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { createFileSystem } from "../fs";
import { Locks } from "./rfc4918/locks";
import { Properties } from "./rfc4918/properties";
import { decodePath } from "../path";
import { quotaProtectedPropertyNames } from "./rfc4331/quota";
import { Resource } from "./core/resource";
import type { Path } from "./core/types";
import type { Env } from "./types";
import { rfc4918 } from "./rfc4918/routes";
import { rfc5689 } from "./rfc5689/routes";

const app = new Hono<Env>();

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return c.text("Internal Server Error", 500);
});

app.use("*", async (c, next) => {
  try {
    const path = decodePath(new URL(c.req.url).pathname);
    const filesystem = createFileSystem(c.env).userOperations;
    c.set("path", path);
    c.set("dav", {
      resource: (target: Path) => new Resource(target, filesystem),
      locks: new Locks(filesystem),
      properties: new Properties(filesystem, quotaProtectedPropertyNames),
    });
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.use(methodNotAllowed({ app }));

app.route("/", rfc4918);
app.route("/", rfc5689);

export default app;
