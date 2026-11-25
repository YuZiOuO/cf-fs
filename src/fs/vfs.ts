import { DurableObject } from "cloudflare:workers";
import { Permission } from "unix-permissions";
import type {
  DirInode,
  Inode,
  InodeIndex,
  Stat,
  SuperBlock,
  VirtualFileSystem as IVirtualFileSystem,
} from "./interface";
import {
  AlreadyExistsError,
  DirectoryNotEmptyError,
  InternalError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  rethrow,
} from "./errors";

type Dentry = string;

const ROOT_INDEX = 0;

function parsePath(path: Dentry): string[] {
  return path.split("/").filter(Boolean);
}

export class VirtualFileSystem implements IVirtualFileSystem {
  private mounts = new Map<string, SuperBlock>();
  private locks: DurableObjectStub<LockServiceState>;

  constructor(lockService: DurableObjectNamespace<LockServiceState>) {
    this.locks = lockService.get(lockService.idFromName("global"));
  }

  register_filesystem(b: SuperBlock, path: Dentry): void {
    this.mounts.set(path, b);
  }

  unregister_filesystem(b: SuperBlock): void {
    for (const [path, sb] of this.mounts) {
      if (sb === b) this.mounts.delete(path);
    }
  }

  private superBlock(): SuperBlock {
    const sb = this.mounts.values().next().value;
    if (!sb) throw new InternalError("no filesystem mounted");
    return sb;
  }

  private async resolve(path: Dentry): Promise<Inode> {
    const sb = this.superBlock();
    let current = await sb.getInode(ROOT_INDEX);
    for (const name of parsePath(path)) {
      if (current.kind !== "dir") throw new NotDirectoryError(name);
      const index = current.namespaceOperations.lookup(name);
      if (index === null) throw new NotFoundError(path);
      current = await sb.getInode(index);
    }
    return current;
  }

  private async resolveParent(
    path: Dentry,
  ): Promise<{ parent: DirInode; name: string }> {
    const parts = parsePath(path);
    const name = parts.pop();
    if (name === undefined) throw new NotFoundError(path);
    const parent = await this.resolve("/" + parts.join("/"));
    if (parent.kind !== "dir") throw new NotDirectoryError(path);
    return { parent, name };
  }

  private now(): number {
    return Date.now();
  }

