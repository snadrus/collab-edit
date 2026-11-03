# @-mentions (FiPen)

Type `@` and letters: the menu lists people from **FiPerson** (`fiperson/people` `suggest(query)` → `{ id, name, iconUrl, hint }`):
your club-mates from *Find all my Clubs* (cached by `/identity/`) plus document participants with a wallet (peers send
`addr` in `hello`; people already mentioned). FiPen only renders the results. With nobody cached, the first entry is
**Find my club-mates**, opening `/identity/#clubs`.

Choosing a person inserts a `person` embed `{ embed: "person", label, addr }`: a chip with a font-height avatar, the name,
and an extended grey zone to the right. It syncs and saves like any embed. Clicking the chip opens the person card
(`details(id)`: bio, clubs you share, notification contact) with **View profile** (`/person/?id=`) and **Notify**.

After inserting, a sidebar offers **Notify <name>?** with an editable message. Only **Notify** sends: it calls
`fiperson/notify` `notify(identity, message, docUrl)` (Slack DM as you; the first time it opens Connect Slack). If they
have no contact or are in another Slack workspace, it explains and **Copy link** copies the message and link.
Nothing is ever sent automatically. Tests: `p2p/e2e/mentions.spec.ts` (mock Slack via route).
