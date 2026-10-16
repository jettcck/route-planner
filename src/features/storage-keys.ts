type TripIdentity = {
  destination: string;
  days: { date: string }[];
};

/**
 * Encode the user-controlled destination before composing a local-storage key.
 * The historical `destination|firstDate` format allowed a destination that
 * contained `|` to collide with another trip's namespace.
 */
export function tripNamespace(trip: TripIdentity) {
  const first = trip.days[0]?.date ?? "undated";
  const destination = trip.destination || "未命名";
  return `v2:${encodeURIComponent(destination)}|${first}`;
}

/** The pre-v2 format is retained solely for one-time local-data migration. */
export function legacyTripNamespace(trip: TripIdentity) {
  const first = trip.days[0]?.date ?? "undated";
  return `${trip.destination || "未命名"}|${first}`;
}

/**
 * Convert a versioned trip-scoped storage key to its historical counterpart.
 * Returns null for global keys or malformed/unrelated values.
 */
export function legacyStorageKey(key: string): string | null {
  const match = /^(route-(?:ledger|checkin|prep|packing)):v2:([^|]+)\|([^|]+)$/.exec(key);
  if (!match) return null;
  try {
    const destination = decodeURIComponent(match[2]);
    if (!destination || destination.includes("\n") || destination.includes("\r")) return null;
    return `${match[1]}:${destination}|${match[3]}`;
  } catch {
    return null;
  }
}