  private async lock(index: InodeIndex, owner: string): Promise<void> {
    try {
      while (!(await this.locks.tryLock(index, owner))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (err) {
      rethrow(err);
    }
  }

  private async unlock(index: InodeIndex, owner: string): Promise<void> {
    try {
      await this.locks.unlock(index, owner);
    } catch (err) {
      rethrow(err);
    }
  }

  userOperations = {
    write: async (
      path: Dentry,
      data: ReadableStream<Uint8Array>,
    ): Promise<void> => {
      const sb = this.superBlock();
      const { parent, name } = await this.resolveParent(path);
      const owner = crypto.randomUUID();
      await this.lock(parent.index, owner);
      try {
        const existing = parent.namespaceOperations.lookup(name);
        if (existing !== null) {
          await this.lock(existing, owner);
          try {
            const inode = await sb.getInode(existing);
            if (inode.kind !== "file") throw new IsDirectoryError(path);
            inode.size = await inode.AddressSpaceOperations.put(data);
            inode.modifiedTime = this.now();
            await sb.writeInode(inode);
          } finally {
            await this.unlock(existing, owner);
          }
          return;
        }
        const created = await sb.createInode("file", "rw-r--r--");
        created.size = await created.AddressSpaceOperations.put(data);
        await sb.writeInode(created);
        parent.namespaceOperations.create(name, created.index);
        parent.modifiedTime = this.now();
        await sb.writeInode(parent);
      } finally {
        await this.unlock(parent.index, owner);
      }
    },

    read: async (path: Dentry): Promise<ReadableStream<Uint8Array>> => {
      const inode = await this.resolve(path);
      if (inode.kind !== "file") throw new IsDirectoryError(path);
      return inode.AddressSpaceOperations.read();
    },

    mkdir: async (path: Dentry): Promise<void> => {
      const sb = this.superBlock();
      const { parent, name } = await this.resolveParent(path);
      const owner = crypto.randomUUID();
      await this.lock(parent.index, owner);
      try {
        if (parent.namespaceOperations.lookup(name) !== null) {
          throw new AlreadyExistsError(path);
        }
        const created = await sb.createInode("dir", "rwxr-xr-x");
        parent.namespaceOperations.create(name, created.index);
        parent.modifiedTime = this.now();
        await sb.writeInode(parent);
      } finally {
        await this.unlock(parent.index, owner);
      }
    },

    remove: async (path: Dentry): Promise<void> => {
      const sb = this.superBlock();
      const { parent, name } = await this.resolveParent(path);
      const owner = crypto.randomUUID();
      await this.lock(parent.index, owner);
      try {
        const index = parent.namespaceOperations.lookup(name);
        if (index === null) throw new NotFoundError(path);
        await this.lock(index, owner);
        try {
          const inode = await sb.getInode(index);
          if (inode.kind === "dir" && inode.namespace.size > 0) {
            throw new DirectoryNotEmptyError(path);
          }
          parent.namespaceOperations.delete(name);
          parent.modifiedTime = this.now();
          await sb.writeInode(parent);
        } finally {
          await this.unlock(index, owner);
        }
      } finally {
        await this.unlock(parent.index, owner);
      }
    },

    move: async (from: Dentry, to: Dentry): Promise<void> => {
      if (from === to) return;
      const sb = this.superBlock();
      const src = await this.resolveParent(from);
      const dst = await this.resolveParent(to);

      const srcIndex = src.parent.namespaceOperations.lookup(src.name);
      if (srcIndex !== null) {
        const srcInode = await sb.getInode(srcIndex);
        const normalizedFrom = from.replace(/\/+$/, "");
        if (
          srcInode.kind === "dir" &&
          (to === normalizedFrom || to.startsWith(normalizedFrom + "/"))
        ) {
          throw new IsDirectoryError("cannot move directory into itself");
        }
      }

      const owner = crypto.randomUUID();
      const lockIndexes = [...new Set([src.parent.index, dst.parent.index])].sort(
        (a, b) => a - b,
      );
      for (const idx of lockIndexes) {
        await this.lock(idx, owner);
      }
      try {
        const index = src.parent.namespaceOperations.lookup(src.name);
        if (index === null) throw new NotFoundError(from);

        const existing = dst.parent.namespaceOperations.lookup(dst.name);
        if (existing === index) {
          src.parent.namespaceOperations.delete(src.name);
          src.parent.modifiedTime = this.now();
          await sb.writeInode(src.parent);
          return;
        }
        if (existing !== null) throw new AlreadyExistsError(to);

        dst.parent.namespaceOperations.create(dst.name, index);
        dst.parent.modifiedTime = this.now();
        await sb.writeInode(dst.parent);

        src.parent.namespaceOperations.delete(src.name);
        src.parent.modifiedTime = this.now();
        await sb.writeInode(src.parent);
      } finally {
        for (const idx of lockIndexes.reverse()) {
          await this.unlock(idx, owner);
        }
      }
    },

    list: async (path: Dentry): Promise<Dentry[]> => {
      const inode = await this.resolve(path);
      if (inode.kind !== "dir") throw new NotDirectoryError(path);
      return [...inode.namespace.keys()];
    },

    stat: async (path: Dentry): Promise<Stat> => {
      const inode = await this.resolve(path);
      return {
        kind: inode.kind,
        size: inode.size,
        permission: inode.permission,
        modifiedTime: inode.modifiedTime,
      };
    },

    chmod: async (path: Dentry, mode: Permission): Promise<void> => {
      const sb = this.superBlock();
      const inode = await this.resolve(path);
      const owner = crypto.randomUUID();
      await this.lock(inode.index, owner);
      try {
        inode.permission = mode;
        inode.modifiedTime = this.now();
        await sb.writeInode(inode);
      } finally {
        await this.unlock(inode.index, owner);
      }
    },

    getXAttr: async (path: Dentry, key: string): Promise<string | null> => {
      const inode = await this.resolve(path);
      return inode.inodeOperations.getXAttr(key);
    },

    setXAttr: async (
      path: Dentry,
      key: string,
      value: string,
    ): Promise<void> => {
      const sb = this.superBlock();
      const inode = await this.resolve(path);
      const owner = crypto.randomUUID();
      await this.lock(inode.index, owner);
      try {
        inode.inodeOperations.setXAttr(key, value);
        await sb.writeInode(inode);
      } finally {
        await this.unlock(inode.index, owner);
      }
    },

    listXAttrs: async (path: Dentry): Promise<Record<string, string>> => {
      const inode = await this.resolve(path);
      return Object.fromEntries(inode.inodeOperations.listXAttr());
    },
  };
}

const LOCK_TTL_MS = 120_000;

export class LockServiceState extends DurableObject {
  private locks = new Map<number, { owner: string; expires: number }>();

  tryLock(index: number, owner: string): boolean {
    const existing = this.locks.get(index);
    const now = Date.now();
    if (existing && existing.expires > now && existing.owner !== owner)
      return false;
    this.locks.set(index, { owner, expires: now + LOCK_TTL_MS });
    return true;
  }

  unlock(index: number, owner: string): void {
    const existing = this.locks.get(index);
    if (!existing || existing.owner !== owner) {
      throw new InternalError(`inode ${index} is not locked by ${owner}`);
    }
    this.locks.delete(index);
  }
}
