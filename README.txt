GM Stone travertine & marble site with stock admin
===================================================

site/index.html        the public catalogue (reads the live catalogue from /api/data.js; falls back
                       to the copy built into the page if the function is ever unavailable)
site/img/              the page's photos (HASH.jpg, named after the photo itself)
site/admin/index.html  the admin portal  ->  https://<the site>/admin/
netlify/functions/     one function, api.mjs: login, live data, history, photo upload and serving
tools/                 helper script (see the end of this file)
netlify.toml           tells Netlify what to publish

Try it first, without Netlify (needs Node.js):
  node test-server.mjs
  then open http://localhost:8080/admin/   password: test
  (everything saved goes into test-data/; nothing goes online)

Deploying (from the Codespace terminal, or any computer with Node.js):
  One time only:
    npm install
    npx netlify-cli login                        (log in with the Netlify account that owns the project)
    npx netlify-cli link                         (pick the Netlify project behind the stone site)
  Every time you want the live site updated:
    npm run deploy
  (gets the latest code from GitHub, then publishes it)
  The admin password is ADMIN_PASSWORD in Netlify: Project configuration > Environment variables.
  Changing the password: change ADMIN_PASSWORD there, then npm run deploy. Everyone is signed out.
  Going back to an earlier version: Netlify > Deploys > pick an older deploy > "Publish deploy".

IMPORTANT: do not drag-and-drop files onto Netlify.
That replaces the whole deploy without the function and the admin stops working.

First use, once, after the first deploy: open /admin/, sign in, press "Set up now".
That copies the catalogue built into the page into the live store. From then on every
change in the admin shows on the site straight away, with no redeploy.

The admin:
  Cargo      blocks and their bundles. "Move to stock…" moves arrived cargo into stock (see
             below). Bundles take net sizes (width x length x pcs); "Calculate" fills in m² and
             slab count from them.
  Stock      slabs held in the Dubai showroom or the Sharjah factory ("Held at" filter): m², slabs, slab size, finish, description, origin, position in
             the list, special price, hot flag, main photo and gallery. Delete when sold.
  To order   the "brought in to order" catalogue: always-available classics, new selections.
  Projects   the projects tab: name, location, type, stone, scope, Instagram reel, photos.
             Map pins on the site are matched to projects by position, so add new ones at the end.
  History    every save, newest first (the last 40 are kept). See below.
  Settings   enquiry email and WhatsApp number, JSON backup / restore, sign out.

Photos: stock items, to-order items and projects have one photo list. The first photo is the
main one (the card photo; for projects the cover); the rest show, in this order, when a visitor
opens the item. Under each photo: arrows to move it earlier or later, "Make main", and remove.
Add photos by pasting a Google Drive link or file ID (shared as "anyone with the link can view"),
or upload several at once. Uploads are resized to 1600 px in the browser and stored online in
Netlify Blobs (served from /api/img/...). Photos built into the page stay in site/img/.
Cargo bundles have one photo each.

Moving cargo into stock: when a container lands, press "Move to stock…" on its block.
Choose where it went (Dubai showroom or Sharjah factory), tick the bundles (untick some to
split a block between the two), and put them into a new stock item or add them to an existing
one at that place. m², slabs, slab sizes and photos are carried over; the bundle numbers go into
the description, so visitors can still search for them on the site. Moved bundles leave Cargo
(the whole block when all are moved). A new item with no photo is saved hidden from the site
until a photo is added. On the site the card shows "Dubai showroom" or "Sharjah factory", and
its "Where it is held" filter works with it. To move stock between the two later, change
"Where it is held" in the stock item.

Hide from site: "Hide from site" (in the item's edit panel; "Hide block" on a cargo block) takes
an item off the website but keeps it in the admin with all its details and photos, marked
"Hidden from site". "Put back on site" shows it again. Works for stock, cargo blocks, single
bundles, to-order items, and projects added after the ones with a map pin. The projects that
have a pin can't be hidden, because the pins open projects by their place in the list.
The "Hidden from site" button above a list shows just the hidden items. "Delete" still removes
an item for good.

History and undo: after every save a message shows with "Undo" for a few seconds. The History
page lists every save with what changed; "Undo last change" goes back one step, and "Compare &
put back" on any row first shows, in plain words, what putting that version back would change,
then does it. Putting a version back is saved like any other change, so it can be undone too.

Excel: "Download Excel" (Overview, Cargo, Stock, To order) downloads what is saved now:
  Stock           every stock item: material, category, finish, origin, where it is held, m², slabs, slab
                  size, average slab, special price, flags, position, status, photos, description
  Cargo bundles   every bundle: block, bundle, material, status (arriving / arrived / hidden),
                  slabs, m², net sizes, size on the card, photo, book-match, hot
  To order        the order catalogue with availability, selection, flags, status, photos
  Summary         the totals the website shows, per place (showroom / factory), hidden items
                  left out, and how many are hidden

Saving: every change is saved as one whole catalogue. If two people save at the same moment,
the second one is refused and the admin reloads, so nothing is overwritten silently.

Tools (for whoever maintains the files; needs Node.js):
  node tools/extract-images.mjs     if photos were pasted into site/index.html as data: URIs,
                                    moves them into site/img/ (keeps the page small and fast)
Changing the data built into site/index.html (the const DATA / STOCK / ORDER / PROJECTS lines)
only changes the fallback copy. The live catalogue is what the admin shows; use the admin.
