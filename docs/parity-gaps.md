# Felarumi parity with Google Docs

Compared with the Docs help center: [keyboard shortcuts](https://support.google.com/docs/answer/179738), [outline, rulers, and non-printing characters](https://support.google.com/docs/answer/6367684), [spelling](https://support.google.com/docs/answer/57859), [headers, footers, page numbers, and footnotes](https://support.google.com/docs/answer/86629), and [tool finder](https://support.google.com/docs/answer/13466905). Menu names below match that surface. Ranks are by how often the missing behavior blocks ordinary writing and review.

## Shipped earlier

Page setup and the ruler, the heading outline, spelling, autocorrect, the right-click menu, paste without formatting, non-printing characters, full screen, hide the menus, menu search, the Extensions stub, and paragraph move plus drag-and-drop.

## Shipped in this pass

1. **Suggesting mode.** The toolbar mode control switches Editing, Suggesting, and Viewing (Ctrl+Alt+Shift+X). Insertions and deletions stay in the document as `sug` and `del` marks, drawn in the author's color. Accept and Reject sit on cards in the comment sidebar. The marks travel through the same OT path as other character attributes, and accepting or rejecting is an ordinary undoable delta.
2. **Headers, footers, and page numbers.** Insert > Header, Footer, and Page number. `{page}` and `{pages}` fill in on each page. A different first page is optional. The text is part of page setup, so it syncs with the page and survives reload.
3. **Footnotes.** Insert > Footnote (Ctrl+Alt+F) places a superscript marker. The note is drawn at the bottom of that page, or after the story in pageless documents. The note body is an attribute on the marker, so edits converge.
4. **Pageless format.** View > Pageless drops page breaks and draws one continuous sheet. It is stored with page setup.
5. **Table of contents, bookmarks, and heading links.** Insert > Bookmark, Table of contents, Update table of contents, and Link to heading. Contents are paragraphs linked to heading bookmarks and can be rebuilt.
6. **Paragraph spacing and custom line spacing.** Format > Line and paragraph spacing, and Custom on the spacing menu. Line spacing is a multiple from 0.5 to 3. Space before and after are in points.
7. **Headings 4–6.** The style menu, Format menu, outline, and Ctrl+Alt+4/5/6.
8. **Comment navigation.** With a comment card focused, J and K move between cards, R replies, and E resolves.
9. **Image resize and alt text.** A selected image shows corner handles. Double-click or the right-click menu edits the description. Size and alt text are attributes on the image.

## Still open, highest impact first

1. **Grammar.** Blue underlines and accept/ignore, beyond the spelling dictionary. [Help](https://support.google.com/docs/answer/57859).
2. **Columns, section breaks, and a vertical ruler.** Format > Columns and Insert > Break > Section break. The horizontal ruler is in; the vertical ruler is not.
3. **Image rotation.** Resize and alt text are in. Rotation is not.
4. **Building blocks and the rest of smart chips.** Place, calendar event, file, and task chips, plus meeting notes and email drafts. Person, date, dropdown, and voting chips are in. File chips need a drive.
5. **Add-ons and Apps Script.** The Extensions menu is a stub. Running third-party add-ons is a platform, not an editor command.
6. **Voice typing, translate, citations, compare documents, and dictionary lookup.** Tools menu items that call out to other services.
7. **Watermarks, equations, drawings, charts, and special characters.** Insert-menu items with their own editors.
8. **Document tabs.** A 2024 Docs structure for several documents in one file.
9. **Capitalization commands and small caps.** Format > Text > Capitalization, and Ctrl+Shift+K for small caps.
10. **Share permissions, email, and move to trash.** Share copies the link. Docs share is an access-control dialog.
11. **Regex find.** Find and replace is literal.
12. **Paginated print preview distinct from the browser print dialog.** File > Print uses the browser.
