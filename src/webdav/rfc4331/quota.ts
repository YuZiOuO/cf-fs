import type { ResourceInfo } from "../core/types";
import type { LiveProperty } from "../rfc4918/properties";
import type { PropertyName } from "../rfc4918/types";
import { DAV_NAMESPACE, createDavProperty } from "../core/xml";

export const quotaProtectedPropertyNames: readonly PropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "quota-available-bytes" },
  { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
];

export const quotaLiveProperties = (
  info: ResourceInfo,
  include: boolean,
): readonly LiveProperty[] => {
  if (!include || info.kind !== "collection") return [];
  return [
    {
      name: {
        namespaceURI: DAV_NAMESPACE,
        localName: "quota-available-bytes",
      },
      property: {
        element: createDavProperty(
          "quota-available-bytes",
          String(Number.MAX_SAFE_INTEGER),
        ),
      },
    },
    {
      name: { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
      property: { element: createDavProperty("quota-used-bytes", "0") },
    },
  ];
};
