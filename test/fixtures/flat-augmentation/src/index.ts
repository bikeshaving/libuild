export {table} from "./impl/table.js";
export type {Table} from "./impl/table.js";

export default function createTable(rows: number) {
  return {rows};
}
