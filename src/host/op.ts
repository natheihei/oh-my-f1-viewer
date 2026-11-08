/**
 * A host function that declares itself: a typed function that also carries its description and
 * argument schema, so consumers call it directly and the agent's tools can be generated from it.
 */
import Type, { type Static, type TObject } from 'typebox';

export interface OpInfo {
  kind: 'read' | 'write';
  description: string;
  args: TObject;
}

export type Op<A, R> = ((args: A) => R) & { info: OpInfo };

const NO_ARGS = Type.Object({}, { additionalProperties: false });

function make(kind: OpInfo['kind'], meta: { description: string; args?: TObject }, fn: (args: never) => unknown) {
  return Object.assign(fn, { info: { kind, description: meta.description, args: meta.args ?? NO_ARGS } });
}

/** Changes something. */
export function write<S extends TObject, R>(meta: { description: string; args: S }, fn: (args: Static<S>) => R): Op<Static<S>, R>;
export function write<R>(meta: { description: string }, fn: () => R): Op<void, R>;
export function write(meta: { description: string; args?: TObject }, fn: (args: never) => unknown): unknown {
  return make('write', meta, fn);
}

/** Asks for something that isn't part of the live state. */
export function query<S extends TObject, R>(meta: { description: string; args: S }, fn: (args: Static<S>) => R): Op<Static<S>, R>;
export function query<R>(meta: { description: string }, fn: () => R): Op<void, R>;
export function query(meta: { description: string; args?: TObject }, fn: (args: never) => unknown): unknown {
  return make('read', meta, fn);
}
