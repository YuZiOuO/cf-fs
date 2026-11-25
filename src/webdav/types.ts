import type { Locks } from "./rfc4918/locks";
import type { Properties } from "./rfc4918/properties";
import type { ResourceFactory } from "./core/resource";
import type { Path } from "./core/types";

export interface Context {
  resource: ResourceFactory;
  locks: Locks;
  properties: Properties;
}

export interface Env {
  Bindings: CloudflareBindings;
  Variables: {
    path: Path;
    dav: Context;
  };
}
