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

## Adding files to the chat

Right-click a file or folder in the tree and choose **Add to Chat**. Each one appears in the message box as a chip, the same as typing **@** and picking it. With several items selected (⌘-click or Shift-click), the menu reads **Add 3 to Chat** and adds them all. Remove one before you send the same way you would remove an @ mention.

In split view, each pane's tree adds to that pane's chat. The item doesn't appear until a chat is open.

> A name with square brackets that the message can't hold, such as `a]b.ts`, isn't added. Frink tells you so; type its path instead.

## Files named in a reply

When the agent names a file in a reply, the file shows as a badge. Click the badge, or focus it and press **Enter**, to open the file in the editor at the line the reply gives.

A file opens when it is in this chat's folder or in one of your other projects:

- A short path like `src/app.ts` always points into this chat's folder.
- A full path, or one starting with `~/`, also opens from any other project you've added to Frink.

A file from another project shows that project's name on its badge. Its tooltip also says whether that project is linked to the chat. The file opens either way. While it's open, a note above the editor says whether the project is linked. If it isn't and the chat can link it, the note has a **Link project** button. When open files come from more than one project, the editor's tabs are grouped by project.

A badge that can't open still shows the file's path when you hover over it. In a worktree chat, a file in the project's main folder stays closed, because the chat works in its own worktree; the tooltip says so.

## Link another project

A chat works in one project, its main project, but you can link your other projects to it. A linked project shows in the chat's file tree, and most agents can read it without asking; see [Linked projects](./projects.md#linked-projects) for each provider.

1. Click **Link project** (the folder with a plus) beside the search field at the top of the file tree, or **Link project** (a plus) under the message box.
2. Type to search your projects by name or folder, then pick one with the mouse, or with the arrow keys and **Enter**.

The project you pick is linked and appears below the chat's main project. Each project in the tree has a row you can click to show or hide its files:

- The chat's main project is labelled **Main**. The chat's working folder, branch, worktree and `CLAUDE.md` come from it.
- A linked project is labelled **Linked** and shows the branch its folder has checked out. If its folder is gone, the tree says it can't find it.
- The **×** on a linked project's row unlinks it, as does the **×** on its chip under the message box. Its files stay where they are.

The footer counts the projects, for example **2 projects in this tree**. On the **Files** tab, the search field at the top filters the files of every project in the tree. On the **Search** tab, it looks inside the files of every project in the tree and lists the matches under each project's name, in the tree's order, each project with its own count. Click a match to open the file at that line. A linked project's files are read again when you show them and when you come back to Frink.

Linked projects are read-only in the tree: you can't create, rename, move, paste, drop or delete files there. You can still open a file and edit it in the editor.

Links are saved with the chat, so they stay after Frink restarts and every window shows the same ones. The file tree, **Search files**, the **Search** tab and the [**@** menu](./projects.md#linked-projects) in the message box all cover the chat's linked projects. The chat's folder, branch and worktree stay on its main project.

The picker lists your other projects, except the ones already linked and any project inside the chat's folder or holding it. If the messages in the sub-chat you have open name a project's folder by its full path, that project is marked **Mentioned in this chat** and listed first. When you search, it comes first among the projects that match equally well. Only messages Frink has loaded are checked, so older messages you haven't scrolled back to don't count. **Link project** shows only in a chat that works in a project folder: not in a general chat or a new chat that hasn't started yet.

## Find a file

Press **Cmd+Shift+P / Ctrl+Shift+P** (**Search files**) and type part of a file's name. Pick a result with the mouse, or with the arrow keys and **Enter**, to open it in the editor. Files you opened recently come first, then the chat's own project's files, then each linked project's.

Search files looks in every project in the chat's file tree. When the tree has more than one project, buttons at the top narrow the search to one project, or widen it again with **All in this tree**. A result from a linked project shows that project's name. Search files starts with **All in this tree** each time you open it.

In split view, Search files looks in the projects of the pane you're working in. It doesn't open for a pane with no project, such as a new chat that hasn't started yet.
