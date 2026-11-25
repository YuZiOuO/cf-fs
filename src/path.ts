import { normalize } from "node:path/posix";

export const decodePath = (pathname: string): string => {
  const decodedPath = decodeURIComponent(pathname);
  if (decodedPath.includes("\0") || decodedPath.split("/").includes(".."))
    throw new Error("Invalid path");
  return normalize(`/${decodedPath}`).replace(/\/+$/, "") || "/";
};

export const toHref = (path: string, directory = false) =>
  path === "/"
    ? "/"
    : `/${path
        .slice(1)
        .split("/")
        .map(encodeURIComponent)
        .join("/")}${directory ? "/" : ""}`;
