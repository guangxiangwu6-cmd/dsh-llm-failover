#!/usr/bin/env node
/**
 * Copy this plugin into a harness overlay directory (the `app-patches` layout),
 * backing up every file it replaces.
 *
 *   node tools/sync-to-dsh.mjs --dest <overlay-directory> [--stamp <label>] [--dry-run]
 *
 * Why a script instead of a hand copy: the overlay is a *deployment* of this
 * repo, and a deployment that silently overwrites its predecessor's copy is a
 * deployment nobody can roll back. Every replaced file lands in the overlay's
 * `_backups/` first, named after its path and the label.
 *
 * The destination has no default on purpose: this repository is generic, the
 * overlay path is local to one machine. Pass it explicitly, or set
 * DSH_FAILOVER_DEST. The harness must be restarted afterwards — nothing is
 * hot-reloaded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/** Files that make up the deployed plugin. `.workbuddy/` and `tools/` stay local. */
const FILES = [
    "package.json",
    "README.md",
    "INSTALL.md",
    "LICENSE",
    "lib/index.js",
    "test/smoke.test.mjs",
    "docs/architecture.md",
    "docs/troubleshooting.md",
    "docs/session-compatibility.md"
];

function parseArgs(argv) {
    const out = { dest: process.env.DSH_FAILOVER_DEST, stamp: undefined, dryRun: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--dest") out.dest = argv[++i];
        else if (arg === "--stamp") out.stamp = argv[++i];
        else if (arg === "--dry-run") out.dryRun = true;
        else if (arg === "--help" || arg === "-h") out.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return out;
}

function usage() {
    console.log("usage: node tools/sync-to-dsh.mjs --dest <overlay-directory> [--stamp <label>] [--dry-run]");
}

function defaultStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(String(error.message ?? error));
        usage();
        process.exit(2);
    }
    if (args.help) {
        usage();
        return 0;
    }
    if (!args.dest) {
        console.error("no destination given (--dest <overlay-directory> or DSH_FAILOVER_DEST)");
        usage();
        return 2;
    }
    const dest = path.resolve(args.dest);
    if (dest === root) {
        console.error("destination equals this repository; nothing to sync");
        return 2;
    }
    const stamp = args.stamp ?? `sync-${defaultStamp()}`;
    const backupDir = path.join(dest, "_backups");
    console.log(`source: ${root}`);
    console.log(`dest:   ${dest}`);
    console.log(`stamp:  ${stamp}${args.dryRun ? "  (dry run)" : ""}`);
    console.log("");

    let copied = 0;
    let backedUp = 0;
    for (const rel of FILES) {
        const from = path.join(root, ...rel.split("/"));
        const to = path.join(dest, ...rel.split("/"));
        if (!fs.existsSync(from)) {
            console.error(`MISSING in source: ${rel} — skipped`);
            continue;
        }
        if (fs.existsSync(to)) {
            const flat = rel.split("/").join("-");
            const backup = path.join(backupDir, `${flat}.before-${stamp}`);
            if (!args.dryRun) {
                fs.mkdirSync(backupDir, { recursive: true });
                fs.copyFileSync(to, backup);
            }
            backedUp += 1;
            console.log(`backed up  ${rel}  ->  _backups/${path.basename(backup)}`);
        }
        if (!args.dryRun) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
        }
        copied += 1;
        console.log(`copied     ${rel}`);
    }
    console.log("");
    console.log(`${args.dryRun ? "would copy" : "copied"} ${copied} file(s), ${args.dryRun ? "would back up" : "backed up"} ${backedUp}`);
    console.log("Restart the harness for the change to take effect (nothing is hot-reloaded).");
    return 0;
}

process.exit(main());
