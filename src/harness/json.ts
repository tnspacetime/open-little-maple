/** JSON validation, cloning, and freezing shared by every layer. */

// ---------------------------------------------------------------------------
// Small shared vocabulary
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = {
  [key: string]: JsonValue;
};

export type Cleanup = () => void | Promise<void>;

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function assertNonempty(value: string, label: string): void {
  if (!value.trim()) throw new Error(label + " cannot be empty");
}

/** Deep-freeze a detached array/plain-object value. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as JsonObject;
}

/** Validate and clone one value admitted to durable JSON data. */
export function jsonValue(value: unknown, label: string): JsonValue {
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, path: string): JsonValue => {
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      return candidate;
    }

    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`${path} must contain only finite numbers`);
      }
      return candidate;
    }

    if (typeof candidate !== "object") {
      throw new Error(`${path} must be JSON-serializable`);
    }

    if (ancestors.has(candidate)) {
      throw new Error(`${path} must not contain cycles`);
    }

    ancestors.add(candidate);

    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item, index) =>
          visit(item, `${path}[${index}]`),
        );
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} must contain only plain JSON objects`);
      }

      const result: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(candidate)) {
        result[key] = visit(item, `${path}.${key}`);
      }
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value, label);
}

/** Compare JSON semantically; object property insertion order is irrelevant. */
export function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]!))
    );
  }

  const leftObject = left as { readonly [key: string]: JsonValue };
  const rightObject = right as { readonly [key: string]: JsonValue };
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        sameJsonValue(leftObject[key]!, rightObject[key]!),
    )
  );
}

export function stringField(value: JsonObject, key: string): string {
  const field = value[key];

  if (typeof field !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return field;
}

export function numberField(value: JsonObject, key: string): number {
  const field = value[key];

  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`${key} must be a finite number`);
  }

  return field;
}

export function nonnegativeIntegerField(
  value: JsonObject,
  key: string,
): number {
  const field = numberField(value, key);
  if (!Number.isInteger(field) || field < 0) {
    throw new Error(`${key} must be a nonnegative integer`);
  }
  return field;
}

export function objectsField(value: JsonObject, key: string): JsonObject[] {
  const field = value[key];

  if (!Array.isArray(field)) {
    throw new Error(`${key} must be an array`);
  }

  return field.map((item, index) => object(item, `${key}[${index}]`));
}

export function stringsField(value: JsonObject, key: string): string[] {
  const field = value[key];

  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }

  return [...field] as string[];
}
