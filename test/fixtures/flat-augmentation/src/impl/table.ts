// Internal module (not an entry point) with a module augmentation.
// Regression surface from issue #1: the generated .d.ts for the entry imports
// this module by relative path, and the augmentation must survive publishing.
export interface Table {
  rows: number;
}

export function table(rows: number): Table {
  return {rows};
}

declare module "node:events" {
  interface EventEmitter {
    tableCount?: number;
  }
}
