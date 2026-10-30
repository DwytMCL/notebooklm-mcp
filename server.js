#!/usr/bin/env node
// NotebookLM MCP server. Drives the real NotebookLM site in a dedicated Chrome profile.
// Tools find elements by accessible role and name (what a screen reader sees), never by CSS,
// so Claude re-reads the page each time and copes with layout changes.
// Usage: `node server.js` (MCP over stdio) or `node server.js login` (one-time Google sign-in).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HOME_URL = 'https://notebooklm.google.com/';
const PROFILE = process.env.NLM_PROFILE || join(homedir(), '.notebooklm-mcp', 'profile');
const DOWNLOADS = process.env.NLM_DOWNLOADS || join(homedir(), 'Downloads', 'NotebookLM');

// Every Chromium that Playwright has downloaded, newest revision first.
function playwrightChromes() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')];
  const bins = ['chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];
  return roots.filter(r => r && existsSync(r)).flatMap(r => readdirSync(r)
    .filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1])
    .flatMap(d => bins.map(b => join(r, d, b))));
}

// First existing of: $NLM_CHROME, an installed Google Chrome or Chromium, a Playwright-downloaded Chromium.
const CHROME = [process.env.NLM_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ...playwrightChromes()].find(p => p && existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Install Google Chrome, run `npx playwright install chromium`, or set NLM_CHROME.');
  process.exit(1);
}
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
    return `Not signed in (on ${p.url()}). Ask the user to run: npx notebooklm-browser-mcp login`;
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

const server = new McpServer({ name: 'notebooklm', version: '0.2.0' }, {
  instructions: 'Operate NotebookLM, now called Gemini Notebook (notebook.google.com) like a person would. Call nlm_snapshot first, ' +
    'then act on elements by role and name from it. Snapshot again after each action because the page changes. ' +
    'Answers stream in, so use nlm_wait then nlm_read to get the full reply. ' +
    'For common jobs try the shortcuts first (nlm_list_notebooks, nlm_create_notebook, nlm_ask, nlm_add_source); ' +
    'if one fails because the site changed, fall back to the general tools.' });

const tool = (name, description, schema, fn) => server.registerTool(name, { description, inputSchema: schema },
  async args => { try { return await fn(await getPage(), args); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; } });

tool('nlm_snapshot', 'Accessibility tree of the current NotebookLM page: roles, names and text of every element.', {},
  async p => text(await snapshot(p)));

tool('nlm_open', 'Go to a URL (default: NotebookLM home, which lists notebooks) and return the snapshot.',
  { url: z.string().optional() }, async (p, { url }) => { await p.goto(url || HOME_URL); return text(await snapshot(p)); });

tool('nlm_click', 'Click an element found by role/name (or text). Returns the new snapshot.', target,
  async (p, a) => { await activate(locate(p, a)); await p.waitForTimeout(800); return text(await snapshot(p)); });

// Click like a mouse; if another element covers the target (common for styled radio buttons and
// checkboxes), operate it from the keyboard instead, as a screen-reader user would.
async function activate(loc) {
  try {
    await loc.click({ timeout: 5000 });
  } catch (e) {
    if (!/intercepts pointer events|Timeout/i.test(e.message)) throw e;
    const role = await loc.getAttribute('role') || await loc.evaluate(el => el.type || el.tagName.toLowerCase());
    await loc.focus({ timeout: 5000 });
    await loc.press(/radio|checkbox|switch/.test(role) ? 'Space' : 'Enter');
  }
}

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

tool('nlm_download', 'Click an element that downloads a file (e.g. a Download button or menu item) and save the file. ' +
  `Saved to ${DOWNLOADS} unless save_dir is given. Returns the saved path.`,
  { ...target, save_dir: z.string().optional() }, async (p, { save_dir, ...a }) => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), locate(p, a).click()]);
    const dir = save_dir || DOWNLOADS;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, dl.suggestedFilename());
    await dl.saveAs(file);
    return text(`Saved ${file}`);
  });

// Shortcuts for common jobs. They match elements by loose role/name patterns, so small wording
// changes still work; when they fail the general tools above still can.

