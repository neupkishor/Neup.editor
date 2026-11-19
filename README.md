# Neup Cut

A lightweight browser video editor built with React, TypeScript, Vite, IndexedDB, Canvas, and the browser's native media APIs. Editing, preview, project persistence, and WebM recording are implemented in this repo; Remotion is not used by the editor.

## Run

```sh
npm install
npm run dev
```

Projects and imported media are saved locally in IndexedDB in the current browser. Export records the rendered canvas to WebM in real time, so export takes approximately as long as the video. Use a current Chromium based browser for the broadest MediaRecorder support.

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
