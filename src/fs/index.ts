// 实现类（公开 API 的运行时入口）
export { VirtualFileSystem } from "./vfs";
export { SuperBlock } from "./superblock";
export { FileSystemState } from "./durable-object";

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
