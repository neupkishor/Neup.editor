# Neup Cut

A lightweight browser video editor built with React, TypeScript, Vite, PostgreSQL, Canvas, and the browser's native media APIs. Editing, preview, project persistence, and WebM recording are implemented in this repo; Remotion is not used by the editor.

## Run

```sh
npm install
npm run dev
```

This starts the editor and its Streamable HTTP MCP endpoint in one Node process and on one port. `npm start` does the same. Open the editor URL printed in the terminal; MCP clients can connect to the same origin at `/bridge/mcp.v1`. Set `HOST` and `PORT` (or `NEUPCUT_HTTP_HOST` and `NEUPCUT_HTTP_PORT`) to change the listener address and port, or `NEUPCUT_HTTP_PATH` to change the MCP path. Projects and their timeline data are saved in PostgreSQL; uploaded media is saved on the server and its locations are recorded in each project. Export records the rendered canvas to WebM in real time, so export takes approximately as long as the video. Use a current Chromium based browser for the broadest MediaRecorder support.

The editor lives at `/editor`. Opening `/editor` creates a new project; `/editor?project=<id>` opens the saved project with that ID. The editor updates the URL with the active project ID so reloading restores it.

Set `DATABASE_URL` to a PostgreSQL connection string before starting the app. The Prisma schema is in `prisma/schema.prisma`; `database.live` is its readable schema snapshot. Project media is stored under `media/projects` by default; set `NEUPCUT_PROJECT_MEDIA_DIR` to change that directory.

Project persistence and media operations live in `services/projects.mjs`. The HTTP project API and MCP project tools both use this service; browser editor requests reach it through the HTTP API.

## MCP server

The MCP server lives in `bridge/mcp.v1/`. It supports stdio and Streamable HTTP. Project tools use the same PostgreSQL-backed services as the editor API, while FFmpeg tools operate on local video files. Install FFmpeg and FFprobe and make both commands available on `PATH`. Set `NEUPCUT_MEDIA_DIR` to the folder containing source videos; outputs are written there as new files. For stdio MCP clients, run `npm run mcp` and add it to an MCP client:

```json
{
  "mcpServers": {
    "neup-cut": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Neup.editor", "run", "mcp"],
      "env": {
        "NEUPCUT_MEDIA_DIR": "/absolute/path/to/media"
      }
    }
  }
}
```

Project tools: `list_projects`, `get_project`, `add_clip`, `update_clip`, `delete_clip`, and `set_clip_look`. Use the `projectId` UUID returned by `list_projects`; clip edits are saved in place to the same project row used by the editor.

Video tools: `list_media`, `inspect_video`, `trim_video`, `resize_video`, and `overlay_text`. They use FFprobe/FFmpeg directly and write outputs to new filenames, preserving source files. Media paths are confined to the configured media directory. Outputs support `.mp4`, `.mov`, `.mkv`, and `.webm` containers.

## Editor implementation checklist

- [x] Create, rename, open, and delete projects.
- [x] Import and export a portable project file with embedded media.
- [x] Autosave project edits and media to PostgreSQL and server storage.
- [x] Import video, audio, and image files; read media duration and keep media available after reload.
- [x] Place imported clips on the video or audio track and add more instances from the media bin.
- [x] Move clips horizontally, trim their start and end, change track, edit names, and split a video track clip at the playhead.
- [x] Drag a marquee across the timeline to select multiple clips and delete the selection together.
- [x] Seek, play, and pause with a canvas preview following the active video or image clip.
- [x] Play audio clips and capture the preview into a downloadable WebM file.
- [ ] Add undo and redo, keyboard shortcuts, clip transitions, multiple overlapping tracks, and a waveform display.
- [ ] Add account-scoped project access and live collaboration between users.
- [ ] Add a deterministic offline render pipeline for exports that must finish faster than real time or work in browsers without MediaRecorder.

## Current scope

The editor supports one video/image/title track and one audio track, with sequential and repositioned clips. It does not yet support overlapping compositing, effects, transitions, or remote collaboration. WebM export is recorded live from the canvas; audio support depends on the browser's media capture APIs.
