// 实现类（公开 API 的运行时入口）
export { VirtualFileSystem, LockServiceState } from "./vfs";
export { R2SuperBlock, R2SuperBlockState } from "./r2-superblock";

import { VirtualFileSystem } from "./vfs";
import { R2SuperBlock } from "./r2-superblock";

export function createFileSystem(env: CloudflareBindings): VirtualFileSystem {
    const vfs = new VirtualFileSystem(env.LockServiceState);
    const state = env.FileSystemState.get(
        env.FileSystemState.idFromName("global"),
    );
    vfs.register_filesystem(new R2SuperBlock(state, env.BUCKET), "/");
    return vfs;
}

// 契约类型（VFS 侧公开 API 的类型标注）
export type {
    InodeIndex,
    Dentry,
    InodeBase,
    FileInode,
    DirInode,
    Inode,
    Stat,
    SuperBlock as ISuperBlock,
    VirtualFileSystem as IVirtualFileSystem,
} from "./interface";

export {
    FsError,
    NotFoundError,
    AlreadyExistsError,
    NotDirectoryError,
    IsDirectoryError,
    DirectoryNotEmptyError,
    InternalError,
} from "./errors";
export type { Permission } from "unix-permissions";
