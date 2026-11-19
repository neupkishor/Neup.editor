# Neup Cut

A lightweight browser video editor built with React, TypeScript, Vite, IndexedDB, Canvas, and the browser's native media APIs. Editing, preview, project persistence, and WebM recording are implemented in this repo; Remotion is not used by the editor.

## Run

```sh
npm install
npm run dev
```

Projects and imported media are saved locally in IndexedDB in the current browser. Export records the rendered canvas to WebM in real time, so export takes approximately as long as the video. Use a current Chromium based browser for the broadest MediaRecorder support.

## MCP server

The stdio MCP server lives in `bridge/mcp.v1/`. It edits portable `.neupcut.json` project files and can also run FFmpeg operations on local video files. Install FFmpeg and FFprobe and make both commands available on `PATH`. Set `NEUPCUT_MEDIA_DIR` to the folder containing source videos; outputs are written there as new files. Set `NEUPCUT_PROJECTS_DIR` to choose where project files are stored. Start the server with `npm run mcp` and add it to an MCP client:

```json
{
  "mcpServers": {
    "neup-cut": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Neup.editor", "run", "mcp"],
      "env": {
        "NEUPCUT_PROJECTS_DIR": "/absolute/path/to/project-files",
        "NEUPCUT_MEDIA_DIR": "/absolute/path/to/media"
      }
    }
  }
}
```

Project tools: `list_projects`, `get_project`, `add_clip`, `update_clip`, `delete_clip`, and `set_clip_look`. Project edits write a new `*.edited.neupcut.json` file; existing project files are never overwritten. Import the edited file in the editor to preview it.

Video tools: `list_media`, `inspect_video`, `trim_video`, `resize_video`, and `overlay_text`. They use FFprobe/FFmpeg directly and write outputs to new filenames, preserving source files. Media paths are confined to the configured media directory. Outputs support `.mp4`, `.mov`, `.mkv`, and `.webm` containers.

## Editor implementation checklist

- [x] Create, rename, open, and delete projects.
- [x] Import and export a portable project file with embedded media.
- [x] Autosave project edits and imported media in the browser.
- [x] Import video, audio, and image files; read media duration and keep media available after reload.
- [x] Place imported clips on the video or audio track and add more instances from the media bin.
- [x] Move clips horizontally, trim their start and end, change track, edit names, and split a video track clip at the playhead.
- [x] Drag a marquee across the timeline to select multiple clips and delete the selection together.
- [x] Seek, play, and pause with a canvas preview following the active video or image clip.
- [x] Play audio clips and capture the preview into a downloadable WebM file.
- [ ] Add undo and redo, keyboard shortcuts, clip transitions, multiple overlapping tracks, and a waveform display.
- [ ] Add cloud backed projects and live sync between browsers or collaborators; current autosave is local to one browser.
- [ ] Add a deterministic offline render pipeline for exports that must finish faster than real time or work in browsers without MediaRecorder.

## Current scope

The editor supports one video/image/title track and one audio track, with sequential and repositioned clips. It does not yet support overlapping compositing, effects, transitions, or remote collaboration. WebM export is recorded live from the canvas; audio support depends on the browser's media capture APIs.
