#!/usr/bin/env node
/*
 * Stream a Hubitat hub's live log (ws://<hub>/logsocket) to the terminal and, optionally, a file.
 *
 *   node tools/hub-logtail.js <hub-ip> [--match "Echo Speaks"] [--out hub.log] [--all]
 *
 * --match  Case-insensitive text matched against the app/device name (default: "Echo Speaks").
 *          Use --all to show every app and device.
 * --out    Also append plain-text lines to this file.
 *
 * Frames look like {name, msg, id, time, type: "app"|"dev", level: "error|warn|info|debug|trace"}.
 * Echo Speaks wraps messages in HTML colour spans; they are stripped so the output reads cleanly.
 * The logsocket is not an officially supported Hubitat API and needs Hub Security off
 * (or a session cookie) to connect.
 *
 * Uses Node's built-in WebSocket (Node 22+); on older Node run `npm install --no-save ws` first.
 */
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const hub = args.find(a => !a.startsWith('--'));
const opt = name => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
if (!hub) {
    console.error('Usage: node tools/hub-logtail.js <hub-ip> [--match "Echo Speaks"] [--out hub.log] [--all]');
    process.exit(2);
}
const showAll = args.includes('--all');
const match = (opt('--match') || 'Echo Speaks').toLowerCase();
const outFile = opt('--out');

let WS = globalThis.WebSocket;
if (!WS) {
    try { WS = require('ws'); } catch (e) {
        console.error('No WebSocket available. Use Node 22+, or run: npm install --no-save ws');
        process.exit(2);
    }
}

const clean = s => String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const write = line => {
    console.log(line);
    if (outFile) fs.appendFileSync(outFile, line + '\n');
};

const url = `ws://${hub}/logsocket`;
let retries = 0;
function connect() {
    const ws = new WS(url);
    const on = (ev, fn) => (ws.addEventListener ? ws.addEventListener(ev, fn) : ws.on(ev, fn));
    on('open', () => { retries = 0; write(`# ${new Date().toISOString()} connected to ${url}${showAll ? '' : ` (showing names containing "${match}")`}`); });
    on('message', ev => {
        const raw = ev && ev.data !== undefined ? ev.data : ev;
        let f;
        try { f = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!showAll && !String(f.name || '').toLowerCase().includes(match)) return;
        write(`${f.time || new Date().toISOString()} ${String(f.level || '').toUpperCase().padEnd(5)} ${f.type || ''} ${f.id || ''} ${clean(f.name)}: ${clean(f.msg)}`);
    });
    on('close', () => {
        const wait = Math.min(30, 2 ** retries++);
        write(`# connection closed; reconnecting in ${wait}s`);
        setTimeout(connect, wait * 1000);
    });
    on('error', err => write(`# websocket error: ${(err && err.message) || err}`));
}
connect();
