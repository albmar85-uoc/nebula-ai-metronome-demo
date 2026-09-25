import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetCache } from "@/lib/store";

/** Cada test usa su propio ./data temporal. */
export function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-test-"));
  process.env.DATA_DIR = dir;
  _resetCache();
  return dir;
}
