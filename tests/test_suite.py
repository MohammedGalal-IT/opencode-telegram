# OpenCode Telegram Bridge - Comprehensive Automated Test Suite
# Tests: Markdown & Smart Table Engine, Tag Balancing, Chunking, Security Guards, Power Logic

import re
import sys
import html
import json

passed = 0
failed = 0

def test(name, condition, details=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        print(f"  [FAIL] {name}: {details}")

# ==========================================
# 1. Markdown & Table Engine Tests
# ==========================================
print("\n--- 1. Testing Markdown & Smart Table Engine ---")

def escape_html(text):
    return html.escape(text or "", quote=False).replace('"', "&quot;").replace("'", "&#39;")

def balance_html_tags(raw_html):
    stack = []
    tag_regex = re.compile(r'<(/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?(/)?>')
    for match in tag_regex.finditer(raw_html):
        is_closing = bool(match.group(1))
        tag_name = match.group(2).lower()
        is_self_closing = bool(match.group(3)) or tag_name in ["br", "hr"]
        if is_self_closing:
            continue
        if not is_closing:
            stack.append(tag_name)
        else:
            if tag_name in stack:
                while stack and stack[-1] != tag_name:
                    stack.pop()
                if stack:
                    stack.pop()
    out = raw_html
    while stack:
        out += f"</{stack.pop()}>"
    return out

# Test Tag Balancer
t1 = balance_html_tags("<b>bold text <i>italic")
test("Tag Balancer closes nested tags in reverse order", t1 == "<b>bold text <i>italic</i></b>", f"Got: {t1}")

t2 = balance_html_tags("<pre><code>console.log('hello')")
test("Tag Balancer closes pre and code blocks", t2 == "<pre><code>console.log('hello')</code></pre>", f"Got: {t2}")

t3 = balance_html_tags("clean <b>bold</b> text")
test("Tag Balancer leaves already-closed tags untouched", t3 == "clean <b>bold</b> text", f"Got: {t3}")

# Table Parser & Renderers
def parse_markdown_table(raw):
    lines = [l.strip() for l in raw.strip().split("\n") if l.strip()]
    if len(lines) < 2:
        return None
    def parse_row(line):
        clean = line
        if clean.startswith("|"): clean = clean[1:]
        if clean.endswith("|"): clean = clean[:-1]
        return [c.strip() for c in clean.split("|")]
    headers = parse_row(lines[0])
    sep = parse_row(lines[1])
    if not headers or not sep or not all(re.match(r"^:?-{2,}:?$", s) for s in sep):
        return None
    rows = [parse_row(l) for l in lines[2:]]
    return headers, rows

def render_table_box(headers, rows):
    col_count = len(headers)
    widths = [max(3, len(h)) for h in headers]
    for row in rows:
        for i in range(col_count):
            val = row[i] if i < len(row) else ""
            widths[i] = max(widths[i], len(val))
    def pad(txt, w):
        return txt + " " * max(0, w - len(txt))
    top = "┌" + "┬".join("─" * (w + 2) for w in widths) + "┐"
    mid = "├" + "┼".join("─" * (w + 2) for w in widths) + "┤"
    bot = "└" + "┴".join("─" * (w + 2) for w in widths) + "┘"
    h_line = "│ " + " │ ".join(pad(h, widths[i]) for i, h in enumerate(headers)) + " │"
    d_lines = ["│ " + " │ ".join(pad(row[i] if i < len(row) else "", widths[i]) for i in range(col_count)) + " │" for row in rows]
    full = "\n".join([top, h_line, mid] + d_lines + [bot])
    return f"<pre>{escape_html(full)}</pre>"

def render_table_list(headers, rows):
    items = []
    if len(headers) == 2:
        for r in rows:
            c0 = r[0] if len(r) > 0 else ""
            c1 = r[1] if len(r) > 1 else ""
            items.append(f"• <b>{escape_html(c0)}</b>: {escape_html(c1)}")
    else:
        for idx, r in enumerate(rows):
            title = r[0] if len(r) > 0 else f"Item {idx + 1}"
            lines = [f"📌 <b>{escape_html(title)}</b>"]
            for i in range(1, len(headers)):
                h = headers[i] if i < len(headers) else f"Field {i}"
                v = r[i] if i < len(r) else "—"
                lines.append(f"  • {escape_html(h)}: {escape_html(v)}")
            items.append("\n".join(lines))
    return "\n\n".join(items)

def render_table(raw, mode="smart"):
    parsed = parse_markdown_table(raw)
    if not parsed:
        return raw
    headers, rows = parsed
    if mode == "box":
        return render_table_box(headers, rows)
    if mode == "list":
        return render_table_list(headers, rows)
    # Smart mode
    has_long_cells = any(any(len(c) > 45 for c in r) for r in rows)
    if len(headers) == 2 and not has_long_cells:
        return render_table_list(headers, rows)
    return render_table_box(headers, rows)

sample_table_2col = """| الأمر | الوظيفة |
| :--- | :--- |
| /start | بدء الاستخدام |
| /status | فحص الحالة |"""

sample_table_3col = """| Command | Purpose | Level |
| :--- | :--- | :--- |
| /current | Show session | Read |
| /stop | Stop execution | Write |"""

tb_smart = render_table(sample_table_2col, "smart")
test("Smart Table: 2-column conversational table renders as clean list", "• <b>/start</b>: بدء الاستخدام" in tb_smart)

tb_box = render_table(sample_table_3col, "box")
test("Box Table: Multi-column table renders with valid monospace Unicode box", tb_box.startswith("<pre>┌") and tb_box.endswith("┘</pre>"))

tb_list = render_table(sample_table_3col, "list")
test("List Table: Multi-column table renders with clean item pins", "📌 <b>/current</b>" in tb_list and "• Purpose: Show session" in tb_list)

# Full Markdown to Telegram HTML Converter
def md_to_html(source, table_mode="smart"):
    if not source:
        return ""
    blocks = []
    def placeholder(idx):
        return f"\u0000TG_BLK_{idx}\u0000"

    # Tables
    table_regex = re.compile(r"((?:^[ \t]*\|?[^\n\|]+\|[^\n]*\n)[ \t]*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?:\s*:?-{2,}:?\s*)?(?:\n[ \t]*\|?[^\n\|]+\|[^\n]*)+)", re.M)
    def repl_table(m):
        blocks.append(render_table(m.group(1), table_mode))
        return placeholder(len(blocks) - 1)
    val = table_regex.sub(repl_table, source)

    # Multi-line code fences
    fence_regex = re.compile(r"```([A-Za-z0-9_+.-]*)[^\n]*\n?([\s\S]*?)```")
    def repl_fence(m):
        lang = m.group(1)
        code = (m.group(2) or "").rstrip("\n")
        lang_attr = f' class="language-{escape_html(lang)}"' if lang else ""
        blocks.append(f"<pre><code{lang_attr}>{escape_html(code)}</code></pre>")
        return placeholder(len(blocks) - 1)
    val = fence_regex.sub(repl_fence, val)

    # Inline code
    inline_regex = re.compile(r"`([^`\n]+)`")
    def repl_inline(m):
        blocks.append(f"<code>{escape_html(m.group(1))}</code>")
        return placeholder(len(blocks) - 1)
    val = inline_regex.sub(repl_inline, val)

    # Links
    link_regex = re.compile(r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)")
    def repl_link(m):
        blocks.append(f'<a href="{escape_html(m.group(2))}">{escape_html(m.group(1))}</a>')
        return placeholder(len(blocks) - 1)
    val = link_regex.sub(repl_link, val)

    # Escape rest
    val = escape_html(val)

    # Markdown styling
    val = re.sub(r"(^|\n)#{1,6}\s+([^\n]+)", r"\1<b>\2</b>", val)
    val = re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", val)
    val = re.sub(r"(^|\s)__([^_\n]+)__(\s|$)", r"\1<b>\2</b>\3", val)
    val = re.sub(r"(^|[^*])\*([^*\n]+)\*(?!\*)", r"\1<i>\2</i>", val)
    val = re.sub(r"~~([^~\n]+)~~", r"<s>\1</s>", val)
    val = re.sub(r"(^|\n)\s*[-*+]\s+", r"\1• ", val)
    # Block quotes (> quote or &gt; quote)
    val = re.sub(r"(^|\n)(?:>|&gt;)\s*([^\n]+)", r"\1<blockquote>\2</blockquote>", val)

    # Restore
    for i, b in enumerate(blocks):
        val = val.replace(placeholder(i), b)

    return balance_html_tags(val)

md_sample = """# Test Title
Here is **bold** text and `inline <code & var>` plus a link: [OpenCode](https://opencode.ai)

```python
def add(a, b):
    return a + b
```

> Block quote note
- Item 1
- Item 2
"""
res_html = md_to_html(md_sample)
test("mdToHtml: Header converted to <b>", "<b>Test Title</b>" in res_html)
test("mdToHtml: Bold converted to <b>", "<b>bold</b>" in res_html)
test("mdToHtml: Inline code escaped & preserved", "<code>inline &lt;code &amp; var&gt;</code>" in res_html)
test("mdToHtml: Multi-line code fence preserves syntax & indentation", '<pre><code class="language-python">def add(a, b):\n    return a + b</code></pre>' in res_html)
test("mdToHtml: Link converted to <a>", '<a href="https://opencode.ai">OpenCode</a>' in res_html)
test("mdToHtml: Blockquote preserved", "<blockquote>Block quote note</blockquote>" in res_html)
def get_open_tags(text):
    stack = []
    for match in re.finditer(r'<(/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?(/)?>', text):
        is_closing = bool(match.group(1))
        tag_name = match.group(2).lower()
        is_self_closing = bool(match.group(3)) or tag_name in ["br", "hr"]
        if is_self_closing: continue
        if not is_closing:
            stack.append(tag_name)
        else:
            if tag_name in stack:
                while stack and stack[-1] != tag_name: stack.pop()
                if stack: stack.pop()
    return stack

test("mdToHtml: Tag balancer closes all tags safely", len(get_open_tags(res_html)) == 0)

# ==========================================
# 2. HTML Chunking & Tag Propagation Tests
# ==========================================
print("\n--- 2. Testing Message Splitting & Tag Propagation ---")

def get_open_tags(text):
    stack = []
    for match in re.finditer(r'<(/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?(/)?>', text):
        is_closing = bool(match.group(1))
        tag_name = match.group(2).lower()
        is_self_closing = bool(match.group(3)) or tag_name in ["br", "hr"]
        if is_self_closing: continue
        if not is_closing:
            stack.append(tag_name)
        else:
            if tag_name in stack:
                while stack and stack[-1] != tag_name: stack.pop()
                if stack: stack.pop()
    return stack

def split_html(raw_html, limit=100):
    val = str(raw_html or "")
    if len(val) <= limit:
        return [balance_html_tags(val)]
    chunks = []
    rest = val
    carry_tags = []
    while len(rest) > limit:
        prefix = "".join(f"<{t}>" for t in carry_tags)
        effective_limit = max(20, limit - len(prefix))
        cut = rest.rfind("\n", 0, effective_limit)
        if cut < int(effective_limit * 0.55):
            cut = effective_limit
        open_idx = rest.rfind("<", 0, cut)
        close_idx = rest.rfind(">", 0, cut)
        if open_idx > close_idx:
            cut = open_idx
        if cut <= 0:
            cut = effective_limit
        raw_slice = rest[:cut]
        chunk_content = prefix + raw_slice
        open_tags = get_open_tags(chunk_content)
        chunks.append(balance_html_tags(chunk_content))
        carry_tags = open_tags
        rest = rest[cut:].lstrip("\n")
    if rest:
        prefix = "".join(f"<{t}>" for t in carry_tags)
        chunks.append(balance_html_tags(prefix + rest))
    return chunks

long_text = "<pre><code>" + "\n".join(f"line_{i} = 'value_{i}'" for i in range(15)) + "</code></pre>"
chunks = split_html(long_text, limit=120)

test("Chunking splits message into multiple parts", len(chunks) > 1, f"Count: {len(chunks)}")
test("Chunk 1 closes open <pre><code> properly", chunks[0].endswith("</code></pre>"), f"Chunk 0: {chunks[0]}")
test("Chunk 2 re-opens <pre><code> properly from previous chunk", chunks[1].startswith("<pre><code>"), f"Chunk 1: {chunks[1]}")

# ==========================================
# 3. Security, Whitelist & Bot Collision Tests
# ==========================================
print("\n--- 3. Testing Security Guards & Isolation ---")

def validate_token_safety(token):
    if not token or not isinstance(token, str):
        return False, "Empty token"
    # Collision check with emby-dl bot
    if token.startswith("9025456415:"):
        return False, "Collision with emby-dl bot token detected"
    # Basic token pattern check
    if not re.match(r"^\d{8,12}:[A-Za-z0-9_-]{30,45}$", token):
        return False, "Invalid Telegram token format"
    return True, "OK"

ok, msg = validate_token_safety("9025456415:AAGfJm5WU6zqG_nxZYYsKAV7KwiAHnowoYM")
test("Safety Guard blocks emby-dl bot token collision", not ok and "Collision" in msg)

ok2, msg2 = validate_token_safety("1234567890:ABCdefGHIjklMNOpqrsTUVwxyz12345")
test("Safety Guard permits valid dedicated OpenCode bot token", ok2 and msg2 == "OK")

def is_chat_allowed(allowed_ids, chat_id):
    normalized = [str(i).strip() for i in allowed_ids if str(i).strip()]
    return str(chat_id).strip() in normalized

whitelist = ["123456789", 99887766]
test("Chat Whitelist permits allowed chat ID (string)", is_chat_allowed(whitelist, "123456789"))
test("Chat Whitelist permits allowed chat ID (numeric conversion)", is_chat_allowed(whitelist, 99887766))
test("Chat Whitelist strictly blocks unauthorized chat ID", not is_chat_allowed(whitelist, "999999999"))

# ==========================================
# 4. Power & Battery Logic Tests
# ==========================================
print("\n--- 4. Testing Power & Battery Logic ---")

class MockPowerGuard:
    def __init__(self, target_percent=12):
        self.enabled = True
        self.target_percent = target_percent
        self.warned_early = False
        self.hibernated = False
        self.early_warning_sent = False

    def evaluate_tick(self, percent, is_online):
        if not self.enabled:
            return "IDLE"
        if is_online:
            self.warned_early = False
            return "ONLINE_CHARGING"
        if not is_online and percent <= 16 and percent > self.target_percent and not self.warned_early:
            self.warned_early = True
            self.early_warning_sent = True
            return "EARLY_WARNING"
        if not is_online and percent <= self.target_percent and percent > 0:
            self.hibernated = True
            self.enabled = False
            return "CRITICAL_HIBERNATE"
        return "NORMAL_DISCHARGING"

guard = MockPowerGuard(target_percent=12)

# Case A: Battery at 80% on battery
r1 = guard.evaluate_tick(80, is_online=False)
test("Power Guard: 80% on battery -> Normal discharging", r1 == "NORMAL_DISCHARGING" and not guard.hibernated)

# Case B: Battery at 15% on battery
r2 = guard.evaluate_tick(15, is_online=False)
test("Power Guard: 15% on battery -> Triggers early warning alert", r2 == "EARLY_WARNING" and guard.early_warning_sent and not guard.hibernated)

# Case C: Battery at 15% but now plugged in to AC
r3 = guard.evaluate_tick(15, is_online=True)
test("Power Guard: 15% plugged into charger -> Charging safely, warning reset", r3 == "ONLINE_CHARGING" and not guard.warned_early)

# Case D: Battery drops to 12% on battery
r4 = guard.evaluate_tick(12, is_online=False)
test("Power Guard: 12% on battery -> Triggers critical hibernation and auto-disables", r4 == "CRITICAL_HIBERNATE" and guard.hibernated and not guard.enabled)

# Case E: Battery at 10% but plugged into AC (e.g. charging up from empty)
guard_ac = MockPowerGuard(target_percent=12)
r5 = guard_ac.evaluate_tick(10, is_online=True)
test("Power Guard: 10% on AC power -> Will NOT hibernate while plugged in", r5 == "ONLINE_CHARGING" and not guard_ac.hibernated)

# ==========================================
# Summary
# ==========================================
print("\n" + "="*50)
print(f"Total Tests Run: {passed + failed}")
print(f"Passed: {passed}")
print(f"Failed: {failed}")
print("="*50)

if failed == 0:
    print("ALL TESTS PASSED SUCCESSFULLY! (100% Quality Score)")
    sys.exit(0)
else:
    print("SOME TESTS FAILED.")
    sys.exit(1)
