// A stand-in for the engine's early-access types (`/plugin-types` writes the
// real ones to .claude/types), just enough for `tsc` to check this mod's own
// code across its files: `$`, hook events and Client surfaces are left loose,
// everything the mod declares itself is checked for real. run-checks.sh uses
// this only when .claude/types is absent (CI, a fresh clone).
declare module 'claude-code' {
  type Hook = (...args: any[]) => any
  export interface Register {
    (on: { (event: string, hook: Hook): void; (event: string, match: object, hook: Hook): void }): void
  }
  export interface ClientSurface<S = unknown> {
    state: S | undefined
    setState(state: S): void
    onPointer(listener: (event: any) => void): void
    [member: string]: any
  }
  export type ClientElements = any
  export type RenderNode = any
}

declare function h(...args: any[]): any
declare const Fragment: any
declare namespace JSX {
  type Element = any
  interface IntrinsicElements {
    [tag: string]: any
  }
}
