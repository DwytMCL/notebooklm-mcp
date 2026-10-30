#!/usr/bin/env node
// NotebookLM MCP server. Drives the real NotebookLM site in a dedicated Chrome profile.
// Tools find elements by accessible role and name (what a screen reader sees), never by CSS,
// so Claude re-reads the page each time and copes with layout changes.
// Usage: `node server.js` (MCP over stdio) or `node server.js login` (one-time Google sign-in).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HOME_URL = 'https://notebooklm.google.com/';
const PROFILE = process.env.NLM_PROFILE || join(homedir(), '.notebooklm-mcp', 'profile');
// First existing of: $NLM_CHROME, an installed Google Chrome, Playwright's own Chromium.
const CHROME = [process.env.NLM_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  chromium.executablePath()].find(p => p && existsSync(p));
if (!CHROME) { console.error('No Chrome found. Install Google Chrome or set NLM_CHROME to a Chrome/Chromium binary.'); process.exit(1); }
const PORT = Number(process.env.NLM_PORT || 9333);
const MAX_TEXT = 40000;
mkdirSync(PROFILE, { recursive: true });

const launch = (extra = []) => spawn(CHROME, [`--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-default-browser-check', ...extra], { stdio: 'ignore', detached: true });

if (process.argv[2] === 'login') {
  // Plain launch with no debugging port: Google refuses sign-in in visibly automated browsers.
  launch([HOME_URL]).unref();
  console.log('Sign in to Google in the window that opened, check NotebookLM loads, then quit that window (Cmd+Q).');
  process.exit(0);
}

let browser, page;
async function getPage() {
  if (page && !page.isClosed()) return page;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch {
    launch([`--remote-debugging-port=${PORT}`, HOME_URL]).unref();
    for (let i = 0; !browser && i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
    }
    if (!browser) throw new Error(`Could not reach Chrome on port ${PORT}. If the sign-in window is still open, quit it (Cmd+Q) and retry.`);
  }
  const ctx = browser.contexts()[0];
  page = ctx.pages().find(p => p.url().includes('notebook')) || ctx.pages()[0] || await ctx.newPage();
  if (!page.url().startsWith('http')) await page.goto(HOME_URL);
  return page;
}

const clip = s => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…[truncated]' : s);
const text = s => ({ content: [{ type: 'text', text: clip(s) }] });

async function snapshot(p) {
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  if (p.url().startsWith('https://accounts.google.com'))
    return `Not signed in (on ${p.url()}). Ask the user to run: node ${process.argv[1]} login`;
  return `URL: ${p.url()}\nTitle: ${await p.title()}\n\n${await p.locator('body').ariaSnapshot()}`;
}

// role+name is preferred; text is a fallback for elements without a useful role.
const target = { role: z.string().optional().describe('ARIA role from the snapshot, e.g. button, link, textbox, tab'),
  name: z.string().optional().describe('Accessible name from the snapshot'),
  text: z.string().optional().describe('Visible text, used when role/name do not match'),
  exact: z.boolean().optional(), nth: z.number().int().optional().describe('Pick the nth match (0-based) when several match') };

function locate(p, { role, name, text: t, exact, nth }) {
  let loc = role ? p.getByRole(role, name ? { name, exact } : {})
    : name ? p.getByLabel(name, { exact }).or(p.getByPlaceholder(name, { exact }))
    : t ? p.getByText(t, { exact }) : null;
  if (!loc) throw new Error('Give role, name or text.');
  return nth === undefined ? loc.first() : loc.nth(nth);
}

const server = new McpServer({ name: 'notebooklm', version: '0.1.0' }, {
  instructions: 'Operate NotebookLM, now called Gemini Notebook (notebook.google.com) like a person would. Call nlm_snapshot first, ' +
    'then act on elements by role and name from it. Snapshot again after each action because the page changes. ' +
    'Answers stream in, so use nlm_wait then nlm_read to get the full reply.' });

const tool = (name, description, schema, fn) => server.registerTool(name, { description, inputSchema: schema },
  async args => { try { return await fn(await getPage(), args); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; } });

tool('nlm_snapshot', 'Accessibility tree of the current NotebookLM page: roles, names and text of every element.', {},
  async p => text(await snapshot(p)));

tool('nlm_open', 'Go to a URL (default: NotebookLM home, which lists notebooks) and return the snapshot.',
  { url: z.string().optional() }, async (p, { url }) => { await p.goto(url || HOME_URL); return text(await snapshot(p)); });

tool('nlm_click', 'Click an element found by role/name (or text). Returns the new snapshot.', target,
  async (p, a) => { await locate(p, a).click({ timeout: 10000 }); await p.waitForTimeout(800); return text(await snapshot(p)); });

tool('nlm_type', 'Fill a text field found by role/name (or label/placeholder), optionally pressing Enter.',
  { ...target, value: z.string(), submit: z.boolean().optional() }, async (p, { value, submit, ...a }) => {
    const loc = locate(p, a);
    await loc.fill(value, { timeout: 10000 });
    if (submit) await loc.press('Enter');
    await p.waitForTimeout(800);
    return text(await snapshot(p));
  });

tool('nlm_press', 'Press a key or chord on the focused element, e.g. Enter, Escape, Tab.', { key: z.string() },
  async (p, { key }) => { await p.keyboard.press(key); await p.waitForTimeout(500); return text(await snapshot(p)); });

tool('nlm_upload', 'Click an element that opens a file picker (e.g. an upload button) and give it local files.',
  { ...target, paths: z.array(z.string()) }, async (p, { paths, ...a }) => {
    const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10000 }), locate(p, a).click()]);
    await chooser.setFiles(paths);
    await p.waitForTimeout(1500);
    return text(await snapshot(p));
  });

tool('nlm_read', 'Visible text of the page (or of one element), e.g. to read a full chat answer.', target,
  async (p, a) => text(a.role || a.name || a.text ? await locate(p, a).innerText() : await p.locator('body').innerText()));

tool('nlm_wait', 'Wait for the page to settle, e.g. while an answer is generating or a source is processing.',
  { seconds: z.number().min(0).max(120), until_text: z.string().optional().describe('Stop early once this text appears') },
  async (p, { seconds, until_text }) => {
    if (until_text) await p.getByText(until_text).first().waitFor({ timeout: seconds * 1000 }).catch(() => {});
    else await p.waitForTimeout(seconds * 1000);
    return text(await snapshot(p));
  });

tool('nlm_screenshot', 'PNG screenshot of the current page, for when the snapshot is not enough.', {},
  async p => ({ content: [{ type: 'image', mimeType: 'image/png', data: (await p.screenshot()).toString('base64') }] }));

await server.connect(new StdioServerTransport());
