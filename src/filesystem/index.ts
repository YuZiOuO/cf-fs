import { ObjectStoreFileSystem } from "./fs";
import { R2ObjectStore } from "../object_store";

export const createR2FileSystem = (env: CloudflareBindings) =>
  new ObjectStoreFileSystem(
    new R2ObjectStore(env.BUCKET),
    env.FileSystemState.getByName("root"),
  );
