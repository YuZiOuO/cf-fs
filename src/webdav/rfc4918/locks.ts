import { dirname } from "node:path/posix";
import { HTTPException } from "hono/http-exception";
import { NotFoundError } from "../../fs";
import { parseProperty, serializeProperty } from "../core/xml";
import type { Path, UserOperations } from "../core/types";
import type {
  Lock,
  LockDepth,
  LockRequest,
  LockScope,
  LockToken,
} from "./types";

const LOCK_XATTR = "user.webdav.lock";

interface StoredLock {
  token: LockToken;
  scope: LockScope;
  depth: LockDepth;
  expiresAt: number | null;
  owner?: string;
}

const isActive = (lock: StoredLock) =>
  lock.expiresAt === null || lock.expiresAt > Date.now();

const toLock = (lock: StoredLock): Lock => ({
  token: lock.token,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.expiresAt === null
    ? {}
    : {
        timeout: Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000)),
      }),
  ...(lock.owner ? { owner: parseProperty(lock.owner).element } : {}),
});

const ancestors = (path: Path): Path[] => {
  const chain: Path[] = [];
  for (let current = path; ; current = dirname(current) || "/") {
    chain.push(current);
    if (current === "/") return chain;
  }
};

export class Locks {
  constructor(private readonly fs: UserOperations) {}

  private async read(path: Path): Promise<StoredLock[]> {
    const value = await this.fs.getXAttr(path, LOCK_XATTR).catch((error) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    return value ? (JSON.parse(value) as StoredLock[]) : [];
  }

  async getLocks(path: Path): Promise<Lock[]> {
    const chain = await Promise.all(
      ancestors(path).map(async (ancestor) => ({
        ancestor,
        locks: (await this.read(ancestor)).filter(isActive),
      })),
    );
    return chain.flatMap(({ ancestor, locks }) =>
      locks
        .filter((lock) => ancestor === path || lock.depth === "infinity")
        .map(toLock),
    );
  }

  async lock(path: Path, request: LockRequest): Promise<Lock | null> {
    const existing = await this.getLocks(path);
    const conflicts =
      existing.some((lock) => lock.scope === "exclusive") ||
      (request.scope === "exclusive" && existing.length > 0);
    if (conflicts) return null;
    const created: StoredLock = {
      token: `urn:uuid:${crypto.randomUUID()}` as LockToken,
      scope: request.scope,
      depth: request.depth,
      expiresAt:
        request.timeout === undefined || request.timeout === "infinite"
          ? null
          : Date.now() + request.timeout * 1000,
      ...(request.owner
        ? { owner: serializeProperty({ element: request.owner }) }
        : {}),
    };
    const own = (await this.read(path)).filter(isActive);
    await this.fs.setXAttr(path, LOCK_XATTR, JSON.stringify([...own, created]));
    return toLock(created);
  }

  async refresh(
    path: Path,
    token: LockToken,
    timeout?: Lock["timeout"],
  ): Promise<Lock | null> {
    for (const ancestor of ancestors(path)) {
      const locks = await this.read(ancestor);
      const index = locks.findIndex((lock) => lock.token === token);
      if (index < 0) continue;
      const lock = locks[index];
      if (ancestor !== path && lock.depth !== "infinity") continue;
      const updated: StoredLock = {
        ...lock,
        expiresAt:
          timeout === undefined || timeout === "infinite"
            ? null
            : Date.now() + timeout * 1000,
      };
      locks[index] = updated;
      await this.fs.setXAttr(ancestor, LOCK_XATTR, JSON.stringify(locks));
      return toLock(updated);
    }
    return null;
  }

  async unlock(path: Path, token: LockToken): Promise<void> {
    const locks = await this.read(path);
    if (!locks.some((lock) => lock.token === token))
      throw new HTTPException(400, { message: "Lock token does not match" });
    const remaining = locks.filter((lock) => lock.token !== token);
    await this.fs.setXAttr(
      path,
      LOCK_XATTR,
      remaining.length ? JSON.stringify(remaining) : "",
    );
  }
}
