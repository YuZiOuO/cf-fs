import { dirname, join } from "node:path/posix";
import { NotFoundError } from "../../fs";
import type { Stat } from "../../fs";
import type {
  ByteRange,
  EntityTag,
  Path,
  ResourceInfo,
  UserOperations,
} from "./types";

export const toResourceInfo = (stat: Stat): ResourceInfo =>
  stat.kind === "file"
    ? {
        kind: "file",
        lastModified: new Date(stat.modifiedTime),
        contentLength: stat.size,
      }
    : {
        kind: "collection",
        lastModified: new Date(stat.modifiedTime),
      };

export type ResourceFactory = (path: Path) => Resource;

const slice = (
  body: ReadableStream<Uint8Array>,
  start: number,
  length: number,
) => {
  const end = start + length;
  let position = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const chunkEnd = position + chunk.length;
        const from = Math.max(start - position, 0);
        const to = Math.min(chunkEnd, end) - position;
        if (to > from) controller.enqueue(chunk.subarray(from, to));
        position = chunkEnd;
        if (position >= end) controller.terminate();
      },
    }),
  );
};

/** A path-bound WebDAV resource. */
export class Resource {
  constructor(
    readonly path: Path,
    readonly fs: UserOperations,
  ) {}

  resolve(path: Path) {
    return new Resource(path, this.fs);
  }

  parent(): Resource | undefined {
    if (this.path === "/") return undefined;
    return this.resolve(dirname(this.path) || "/");
  }

  async stat(): Promise<ResourceInfo | undefined> {
    try {
      return toResourceInfo(await this.fs.stat(this.path));
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  async etag(): Promise<EntityTag> {
    const stat = await this.fs.stat(this.path);
    return `"${stat.size}-${stat.modifiedTime}"` as EntityTag;
  }

  async readFile(range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const body = await this.fs.read(this.path);
    return range ? slice(body, range.start, range.end - range.start + 1) : body;
  }

  async *children(): AsyncIterable<{
    resource: Resource;
    info: ResourceInfo;
  }> {
    const children = await Promise.all(
      (await this.fs.list(this.path)).map(async (name) => {
        const path = join(this.path, name);
        return {
          resource: this.resolve(path),
          info: toResourceInfo(await this.fs.stat(path)),
        };
      }),
    );
    yield* children;
  }

  async writeFile(
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<EntityTag> {
    await this.fs.write(
      this.path,
      body instanceof Uint8Array ? new Response(body).body! : body,
    );
    return this.etag();
  }

  async createCollection(): Promise<EntityTag> {
    await this.fs.mkdir(this.path);
    return this.etag();
  }

  async delete(): Promise<void> {
    const info = await this.stat();
    if (info?.kind === "collection") {
      for (const name of await this.fs.list(this.path))
        await this.resolve(join(this.path, name)).delete();
    }
    await this.fs.remove(this.path);
  }

  async moveTo(destination: Resource): Promise<void> {
    await this.fs.move(this.path, destination.path);
  }
}
