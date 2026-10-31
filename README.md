# notebooklm-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) use
[Google NotebookLM](https://notebooklm.google.com), now also called Gemini Notebook, with a **free Google account**.

It drives the real NotebookLM website in its own Chrome window. The tools find buttons, links and
text boxes by their accessible role and name (what a screen reader sees), not by CSS selectors.
The agent reads the page fresh before each step, so it keeps working when Google changes the layout.

> **Unofficial.** This is not affiliated with Google. It automates the normal website, which may
> go against Google's Terms of Service and may stop working if Google blocks automated browsers.
> Use it for personal and experimental work, at your own risk.

## Tools

Shortcuts for common jobs (they fall back to the general tools if the site changes too much):

| Tool | What it does |
| --- | --- |
| `nlm_list_notebooks` | List your notebooks with their URLs |
| `nlm_create_notebook` | Create a notebook, optionally with a title |
| `nlm_ask` | Ask a notebook (by title, id or URL) a question and return the finished answer |
| `nlm_add_source` | Add website/YouTube URLs, pasted text and/or local files as sources |
| `nlm_download` | Click a download button or menu item and save the file (default `~/Downloads/NotebookLM`) |

General tools, which work on any page:

| Tool | What it does |
| --- | --- |
| `nlm_snapshot` | Accessibility tree of the page: every element's role, name and text |
| `nlm_open` | Go to a URL (default: NotebookLM home, which lists your notebooks) |
| `nlm_click` | Click an element by role/name, or by visible text |
| `nlm_type` | Fill a text field and optionally press Enter |
| `nlm_press` | Press a key, e.g. `Escape` to close a popup |
| `nlm_upload` | Click an upload button and give it local files |
| `nlm_read` | Read the visible text of the page or one element (e.g. a full answer) |
| `nlm_wait` | Wait for an answer or source to finish, or until some text appears |
| `nlm_screenshot` | PNG of the page when the text view is not enough |

With these the agent can list, open, create and search notebooks, add sources, ask questions
with citations, and make Studio content (Audio Overviews, slides, mind maps, quizzes, reports, ...).

## Setup

Needs Node.js 18+ and a Chrome-type browser. It uses, in order: `NLM_CHROME`, an installed Google
Chrome or Chromium, or a Chromium downloaded by Playwright (`npx playwright install chromium`).

The commands below use the npm package `notebooklm-browser-mcp`. You can also run it straight from
GitHub by writing `github:DwytMCL/notebooklm-mcp` in its place.

Sign in to Google once. This opens a separate Chrome window with its own profile:

```bash
npx -y notebooklm-browser-mcp login
```

Sign in, check your notebooks load, then **quit that window** (Cmd+Q / close all windows).
The server cannot attach while the sign-in window is still open.

Sign in separately for each tool. Never copy a signed-in profile folder to another browser or
server: Google sees the same session in two browsers, revokes it, and both come back signed out
after the next restart.

### Claude Code

```bash
claude mcp add -s user notebooklm -- npx -y notebooklm-browser-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "notebooklm-browser-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/DwytMCL/notebooklm-mcp.git
cd notebooklm-mcp
npm install
node server.js login
npm test   # starts the server, lists the tools and opens NotebookLM
```

Then use `node /absolute/path/to/notebooklm-mcp/server.js` as the command instead of `npx`.

## Settings

All optional, set as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NLM_CHROME` | Google Chrome, else Playwright's Chromium | Path to the Chrome/Chromium binary |
| `NLM_PROFILE` | `~/.notebooklm-mcp/profile` | Browser profile holding your Google sign-in |
| `NLM_PORT` | `9333` | Local port the server uses to control Chrome |
| `NLM_DOWNLOADS` | `~/Downloads/NotebookLM` | Where `nlm_download` saves files |

## Privacy

Your Google session lives only in the browser profile folder on your machine (`NLM_PROFILE`).
Nothing is sent anywhere except to Google by the browser itself. Treat that folder like a password:
don't share or commit it. Chrome's control port listens on `127.0.0.1` only, but any program on your
machine could use it while the window is open.

## License

MIT
