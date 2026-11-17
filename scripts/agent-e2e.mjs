#!/usr/bin/env node
// Browser check of the agent path (needs Google Chrome and GEMINI_API_KEY in the environment; makes no Gemini call):
// a talk without voice, Claude adding questions, starting the dive and writing to any question through MCP, the
// page showing it with the Claude badge, and the Gemini-voice mute.
//   node scripts/agent-e2e.mjs <screenshot-dir>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'why-e2e-shots-'));
const home = mkdtempSync(join(tmpdir(), 'why-e2e-home-'));
const env = { ...process.env, WHY_WHY_HOME: home, WHY_WHY_BROWSER: 'none' };
let fails = 0;
const ok = (name, cond, detail = '') => { if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const talk = spawn('node', ['dist/cli.js', '--no-open', '--out', mkdtempSync(join(tmpdir(), 'why-e2e-out-'))], { env });
let talkExit = null;
talk.on('exit', (c) => (talkExit = c));
const url = await new Promise((resolve, reject) => {
  talk.stderr.on('data', (d) => { const m = /open (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('the talk did not start')), 20000);
});

const mcp = new Client({ name: 'claude-code', version: 'e2e' });
await mcp.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli.js', 'mcp'], env }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); return { error: !!r.isError, body: JSON.parse(r.content[0].text) }; };

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })).newPage();
// Count the gain nodes the Gemini player makes, so the mute can be read off its gain.
await page.addInitScript(() => { const g = AudioContext.prototype.createGain; window.__gains = []; AudioContext.prototype.createGain = function () { const n = g.call(this); window.__gains.push(n); return n; }; });
await page.goto(url);
await page.waitForSelector('#status');
await page.waitForTimeout(800);

ok('list_talks finds the talk', (await call('list_talks')).body.data.length === 1);
await call('add_question', { text: 'なぜホストはフロアごとなのか' });
await call('add_question', { text: '退室した人の席をいつ消すか' });
await page.waitForTimeout(1200);
ok('the page moves to the question list with Claude badges', (await page.evaluate(() => document.body.dataset.phase)) === 'questions' && (await page.locator('#q-list .by-agent').count()) === 2);
await call('start_dive');
await page.waitForTimeout(1200);
ok('Claude starts the dive without voice', (await page.evaluate(() => document.body.dataset.phase)) === 'deep_dive' && /声なしで深掘りを始めました/.test(await page.textContent('#status')), await page.textContent('#status'));
await call('add_whys', { parent_id: 'q1', items: [{ text: 'フロアが部屋（Durable Object）の単位だから', viewpoint: '仕組み・道具' }] });
await call('add_fact', { node_id: 'q1', summary: '会議で「部屋の単位だから」と説明があった', supports: true });
await page.waitForTimeout(1200);
ok('Claude\'s why and fact show with the badge', /フロアが部屋（Durable Object）の単位だから/.test(await page.textContent('body')) && (await page.locator('.by-agent').count()) >= 3);
await page.screenshot({ path: join(out, 'agent-board.png') });
const r = await call('add_fact', { node_id: 'q2', summary: '移動するまで記録が残る', supports: true });
ok('Claude writes to a question that is not being dug', !r.error, JSON.stringify(r.body).slice(0, 120));
ok('no token in replies', !JSON.stringify((await call('get_talk')).body).match(/[0-9a-f]{64}/));

// The Gemini-voice mute (Gemini is not connected here; the player's gain is what the button controls).
await page.click('#voice-mute');
ok('the voice mute sets the player gain to 0', await page.evaluate(() => window.__gains.some((n) => n.gain.value === 0)) && /戻す/.test(await page.textContent('#voice-mute')));
await page.click('#voice-mute');
ok('and back to 1', await page.evaluate(() => window.__gains.every((n) => n.gain.value === 1)));

await browser.close();
await mcp.close();
talk.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
ok('the talk leaves no registry entry behind', (await import('node:fs')).readdirSync(join(home, 'talks')).length === 0);
console.log(fails ? `${fails} failed` : 'all ok', talkExit);
process.exit(fails ? 1 : 0);
