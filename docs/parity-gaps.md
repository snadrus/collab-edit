# Felarumi parity with Google Docs

Compared with the Docs help center: [keyboard shortcuts](https://support.google.com/docs/answer/179738), [outline, rulers, and non-printing characters](https://support.google.com/docs/answer/6367684), [spelling](https://support.google.com/docs/answer/57859), [headers, footers, page numbers, and footnotes](https://support.google.com/docs/answer/86629), and [tool finder](https://support.google.com/docs/answer/13466905). Menu names below match that surface. Ranks are by how often the missing behavior blocks ordinary writing and review.

## Shipped in this pass

1. **Page setup and the ruler.** File > Page setup sets Letter, A4, or Legal, portrait or landscape, and four margins. The horizontal ruler shows the margins and the paragraph indent; dragging a margin or the indent marker updates the document. View > Show ruler hides it. Page setup syncs to collaborators and survives reload.
2. **Document outline.** View > Show outline lists Title and Heading 1–3 (subtitles stay out, matching Docs) and jumps to the heading.
3. **Spelling.** Unknown words get a red wavy underline. Tools > Spelling, the right-click menu, and Tools > Personal dictionary suggest, ignore, or remember a word. The word list is the public-domain 12Dicts set.
4. **Autocorrect.** Tools > Preferences. A trailing space fixes a short list of typos (`teh`, `recieve`, and the like). `(c)`, `(r)`, `(tm)`, and `...` expand as you type.
5. **Right-click menu.** Cut, copy, paste, paste without formatting, comment, link, and clear formatting, plus spelling commands on a flagged word. Shift+F10 opens it.
6. **Paste without formatting.** Edit menu and Ctrl+Shift+V.
7. **View chrome.** Show non-printing characters (spaces, tabs, paragraph marks), full screen, and hide the menus.
8. **Help and menu search.** Help > Search the menus and Help > Keyboard shortcuts. Alt+/ opens the search. Extensions > Add-ons explains that add-ons are not available.
9. **Move a paragraph.** Ctrl+Shift+Up and Ctrl+Shift+Down swap the current paragraph with the neighbor. Dragging a selection drops it at the caret.

Already in place before this pass, and still the baseline: real-time editing, comments, version history, chips, find and replace, character and paragraph formatting, lists, links, images, tables, page breaks, horizontal lines, word count, paint format, and zoom.

## Still open, highest impact first

1. **Suggesting mode.** Editing, suggesting, and viewing are separate Docs modes (Ctrl+Alt+Shift+X). Suggestions are a second stream of edits, not a local highlight.
2. **Headers, footers, and page numbers.** Insert > Page elements, including a different first page. Requires a repeating region outside the main story. [Help](https://support.google.com/docs/answer/86629).
3. **Footnotes.** Insert footnote (Ctrl+Alt+F) and the footnote area at the bottom of the page, or at the end in pageless docs.
4. **Grammar.** Blue underlines and accept/ignore, beyond the spelling dictionary. [Help](https://support.google.com/docs/answer/57859).
5. **Pageless format.** View can leave pages entirely. Page setup here only changes paper and margins.
6. **Table of contents, bookmarks, and heading links.** Insert > Table of contents builds from the outline and stays linked.
7. **Columns, section breaks, and a vertical ruler.** Format > Columns and Insert > Break > Section break. The horizontal ruler is in; the vertical ruler is not.
8. **Images beyond insert.** Alt text, resize handles, and rotation from the shortcut card. Images are still a URL or an upload at a fixed size.
9. **Building blocks and the rest of smart chips.** Place, calendar event, file, and task chips, plus meeting notes and email drafts. Person, date, dropdown, and voting chips are in. File chips need a drive.
10. **Add-ons and Apps Script.** The Extensions menu is a stub. Running third-party add-ons is a platform, not an editor command.
11. **Voice typing, translate, citations, compare documents, and dictionary lookup.** Tools menu items that call out to other services.
12. **Watermarks, equations, drawings, charts, and special characters.** Insert-menu items with their own editors.
13. **Document tabs.** A 2024 Docs structure for several documents in one file.
14. **Capitalization commands and small caps.** Format > Text > Capitalization, and Ctrl+Shift+K for small caps.
15. **Paragraph spacing before and after, and custom line spacing.** The toolbar has 1.0, 1.15, 1.5, and 2.0 only.
16. **Headings 4–6.** The style menu stops at Heading 3. Docs shortcuts go through Heading 6.
17. **Share permissions, email, and move to trash.** Share copies the link. Docs share is an access-control dialog.
18. **Comment navigation keys.** J, K, R, and E while a comment is open. Threads can be replied to and resolved from the card.
19. **Regex find.** Find and replace is literal.
20. **Paginated print preview distinct from the browser print dialog.** File > Print uses the browser.