const NOTEBOOK_LINK = 'a[href*="/notebook/"]';

async function notebookLinks(p) {
  if (new URL(p.url()).pathname !== '/') await p.goto(HOME_URL);
  await p.locator(NOTEBOOK_LINK).first().waitFor({ timeout: 20000 });
  return p.locator(NOTEBOOK_LINK).evaluateAll(as => as.map(a => ({ title: a.innerText.replace(/\s+/g, ' ').trim(), url: a.href })));
}

// Close welcome/what's-new popups that block the page.
async function dismissPopups(p) {
  for (let i = 0; i < 3; i++) {
    const dialog = p.getByRole('dialog').last();
    if (!await dialog.isVisible().catch(() => false)) return;
    const close = dialog.getByRole('button', { name: /^(close|dismiss|got it|no thanks|ok|skip)/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click(); else await p.keyboard.press('Escape');
    await p.waitForTimeout(500);
  }
}

// notebook: a notebook URL, its id, or (part of) its title.
async function openNotebook(p, notebook) {
  if (/^https?:/.test(notebook)) await p.goto(notebook);
  else if (/^[0-9a-f-]{36}$/i.test(notebook)) await p.goto(new URL(`/notebook/${notebook}`, HOME_URL).href);
  else {
    const want = notebook.toLowerCase();
    const links = await notebookLinks(p);
    const hit = links.find(l => l.title.toLowerCase() === want) || links.find(l => l.title.toLowerCase().includes(want));
    if (!hit) throw new Error(`No notebook matching "${notebook}". Notebooks: ${links.map(l => l.title).join(' | ')}`);
    await p.goto(hit.url);
  }
  await p.waitForLoadState('domcontentloaded');
  await p.getByRole('textbox').first().waitFor({ timeout: 20000 }).catch(() => {});
  await settle(p);
  await dismissPopups(p);
}

// The notebook page renders in stages, and input typed before the last stage is lost.
// Wait until the page text stops changing (max 15s).
async function settle(p) {
  let prev = -1, same = 0;
  for (let i = 0; i < 30 && same < 3; i++) {
    await p.waitForTimeout(500);
    const len = (await p.locator('body').innerText().catch(() => '')).length;
    same = len === prev ? same + 1 : 0;
    prev = len;
  }
}

const notebookArg = z.string().optional().describe('Notebook title (or part of it), id or URL. Omit to use the open notebook.');

tool('nlm_list_notebooks', 'List notebooks on the home page with their URLs (yours first, then featured ones).', {},
  async p => text((await notebookLinks(p)).map(l => `${l.title}\t${l.url}`).join('\n')));

tool('nlm_create_notebook', 'Create a new empty notebook, optionally titled. Returns its URL.',
  { title: z.string().optional() }, async (p, { title }) => {
    await p.goto(HOME_URL);
    await p.getByRole('button', { name: /new notebook|create( new)? notebook/i }).first().click();
    await p.waitForURL(/\/notebook\//, { timeout: 20000 });
    await p.waitForTimeout(2000);
    await dismissPopups(p);
    if (title) {
      // The title is the textbox whose value is the placeholder name, e.g. "Untitled notebook".
      for (const box of await p.getByRole('textbox').all()) {
        if (/untitled/i.test(await box.inputValue().catch(() => ''))) {
          await box.fill(title); await box.press('Enter'); break;
        }
      }
    }
    return text(`Created ${title ? `"${title}" ` : ''}${p.url()}`);
  });

tool('nlm_ask', 'Ask a notebook a question and return its full answer (waits until it finishes).',
  { notebook: notebookArg, question: z.string(), timeout_seconds: z.number().min(10).max(600).optional() },
  async (p, { notebook, question, timeout_seconds = 180 }) => {
    if (notebook) await openNotebook(p, notebook); else await dismissPopups(p);
    const box = p.getByRole('textbox', { name: /query|ask|chat|message|prompt/i })
      .or(p.getByPlaceholder(/ask|question/i)).last();
    // Page text after the last copy of the question = answer + the rest of the page (other panels).
    const after = async () => {
      const body = await p.locator('body').innerText();
      const i = body.lastIndexOf(question);
      return i < 0 ? '' : body.slice(i + question.length);
    };
    // Right after a notebook opens, Enter can be ignored; retry until the question shows up in the chat.
    const shown = (await p.locator('body').innerText()).split(question).length;
    for (let tries = 0; ; tries++) {
      await box.fill(question, { timeout: 10000 });
      await box.press('Enter');
      const ok = await p.waitForFunction(([q, n]) => document.body.innerText.split(q).length > n,
        [question, shown], { timeout: 15000 }).then(() => true, () => false);
      if (ok) break;
      if (tries === 2) throw new Error('The question was not accepted. Use nlm_snapshot to see why.');
    }
    let before = '', last = '', changed = false, stableFor = 0;
    for (const end = Date.now() + timeout_seconds * 1000; Date.now() < end && !(changed && stableFor >= 5000);) {
      await p.waitForTimeout(1000);
      const now = await after();
      if (!before) before = now;
      else if (now !== before) changed = true;
      stableFor = now && now === last ? stableFor + 1000 : 0;
      last = now;
    }
    // Drop icon-font names (e.g. thumb_up) and cut where the rest of the page starts: the first run of
    // 3 lines that were already on the page before the answer arrived.
    const icon = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^(copy|tune|sort|quiz|article|tablet|videocam|flowchart|settings)$/;
    const seen = new Set(before.split('\n').map(s => s.trim()).filter(Boolean));
    const lines = last.split('\n').map(s => s.trim()).filter(s => s && !icon.test(s));
    const cut = lines.findIndex((_, i) => i + 2 < lines.length && [0, 1, 2].every(k => seen.has(lines[i + k])));
    const reply = (cut < 0 ? lines : lines.slice(0, cut)).join('\n');
    if (!(changed && stableFor >= 5000)) return text(`Still answering after ${timeout_seconds}s. Partial answer:\n${reply}`);
    return text(reply);
  });

tool('nlm_add_source', 'Add sources to a notebook: website/YouTube URLs, pasted text, and/or local files.',
  { notebook: notebookArg, urls: z.array(z.string()).optional(), text: z.string().optional(),
    files: z.array(z.string()).optional() },
  async (p, { notebook, urls, text: pasted, files }) => {
    if (!urls?.length && !pasted && !files?.length) throw new Error('Give urls, text or files.');
    if (notebook) await openNotebook(p, notebook);
    const openAdder = async () => {
      // A new notebook opens the dialog by itself; otherwise click "Add source".
      if (!await p.getByRole('dialog').last().getByRole('button', { name: /website|copied text|upload/i }).first()
        .isVisible().catch(() => false))
        await p.getByRole('button', { name: /add sources?/i }).first().click();
      return p.getByRole('dialog').last();
    };
    const insert = async (kind, field, value) => {
      const d = await openAdder();
      await d.getByRole('button', { name: kind }).first().click();
      const f = p.getByRole('dialog').last().getByRole('textbox', { name: field }).first();
      await f.fill(value);
      await p.getByRole('dialog').last().getByRole('button', { name: /^(insert|add|submit)/i }).first().click();
      await p.waitForTimeout(1500);
    };
    const done = [];
    if (urls?.length) { await insert(/website|link|url/i, /url|link/i, urls.join('\n')); done.push(`${urls.length} URL(s)`); }
    if (pasted) { await insert(/copied text|paste/i, /paste|text/i, pasted); done.push('pasted text'); }
    if (files?.length) {
      const d = await openAdder();
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10000 }),
        d.getByRole('button', { name: /upload|choose file|browse/i }).first().click()]);
      await chooser.setFiles(files);
      await p.waitForTimeout(3000);
      done.push(`${files.length} file(s)`);
    }
    await dismissPopups(p);
    return text(`Added ${done.join(', ')}. Sources can take a minute to process; use nlm_snapshot to check.`);
  });

await server.connect(new StdioServerTransport());
