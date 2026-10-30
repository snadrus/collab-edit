# Felarumi parity with Google Docs

Compared with the Docs help center: [keyboard shortcuts](https://support.google.com/docs/answer/179738), [outline, rulers, and non-printing characters](https://support.google.com/docs/answer/6367684), [spelling](https://support.google.com/docs/answer/57859), [headers, footers, page numbers, and footnotes](https://support.google.com/docs/answer/86629), and [tool finder](https://support.google.com/docs/answer/13466905). Menu names below match that surface. Ranks are by how often the missing behavior blocks ordinary writing and review.

## Shipped earlier

Page setup and the horizontal ruler, the heading outline, spelling, autocorrect, the right-click menu, paste without formatting, non-printing characters, full screen, hide the menus, menu search, the Extensions stub, paragraph move and drag-and-drop, suggesting mode, headers and footers, footnotes, pageless format, table of contents, spacing, headings 4–6, comment keys, and image resize with alt text.

## Shipped in this pass

1. **Columns and section breaks.** Format > Columns sets one, two, or three columns on the current section. Insert > Break adds a page break or a section break (next page or continuous). Column count is a paragraph attribute, so it travels through OT. Table column counts are left alone. Short sections are balanced by estimated height; longer ones fill down the page.
2. **Vertical ruler.** Shown with the horizontal ruler. Drag the top or bottom marker to change the margins. The markers use the same blue margin band as the horizontal ruler.
3. **Image rotation.** A round handle above a selected image rotates it, snapping to 15 degrees. The right-click menu rotates 90 degrees. The angle is an attribute on the image.
4. **Document tabs.** A tab bar under the page lists the tabs in the file. Add a tab, double-click to rename, and click to switch. Extra tabs are documents under the same file and stay out of the home list.
5. **Capitalization and small caps.** Format > Text has lowercase, UPPERCASE, and Title Case. Small caps is Ctrl+Shift+K. Case changes are ordinary undoable edits. Small caps is a character attribute.
6. **Special characters.** Insert > Special characters opens a searchable grid.
7. **Equations.** Insert > Equation takes a short formula: `^` and `_`, `\frac{a}{b}`, `\sqrt{x}`, and names such as `\pi`. The formula is stored on an embed, so edits converge. Double-click to edit it.
8. **Regex find.** The find bar has a Regex checkbox. Replacement supports groups such as `$1`. A bad pattern shows Invalid.
9. **Paginated print preview.** File > Print opens a preview of the pages, with Print sending them to the browser.
10. **Share roles and trash.** Share sets general access to editor, commenter, or viewer, and copies a document link plus an editor, commenter, or viewer link. Viewers are read-only. Commenters can suggest. Editors can accept suggestions. File > Move to trash, with Restore and Delete forever on the home screen.
11. **Chrome polish.** Hover is `#f1f3f4`, pressed is `#e8eaed`, the share button is `#0b57d0`, menu rows are 32px, and the page shadow is lighter.

## Still open, highest impact first

1. **Grammar.** Blue underlines and accept/ignore, beyond the spelling dictionary. [Help](https://support.google.com/docs/answer/57859).
2. **Building blocks and the rest of smart chips.** Place, calendar event, file, and task chips, plus meeting notes and email drafts. Person, date, dropdown, and voting chips are in. File chips need a drive.
3. **Add-ons and Apps Script.** The Extensions menu is a stub. Running third-party add-ons is a platform, not an editor command.
4. **Voice typing, translate, citations, compare documents, and dictionary lookup.** Tools menu items that call out to other services.
5. **Watermarks, drawings, and charts.** Insert-menu items with their own editors. Equations and special characters are in.
6. **Email from the share dialog.** The role links are in. Docs can also email collaborators.
