# Adding files to a project

The **file tree** on the left of a project chat is a live view of the project folder. Beyond clicking around it, you can pull files in from outside Frink — straight from Finder, your file manager, or another editor like VSCode or Cursor.

There are two ways to bring files in, and both copy the original (your source file is never moved or deleted).

## Drag and drop

Drag one or more files — or whole folders — from Finder (or VSCode/Cursor's file list) and drop them onto the tree. **Where you drop decides where they land:**

| Drop onto | Files land in |
|-----------|---------------|
| A **folder** | inside that folder |
| A **file** | inside that file's folder |
| Empty space / the tree background | the **project root** |

Folders come across with everything inside them.

> Dropped something and nothing happened? If Frink can't read the source path (some apps don't expose one), you'll see a nudge to drop from Finder or your file manager instead — those always work.

## Paste

Copy an item inside Frink's file tree, then press **⌘V / Ctrl+V** to paste a copy into the selected folder — or into the **project root** when nothing is selected. Same-name collisions are handled by the rename behavior described in the next section.

To bring files in from **another app** — Finder, VSCode, Cursor — use drag and drop (above).

## When a file with the same name already exists

Frink **never silently overwrites** your existing files. If the name collides with something already in the destination folder, the incoming copy is renamed alongside the original:

```
report.pdf        ← your existing file, untouched
report (1).pdf    ← the one you just added
```

The confirmation toast tells you when this happened — for example **"Added 3 item(s) (1 renamed to avoid overwriting)"** — so you always know a rename occurred rather than a replace.

> Re-adding an updated version of a file? Because nothing is overwritten, you'll get a `(1)` copy next to the old one rather than an in-place update. Delete whichever you don't want — your original is always the one without the number.

## Linked files and folders

A **symbolic link** (a file or folder that points at another one, such as `CLAUDE.md` pointing at `AGENTS.md`) shows in the tree like the thing it points at. Open a linked folder to browse the real folder's contents. A link whose target is missing is hidden.

- **Editing inside a linked folder changes the real folder.** If the link points outside the project, new, renamed and deleted files land there too.
- **Copying, duplicating or moving a link keeps it a link.** The files it points at are not copied. A link that points at a full path keeps pointing at the same place. A link that points at a nearby file by a short path (such as `CLAUDE.md` pointing at `AGENTS.md`) looks for that file next to its new location, so moved to another folder it can point at a different file or stop working. On Windows without Developer Mode, a linked file is copied as a normal file instead.
- **No change markers inside linked folders.** Git sees the link itself, not the files behind it, so those files never show as changed or ignored. Edits made outside Frink inside a folder linked from outside the project show up after you close and reopen the folder.
