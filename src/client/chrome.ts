import { findClubsUrl, needsClubScan, suggest } from "fiperson/people";
import { dropOptions } from "../shared/doc.ts";
import type { Thread } from "../shared/threads.ts";
import type { Editor } from "./editor.ts";
import { loadImages } from "./images.ts";
import { contentWidth } from "./layout.ts";

interface AtItem {
  label: string;
  detail: string;
  run: () => void;
  icon?: string;
  person?: boolean;
}

export interface Person {
  sid: string;
  name: string;
  color: string;
}

export interface Chrome {
  setThreads(threads: Thread[]): void;
  upsert(thread: Thread): void;
  openFind(replace: boolean): void;
  openLink(): void;
  openComment(): void;
  openWordCount(): void;
  openShortcuts(): void;
  openImage(): void;
  syncAt(query: string | null): void;
  atKey(e: KeyboardEvent): boolean;
  showDropdown(index: number): void;
  refresh(): void;
}

function nid(prefix: string): string {
  return (prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)).slice(0, 40);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function mountChrome(
  editor: Editor,
  opts: {
    send: (msg: unknown) => void;
    toast: (s: string) => void;
    people: () => Person[];
    canResolve?: () => boolean;
    /** Doc participants with a wallet (peers + people already mentioned), for FiPerson suggestions. */
    participants?: () => { address: string; name?: string }[];
    /** A person chip was inserted from the @ menu. */
    onMention?: (address: string, name: string) => void;
  },
): Chrome {
  const notes = document.querySelector("#notes") as HTMLElement;
  const findBar = document.querySelector("#findbar") as HTMLElement;
  const findQ = document.querySelector("#find-q") as HTMLInputElement;
  const findRepl = document.querySelector("#find-repl") as HTMLInputElement;
  const findCount = document.querySelector("#find-count") as HTMLElement;
  const linkPop = document.querySelector("#link-pop") as HTMLElement;
  const linkUrl = document.querySelector("#link-url") as HTMLInputElement;
  const atMenu = document.querySelector("#at-menu") as HTMLElement;
  const imagePop = document.querySelector("#image-pop") as HTMLElement;
  const imageUrl = document.querySelector("#image-url") as HTMLInputElement;
  const dialog = document.querySelector("#dialog") as HTMLElement;
  const dialogBody = document.querySelector("#dialog-body") as HTMLElement;
  const dialogTitle = document.querySelector("#dialog-title") as HTMLElement;
  const addBtn = document.querySelector("#comment-add") as HTMLButtonElement;
  const tableTools = document.querySelector("#table-tools") as HTMLElement;
  let atIndex = 0;
  let atItems: AtItem[] = [];
  let composerFor: string | null = null;

  notes.addEventListener("keydown", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest("textarea, input")) return;
    const key = ev.key.toLowerCase();
    if (!["j", "k", "r", "e"].includes(key) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const cards = [...notes.querySelectorAll<HTMLElement>(".note")];
    const cur = cards.findIndex((card) => card === document.activeElement || card.contains(document.activeElement));
    if (cur < 0) return;
    const card = cards[cur];
    if (key === "j" || key === "k") {
      ev.preventDefault();
      cards[key === "j" ? Math.min(cards.length - 1, cur + 1) : Math.max(0, cur - 1)]?.focus();
    } else if (key === "r") {
      ev.preventDefault();
      card.querySelector<HTMLButtonElement>(".reply-btn")?.click();
    } else if (key === "e") {
      ev.preventDefault();
      card.querySelector<HTMLButtonElement>(".resolve-btn")?.click();
    }
  });

  const paintPressed = () => {
    document.querySelector("#paint")?.setAttribute("aria-pressed", editor.formatPaint ? "true" : "false");
  };

  function placeAdd(): void {
    const point = editor.selectionPoint();
    if (!editor.ready || point.collapsed) {
      addBtn.hidden = true;
      return;
    }
    addBtn.hidden = false;
    addBtn.style.top = point.y + "px";
  }

  function renderNotes(): void {
    notes.innerHTML = "";
    let floor = 0;
    for (const card of editor.suggestionCards()) {
      let top = editor.anchorPoint(card.start).y;
      if (top < floor) top = floor;
      const node = el("article", "note suggest");
      node.tabIndex = 0;
      node.dataset.suggest = card.id;
      node.style.top = top + "px";
      node.style.borderTop = "3px solid " + card.color;
      const quote = el("div", "note-quote", (card.kind === "del" ? "Delete: " : "Add: ") + card.quote);
      const head = el("div", "note-head");
      const who = el("span", "note-name", card.name);
      who.style.color = card.color;
      head.append(who, el("span", "", card.kind === "del" ? "Deletion" : "Insertion"));
      const actions = el("div", "note-actions");
      const accept = el("button", "accept", "Accept");
      accept.type = "button";
      accept.addEventListener("click", () => editor.acceptSuggestion(card.id));
      const reject = el("button", "reject", "Reject");
      reject.type = "button";
      reject.addEventListener("click", () => editor.rejectSuggestion(card.id));
      if (editor.role === "edit") actions.append(accept, reject);
      node.append(quote, head, actions);
      notes.append(node);
      floor = top + node.offsetHeight + 8;
    }
    const open = editor.threads.filter((t) => !t.resolved);
    const cards = open;
    for (const thread of cards) {
      const span = editor.commentSpans(thread.id)[0];
      let top = span ? editor.anchorPoint(span.start).y : 72;
      if (top < floor) top = floor;
      floor = top + 8;
      const card = el("article", "note" + (thread.resolved ? " resolved" : ""));
      card.tabIndex = 0;
      card.style.top = top + "px";
      card.dataset.thread = thread.id;
      const head = el("div", "note-head");
      const who = el("span", "note-name", thread.name);
      who.style.color = thread.color;
      head.append(who, el("time", "", new Date(thread.ts).toLocaleString()));
      card.append(head, renderText(thread.text));
      for (const reply of thread.replies) {
        const row = el("div", "note-reply");
        const name = el("span", "note-name", reply.name);
        row.append(name, renderText(reply.text));
        card.append(row);
      }
      if (composerFor === thread.id && !thread.resolved) card.append(replyBox(thread));
      const actions = el("div", "note-actions");
      if (!thread.resolved) {
        const reply = el("button", "reply-btn", "Reply");
        reply.type = "button";
        reply.addEventListener("click", () => {
          composerFor = thread.id;
          renderNotes();
        });
        actions.append(reply);
      }
      if (opts.canResolve?.() ?? true) {
        const toggle = el("button", "resolve-btn", thread.resolved ? "Reopen" : "Resolve");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          opts.send({ t: "resolve", id: thread.id, resolved: !thread.resolved });
        });
        actions.append(toggle);
      }
      card.append(actions);
      notes.append(card);
      floor = top + card.offsetHeight + 8;
    }
    notes.dataset.sug = editor.suggestionCards().map((card) => card.id + ":" + card.kind + ":" + card.quote).join("|");
  }

  function renderText(text: string): HTMLElement {
    const node = el("p", "note-text");
    const names = new Set(opts.people().map((p) => p.name));
    const parts = text.split(/(@[\w][\w .'-]{0,40})/g);
    for (const part of parts) {
      if (part.startsWith("@") && names.has(part.slice(1).trim())) {
        const chip = el("span", "mention", part);
        node.append(chip);
      } else node.append(part);
    }
    return node;
  }

  function replyBox(thread: Thread): HTMLElement {
    const box = el("form", "reply-box");
    const input = el("textarea") as HTMLTextAreaElement;
    input.rows = 2;
    input.placeholder = "Reply, @ to mention";
    const mentions = el("div", "mention-list");
    input.addEventListener("input", () => fillMentions(input, mentions));
    const send = el("button", "", "Reply");
    send.type = "submit";
    box.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      opts.send({ t: "reply", id: thread.id, replyId: nid("r"), text });
      composerFor = null;
    });
    box.append(input, mentions, send);
    window.setTimeout(() => input.focus(), 0);
    return box;
  }

  function fillMentions(input: HTMLTextAreaElement, host: HTMLElement): void {
    host.innerHTML = "";
    const upto = input.value.slice(0, input.selectionStart);
    const match = upto.match(/@([\w][\w .'-]*)$/);
    if (!match) return;
    const q = match[1].toLowerCase();
    for (const person of opts.people()) {
      if (q && !person.name.toLowerCase().includes(q)) continue;
      const btn = el("button", "", person.name);
      btn.type = "button";
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => {
        const start = input.selectionStart - match[0].length;
        input.value = input.value.slice(0, start) + "@" + person.name + " " + input.value.slice(input.selectionStart);
        input.focus();
        host.innerHTML = "";
      });
      host.append(btn);
    }
  }

  function openComposer(): void {
    if (editor.selectionPoint().collapsed) {
      opts.toast("Select text to comment");
      return;
    }
    const id = nid("c");
    // Keep the selection the comment is for: typing in the box must not lose it.
    const range = { anchor: editor.anchor, head: editor.head };
    const card = el("form", "note composer");
    const point = editor.selectionPoint();
    card.style.top = point.y + "px";
    const input = el("textarea") as HTMLTextAreaElement;
    input.rows = 3;
    input.placeholder = "Comment, @ to mention";
    const mentions = el("div", "mention-list");
    input.addEventListener("input", () => fillMentions(input, mentions));
    const row = el("div", "note-actions");
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const save = el("button", "", "Comment");
    save.type = "submit";
    cancel.addEventListener("click", () => card.remove());
    card.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      editor.anchor = range.anchor;
      editor.head = range.head;
      const quote = editor.addCommentMark(id);
      if (quote == null) {
        opts.toast("Select text to comment");
        return;
      }
      const thread: Thread = {
        id,
        sid: editor.sync.sid,
        name: editor.name,
        color: editor.color,
        text,
        ts: Date.now(),
        quote,
        resolved: false,
        replies: [],
      };
      editor.upsertThread(thread);
      opts.send({ t: "thread", id, text, quote });
      card.remove();
      renderNotes();
    });
    row.append(cancel, save);
    card.append(input, mentions, row);
    notes.append(card);
    input.focus();
  }

  function atEntries(query: string): AtItem[] {
    const q = query.toLowerCase();
    const items: AtItem[] = [
      { label: "Voting chip", detail: "Emoji ballot", run: () => editor.insertVote("👍") },
      { label: "Date", detail: "Today", run: () => editor.insertEmbed({ embed: "date", iso: new Date().toISOString().slice(0, 10) }) },
      { label: "Dropdown", detail: "Yes / No / Maybe", run: () => editor.insertEmbed({ embed: "drop", opts: JSON.stringify(["Yes", "No", "Maybe"]), val: "Yes" }) },
      { label: "Table", detail: "3 × 3", run: () => editor.insertTable(3, 3) },
      { label: "Image", detail: "URL or upload", run: () => openImage() },
      { label: "Horizontal line", detail: "", run: () => editor.insertRule() },
      { label: "Page break", detail: "", run: () => editor.insertPageBreak() },
    ];
    // FiPerson owns who can be mentioned (club-mates + participants); FiPen only renders suggest() results.
    const found = suggest(query, { participants: opts.participants?.() ?? [], limit: 6 });
    const people: AtItem[] = found.map((p) => ({
      label: p.name,
      detail: p.hint || "Person",
      icon: p.iconUrl,
      person: true,
      run: () => {
        editor.insertEmbed({ embed: "person", label: p.name, addr: p.id });
        opts.onMention?.(p.id, p.name);
      },
    }));
    // Peers without a wallet still get a name-only chip (no card or notify).
    const known = new Set(found.map((p) => p.name));
    for (const p of opts.people().filter((x) => x.sid !== editor.sync.sid && !known.has(x.name)))
      if (!q || p.name.toLowerCase().includes(q)) people.push({ label: p.name, detail: "In this document", person: true, run: () => editor.insertEmbed({ embed: "person", label: p.name }) });
    if (!people.length && needsClubScan())
      people.push({ label: "Find my club-mates", detail: "FiPerson: Find all my Clubs", icon: "", person: true, run: () => (editor.closeAt(), window.open(findClubsUrl(), "_blank", "noopener")) });
    const rest = items.filter((item) => !q || item.label.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q));
    // People first while typing a name (Google Docs), the insert menu first for a bare "@".
    return [...people, ...rest];
  }

  function paintAt(): void {
    atMenu.innerHTML = "";
    if (!atItems.length) {
      atMenu.hidden = true;
      return;
    }
    atIndex = Math.max(0, Math.min(atIndex, atItems.length - 1));
    atItems.forEach((item, n) => {
      const btn = el("button", n === atIndex ? "at-item active" : "at-item");
      btn.type = "button";
      if (item.person) {
        btn.classList.add("at-person");
        const av = el("span", "at-avatar");
        if (item.icon) {
          const img = document.createElement("img");
          img.src = item.icon;
          img.alt = "";
          av.append(img);
        } else av.textContent = item.label === "Find my club-mates" ? "+" : (item.label.trim()[0] || "?").toUpperCase();
        btn.append(av);
      }
      btn.append(el("span", "", item.label), el("small", "", item.detail));
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => item.run());
      atMenu.append(btn);
    });
    const point = editor.selectionPoint();
    atMenu.style.left = Math.max(8, point.x) + "px";
    atMenu.style.top = point.y + point.h + "px";
    atMenu.hidden = false;
  }

  function openFind(replace: boolean): void {
    findBar.hidden = false;
    findRepl.hidden = !replace;
    document.querySelector("#find-replace")?.toggleAttribute("hidden", !replace);
    document.querySelector("#find-all")?.toggleAttribute("hidden", !replace);
    findQ.focus();
    findQ.select();
    if (findQ.value) editor.setFind(findQ.value, editor.findIndex);
    refreshFindCount();
  }

  function refreshFindCount(): void {
    const n = editor.findMatches.length;
    findCount.textContent = editor.findError ? "Invalid" : n ? `${editor.findIndex + 1} of ${n}` : findQ.value ? "0 of 0" : "";
  }

  function openLink(): void {
    linkUrl.value = editor.currentLink() || "";
    const point = editor.selectionPoint();
    linkPop.style.top = point.y + point.h + 4 + "px";
    linkPop.style.left = Math.min(point.x, 520) + "px";
    linkPop.hidden = false;
    linkUrl.focus();
  }

  function openImage(): void {
    imagePop.hidden = false;
    imageUrl.focus();
  }

  function openDialog(title: string, body: HTMLElement): void {
    dialogTitle.textContent = title;
    dialogBody.innerHTML = "";
    dialogBody.append(body);
    dialog.hidden = false;
  }

  function openWordCount(): void {
    const count = editor.wordCount();
    const body = el("div", "count-grid");
    const rows: [string, number][] = [
      ["Words", count.words],
      ["Characters", count.characters],
      ["Characters excluding spaces", count.charactersNoSpaces],
    ];
    for (const [label, value] of rows) {
      body.append(el("span", "", label), el("strong", "", String(value)));
    }
    openDialog(count.selection ? "Word count (selection)" : "Word count", body);
  }

  function openShortcuts(): void {
    const body = el("ul", "shortcut-list");
    const rows = [
      ["Bold", "Ctrl+B"],
      ["Italic", "Ctrl+I"],
      ["Underline", "Ctrl+U"],
      ["Strikethrough", "Alt+Shift+5"],
      ["Superscript / subscript", "Ctrl+. / Ctrl+,"],
      ["Increase / decrease size", "Ctrl+Shift+. / Ctrl+Shift+,"],
      ["Link", "Ctrl+K"],
      ["Small caps", "Ctrl+Shift+K"],
      ["Find / replace", "Ctrl+F / Ctrl+H"],
      ["Find next", "Ctrl+G"],
      ["Comment", "Ctrl+Alt+M"],
      ["Clear formatting", "Ctrl+\\"],
      ["Copy / paste formatting", "Ctrl+Alt+C / Ctrl+Alt+V"],
      ["Indent / outdent", "Ctrl+] / Ctrl+["],
      ["Headings", "Ctrl+Alt+1…6"],
      ["Suggesting mode", "Ctrl+Alt+Shift+X"],
      ["Footnote", "Ctrl+Alt+F"],
      ["Next / previous comment", "J / K"],
      ["Reply / resolve comment", "R / E"],
      ["Lists", "Ctrl+Shift+7 / 8 / 9"],
      ["Align", "Ctrl+Shift+L E R J"],
      ["Page break", "Ctrl+Enter"],
      ["Word count", "Ctrl+Shift+C"],
      ["Shortcuts", "Ctrl+/"],
    ];
    for (const [name, keys] of rows) {
      const li = el("li");
      li.append(el("span", "", name), el("kbd", "", keys));
      body.append(li);
    }
    openDialog("Keyboard shortcuts", body);
  }

  function showDropdown(index: number): void {
    const st = editor.doc.styles[index];
    if (!st || st.embed !== "drop") return;
    const optsList = dropOptions(st);
    atMenu.innerHTML = "";
    for (const option of optsList) {
      const btn = el("button", "at-item", option);
      btn.type = "button";
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => {
        editor.setDropdown(index, option);
        atMenu.hidden = true;
      });
      atMenu.append(btn);
    }
    const point = editor.selectionPoint();
    atMenu.style.left = point.x + "px";
    atMenu.style.top = point.y + point.h + "px";
    atMenu.hidden = false;
  }

  // Google Docs: Enter / Shift+Enter step through hits with focus kept in the box; Escape closes and returns to the text.
  findQ.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.findStep(e.shiftKey ? -1 : 1);
      refreshFindCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      (document.querySelector("#find-close") as HTMLElement).click();
    }
  });
  findQ.addEventListener("input", () => {
    editor.setFind(findQ.value, 0);
    refreshFindCount();
  });
  document.querySelector("#find-regex")?.addEventListener("change", (ev) => {
    editor.findRegex = (ev.target as HTMLInputElement).checked;
    editor.setFind(findQ.value, 0);
    refreshFindCount();
  });
  document.querySelector("#find-next")!.addEventListener("click", () => {
    editor.findStep(1);
    refreshFindCount();
  });
  document.querySelector("#find-prev")!.addEventListener("click", () => {
    editor.findStep(-1);
    refreshFindCount();
  });
  document.querySelector("#find-replace")!.addEventListener("click", () => {
    editor.replaceOne(findRepl.value);
    refreshFindCount();
  });
  document.querySelector("#find-all")!.addEventListener("click", () => {
    const n = editor.replaceAll(findRepl.value);
    opts.toast(n ? `Replaced ${n}` : "No matches");
    refreshFindCount();
  });
  document.querySelector("#find-close")!.addEventListener("click", () => {
    findBar.hidden = true;
    editor.setFind("");
    editor.focus();
  });
  document.querySelector("#link-apply")!.addEventListener("click", () => {
    editor.setLink(linkUrl.value);
    linkPop.hidden = true;
    editor.focus();
  });
  document.querySelector("#link-clear")!.addEventListener("click", () => {
    editor.setLink(null);
    linkPop.hidden = true;
    editor.focus();
  });
  document.querySelector("#link-open")!.addEventListener("click", () => {
    const url = linkUrl.value.trim() || editor.currentLink();
    if (url) editor.followLink(url);
  });
  document.querySelector("#image-insert")!.addEventListener("click", () => {
    const src = imageUrl.value.trim();
    if (!src) return;
    imagePop.hidden = true;
    imageUrl.value = "";
    void loadImages({ files: [], urls: [{ url: src, alt: "Image" }] }, Math.min(contentWidth(), 624)).then((images) => {
      if (images.length) editor.placeImages(images, null);
      else {
        editor.insertImage(src, "Image", 320, 200);
        editor.focus();
      }
    });
  });
  (document.querySelector("#image-file") as HTMLInputElement).addEventListener("change", () => {
    const input = document.querySelector("#image-file") as HTMLInputElement;
    const files = [...(input.files || [])].filter((f) => f.type.startsWith("image/"));
    input.value = "";
    if (!files.length) return;
    imagePop.hidden = true;
    void loadImages({ files, urls: [] }, Math.min(contentWidth(), 624)).then((images) => editor.placeImages(images, null));
  });
  document.querySelector("#image-close")!.addEventListener("click", () => {
    imagePop.hidden = true;
    editor.focus();
  });
  document.querySelector("#dialog-close")!.addEventListener("click", () => {
    dialog.hidden = true;
    editor.focus();
  });
  addBtn.addEventListener("click", () => openComposer());
  document.querySelector("#row-add")!.addEventListener("click", () => editor.addRow());
  document.querySelector("#row-remove")!.addEventListener("click", () => editor.removeRow());
  document.querySelector("#col-add")!.addEventListener("click", () => editor.addColumn());
  document.querySelector("#col-remove")!.addEventListener("click", () => editor.removeColumn());

  return {
    setThreads(threads) {
      editor.setThreads(threads);
      renderNotes();
    },
    upsert(thread) {
      editor.upsertThread(thread);
      renderNotes();
    },
    openFind,
    openLink,
    openComment: openComposer,
    openWordCount,
    openShortcuts,
    openImage,
    syncAt(query) {
      if (query == null) {
        atMenu.hidden = true;
        atItems = [];
        return;
      }
      atItems = atEntries(query);
      paintAt();
    },
    atKey(e) {
      if (atMenu.hidden || !atItems.length) return false;
      if (e.key === "ArrowDown") {
        atIndex = (atIndex + 1) % atItems.length;
        paintAt();
        return true;
      }
      if (e.key === "ArrowUp") {
        atIndex = (atIndex - 1 + atItems.length) % atItems.length;
        paintAt();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        atItems[atIndex]?.run();
        return true;
      }
      if (e.key === "Escape") {
        editor.closeAt();
        return true;
      }
      return false;
    },
    showDropdown,
    refresh() {
      const sig = editor.suggestionCards().map((card) => card.id + ":" + card.kind + ":" + card.quote).join("|");
      if (notes.dataset.sug !== sig) renderNotes();
      placeAdd();
      let floor = 0;
      for (const card of notes.querySelectorAll<HTMLElement>(".note[data-thread]")) {
        const span = editor.commentSpans(card.dataset.thread || "")[0];
        let top = span ? editor.anchorPoint(span.start).y : 72;
        if (top < floor) top = floor;
        card.style.top = top + "px";
        floor = top + card.offsetHeight + 8;
      }
      tableTools.hidden = !editor.inTable();
      paintPressed();
      if (!findBar.hidden) refreshFindCount();
    },
  };
}
