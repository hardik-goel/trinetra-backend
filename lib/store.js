/* Tiny JSON store for records the user accrues over time — signal history,
   paper trades, IPO applications. Same runtime-file pattern as the fundamentals
   cache, kept in data/ so one directory holds everything worth a Render disk.

   Writes go through a temp file and rename, because these are records the user
   cannot reconstruct: a process dying mid-write must not leave a truncated file
   where their trade log used to be. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { markDirty } from "./remoteStore.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

export function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback; // absent or unreadable — a fresh start, never a crash
  }
}

export function save(file, data) {
  ensureDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
    // Local write already succeeded; the remote copy is a durability layer and
    // never a precondition, so this is fire-and-forget by design.
    markDirty(file);
    return true;
  } catch (e) {
    console.warn(`[store] could not write ${file}: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/* Ids are time-ordered and readable, so a record can be traced back to when it
   was created without opening the file. Math.random is not used — a counter
   keeps them unique within a process without a dependency. */
let seq = 0;
export const newId = prefix =>
  `${prefix}_${Date.now().toString(36)}${(seq++).toString(36).padStart(2, "0")}`;

export const DATA_PATH = DATA_DIR;
