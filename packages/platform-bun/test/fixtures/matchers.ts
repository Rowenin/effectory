import { expect } from "bun:test";

// Bun types asymmetric matchers as `any`; these keep them opaque inside expectations.
export const anyObject: unknown = expect.any(Object);
export const arrayContaining = (values: readonly unknown[]): unknown =>
  expect.arrayContaining(values);
export const objectContaining = (value: object): unknown =>
  expect.objectContaining(value);
